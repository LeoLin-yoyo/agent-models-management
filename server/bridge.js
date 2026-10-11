// 桥接管理：本地 TCP→HTTP/3 桥接进程的配置、路由与生命周期
// 桥接本体是 bridge/quic_bridge.py（Node 生态无 HTTP/3 客户端，用 Python+aioquic 实现），
// 由本模块作为子进程拉起（windowsHide，静默）；配置存 data/bridge.json，改动即时生效。
// 「桥接模型」层的路由供给（哪个路由对应哪个桥接模型）在 server/bridgeProviders.js 中管理。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./paths');

const CONFIG_FILE = path.join(DATA_DIR, 'bridge.json');
const LOG_FILE = path.join(DATA_DIR, 'bridge.log');
const SCRIPT = path.join(__dirname, '..', 'bridge', 'quic_bridge.py');
const DEFAULT_PORT = 8787;

const PYTHON_CANDIDATES = [
  process.env.AMMP_PYTHON,
  'D:\\Program Files\\Python312\\python.exe',
  'python',
].filter(Boolean);

let child = null;
let stopping = false;
let restarts = 0;
let startedAt = null;

// 优先使用 pythonw.exe：它没有控制台子系统，从根上避免弹出命令行窗口
// （windowsHide 对控制台程序并不总是可靠；python.exe 被别处手动拉起时更会直接弹窗）
function preferPythonw(p) {
  try {
    if (typeof p === 'string' && /python\.exe$/i.test(p)) {
      const w = p.replace(/python\.exe$/i, 'pythonw.exe');
      if (fs.existsSync(w)) return w;
    }
  } catch {}
  return p;
}

function detectPython() {
  for (const c of PYTHON_CANDIDATES) {
    try {
      if (c === 'python' || fs.existsSync(c)) return preferPythonw(c);
    } catch {}
  }
  return 'python';
}

function defaultConfig() {
  return { enabled: true, port: DEFAULT_PORT, python: detectPython(), routes: {} };
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const merged = { ...defaultConfig(), ...raw, routes: raw.routes || {} };
    // 老配置里存的是 python.exe：存在 pythonw 时自动升级，避免弹窗
    merged.python = preferPythonw(merged.python);
    return merged;
  } catch {
    return defaultConfig();
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// 探活：桥接进程是否在监听并响应状态端点
async function isUp(timeoutMs = 1000) {
  const cfg = readConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/__bridge/status`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function getStatus() {
  const cfg = readConfig();
  return {
    running: !!(child && child.exitCode === null),
    pid: child && child.exitCode === null ? child.pid : null,
    uptimeSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    enabled: cfg.enabled,
    port: cfg.port,
    python: cfg.python,
    // 路由里的鉴权字段只回传「有没有」，绝不把 key 下发给前端
    routes: Object.entries(cfg.routes).map(([id, r]) => ({
      id,
      ...r,
      apiKey: undefined,
      apiKeyEnv: undefined,
      hasKey: !!(r.apiKey || r.apiKeyEnv),
    })),
    configFile: CONFIG_FILE,
    logFile: LOG_FILE,
    script: SCRIPT,
  };
}

function start() {
  const cfg = readConfig();
  if (child && child.exitCode === null) return { started: false, reason: 'already-running', pid: child.pid };
  stopping = false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  out.write(`\n=== bridge start ${new Date().toISOString()} ===\n`);
  child = spawn(cfg.python, [SCRIPT, '--config', CONFIG_FILE], {
    windowsHide: true,               // 不给子进程弹控制台窗口
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedAt = Date.now();
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on('error', (e) => {
    out.write(`=== bridge spawn error: ${e.message} ===\n`);
  });
  child.on('exit', (code, signal) => {
    out.write(`=== bridge exited code=${code} signal=${signal} ===\n`);
    const uptime = startedAt ? Date.now() - startedAt : 0;
    child = null;
    startedAt = null;
    if (stopping) return;
    if (uptime > 30000) restarts = 0;       // 稳定运行过就重置重试计数
    if (restarts < 5) {
      restarts += 1;
      setTimeout(() => {
        if (!stopping && !(child && child.exitCode === null)) start();
      }, 3000);
    }
  });
  return { started: true, pid: child.pid, python: cfg.python };
}

function stop() {
  stopping = true;
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      child = null;
      resolve({ stopped: false, reason: 'not-running' });
      return;
    }
    const c = child;
    const timer = setTimeout(() => {
      // 兜底强杀整棵子树
      try { spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      resolve({ stopped: true, pid: c.pid, forced: true });
    }, 2500);
    c.once('exit', () => {
      clearTimeout(timer);
      resolve({ stopped: true, pid: c.pid });
    });
    try { c.kill(); } catch {}
  });
}

// 服务启动时调用：按需拉起桥接（已在运行则不动）
async function ensureRunning() {
  const cfg = readConfig();
  if (!cfg.enabled) return { started: false, reason: 'disabled' };
  if (await isUp()) return { started: false, reason: 'already-up' };
  return start();
}

// ---------- 路由管理（data/bridge.json 的 routes 段）----------

function setRoute(routeId, info) {
  const cfg = readConfig();
  const prev = cfg.routes[routeId] || {};
  cfg.routes[routeId] = { addedAt: prev.addedAt || new Date().toISOString(), ...info };
  writeConfig(cfg);
  return cfg.routes[routeId];
}

function getRoute(routeId) {
  return readConfig().routes[routeId] || null;
}

function removeRoute(routeId) {
  const cfg = readConfig();
  if (!cfg.routes[routeId]) return false;
  delete cfg.routes[routeId];
  writeConfig(cfg);
  return true;
}

// 识别「指向本桥接的 BaseURL」：http://127.0.0.1:<port>/<routeId>/...
function parseBridgeUrl(u, port) {
  try {
    const url = new URL(String(u));
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    const cfgPort = port || readConfig().port;
    if (Number(url.port) !== Number(cfgPort)) return null;
    const segs = url.pathname.split('/').filter(Boolean);
    if (!segs.length) return null;
    const restPath = url.pathname.slice(1 + segs[0].length); // '' 或 '/v1' 等
    return { routeId: segs[0], restPath: restPath === '/' ? '' : restPath, url };
  } catch {
    return null;
  }
}

// 把原始上游 BaseURL 改写成到桥接的 BaseURL（保留其路径，如 /v1）
function bridgeBaseUrl(routeId, originalBaseUrl, port) {
  const cfgPort = port || readConfig().port;
  let p = '';
  try {
    const u = new URL(String(originalBaseUrl));
    p = u.pathname.replace(/\/+$/, '');
    if (p === '/') p = '';
  } catch {}
  return `http://127.0.0.1:${cfgPort}/${routeId}${p}`;
}

// provider 的桥接状态（供 overview 标注 / 前端徽标）
// bridgeProviderId：该路由由哪个「桥接模型」供给（bridgeProviders.js 管理）；legacy=true 表示
// 指向桥接但没有对应路由（历史残留，可在桥接管理里重新配置后覆盖）
function providerBridgeInfo(tool, providerId, baseUrl) {
  const cfg = readConfig();
  const parsed = parseBridgeUrl(baseUrl, cfg.port);
  if (parsed) {
    const r = cfg.routes[parsed.routeId];
    return {
      bridged: true,
      routeId: parsed.routeId,
      upstream: r ? r.upstream : null,
      originalBaseUrl: r ? r.originalBaseUrl || null : null,  // 原上游地址（含 /v1 路径）
      bridgeProviderId: r ? r.bridgeProviderId || null : null,
      legacy: !r,                    // 指向桥接但没有对应路由（历史残留）
      port: cfg.port,
    };
  }
  return { bridged: false, port: cfg.port };
}

// 判断某个路由是否仍被任一工具配置引用（删除路由前判断是否需要保留）
function routeReferencedElsewhere(routeId, exceptTool, exceptProviderId, stores) {
  for (const [tool, store] of Object.entries(stores)) {
    let data;
    try {
      data = store.read();
    } catch {
      continue;
    }
    for (const p of data.providers) {
      if (tool === exceptTool && p.id === exceptProviderId) continue;
      const parsed = parseBridgeUrl(p.baseUrl);
      if (parsed && parsed.routeId === routeId) return `${tool}/${p.id}`;
    }
  }
  return null;
}

module.exports = {
  DEFAULT_PORT,
  CONFIG_FILE,
  LOG_FILE,
  readConfig,
  writeConfig,
  isUp,
  getStatus,
  start,
  stop,
  ensureRunning,
  setRoute,
  getRoute,
  removeRoute,
  parseBridgeUrl,
  bridgeBaseUrl,
  providerBridgeInfo,
  routeReferencedElsewhere,
};


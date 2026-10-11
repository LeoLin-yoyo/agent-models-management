// 桥接模型注册表（「桥接管理」模块的后端核心）—— 与 agent 配置完全解耦的独立层。
//
// 工作流：被墙的 API 先在这里配置成「桥接模型」（上游地址 / Key / 接口类型 / 模型清单），
// 再按需「同步」到 opencode / pi —— 同步即在目标工具配置里创建或更新一个 BaseURL 指向
// 本地 QUIC 桥接的 provider 副本；桥接模型的后续变更（增删模型、改地址/Key）会自动重新同步。
//
// 数据文件 data/bridge-providers.json：
// {
//   migratedV2: true,                       // 旧版「provider 卡片一键改写」数据是否已迁移
//   providers: [{
//     id, name, upstream, apiKey, style,    // upstream 为原始（被墙的）完整 BaseURL，如 https://x/v1
//     apiKey 支持 'env:变量名' 引用或明文
//     models: [{ id, name }],
//     routeId,                              // 桥接路由 id（通常 = id；旧数据迁移时保留原路由 id）
//     agentIds: { opencode?: '副本 provider id', pi?: '...' },  // 各工具里副本的 provider id，缺省 = id
//     createdAt, updatedAt, migrated?
//   }]
// }
// 路由本体（data/bridge.json 的 routes 段）由本模块按桥接模型供给，quic_bridge.py 每请求实时读取。
const fs = require('fs');
const path = require('path');
const bridge = require('./bridge');
const opencodeStore = require('./opencodeStore');
const piStore = require('./piStore');
const { DATA_DIR, CONFIG_PATHS } = require('./paths');
const { parseJsonc } = require('./jsonc');
const { maskKey } = require('./mask');

const STORES = { opencode: opencodeStore, pi: piStore };
const TOOLS = ['opencode', 'pi'];
const FILE = path.join(DATA_DIR, 'bridge-providers.json');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const nowIso = () => new Date().toISOString();

// ---------- 存取 ----------

function readFile() {
  try {
    const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { migratedV2: !!doc.migratedV2, providers: Array.isArray(doc.providers) ? doc.providers : [] };
  } catch {
    return { migratedV2: false, providers: [] };
  }
}

function writeFile(doc) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function list() {
  return readFile().providers;
}

function get(id) {
  return readFile().providers.find((x) => x.id === id) || null;
}

function getOrThrow(id) {
  const bp = get(id);
  if (!bp) throw new Error(`不存在桥接模型: ${id}`);
  return bp;
}

function findByRoute(routeId) {
  return readFile().providers.find((x) => x.routeId === routeId) || null;
}

function mustGet(doc, id) {
  const bp = doc.providers.find((x) => x.id === id);
  if (!bp) throw new Error(`不存在桥接模型: ${id}`);
  return bp;
}

// ---------- 地址 / key 工具 ----------

function parseUpstream(v) {
  const s = String(v || '').trim();
  if (!s) throw new Error('上游地址（BaseURL）必填');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`上游地址不是合法 URL：${s}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`上游地址仅支持 http/https：${s}`);
  }
  return { url: s, origin: u.origin };
}

// key 输入规范化：'env:NAME' 引用（写入时校验变量名）或明文；空 → null
function normalizeKeyInput(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (s.startsWith('env:')) {
    const name = s.slice(4).trim();
    if (!ENV_NAME_RE.test(name)) throw new Error(`环境变量名不合法：${name}`);
    return 'env:' + name;
  }
  return s;
}

// 桥接模型里的 key → 某个 agent 工具配置里应写入的形式
// env-ref：pi 写 $NAME、opencode 写 {env:NAME}；明文原样；无 key 返回 null
function keyForTool(tool, apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith('env:')) {
    const name = apiKey.slice(4).trim();
    return tool === 'pi' ? `$${name}` : `{env:${name}}`;
  }
  return apiKey;
}

// 本进程解析出实际 key 值（测试 / 拉取远端列表用）：env:NAME → 环境变量（剥 BOM）
function resolveKey(bp) {
  if (!bp.apiKey) return null;
  if (bp.apiKey.startsWith('env:')) {
    let v = process.env[bp.apiKey.slice(4).trim()];
    if (typeof v === 'string' && v.charCodeAt(0) === 0xfeff) v = v.slice(1);
    return v || null;
  }
  return bp.apiKey;
}

// 写入 agent 配置的桥接地址：http://127.0.0.1:<port>/<routeId><上游路径>
function bridgedUrl(bp, port) {
  return bridge.bridgeBaseUrl(bp.routeId, bp.upstream, port);
}

function copyIdFor(bp, tool) {
  return (bp.agentIds && bp.agentIds[tool]) || bp.id;
}

// ---------- 路由供给 ----------

// 桥接模型 → 路由的鉴权字段：让 quic_bridge.py 在「客户端没带鉴权」时自动注入，
// 这样任何客户端（agent、zcode、curl）指向本地桥接地址都无需再配一次 key。
// env: 引用写成 apiKeyEnv（桥接进程运行时从环境变量取值，避免明文落盘），明文直接写 apiKey。
function authFieldsOf(bp) {
  const style = bp.style === 'anthropic-messages' ? 'x-api-key' : 'bearer';
  if (!bp.apiKey) return { apiKey: null, apiKeyEnv: null, authStyle: style };
  if (bp.apiKey.startsWith('env:')) {
    return { apiKey: null, apiKeyEnv: bp.apiKey.slice(4).trim(), authStyle: style };
  }
  return { apiKey: bp.apiKey, apiKeyEnv: null, authStyle: style };
}

// 为桥接模型供给/更新桥接路由（routes 段由 quic_bridge.py 每请求实时读取，无需重启）
function ensureRoute(bp) {
  const { origin } = parseUpstream(bp.upstream);
  const cur = bridge.getRoute(bp.routeId) || null;
  const auth = authFieldsOf(bp);
  const same =
    cur &&
    cur.upstream === origin &&
    cur.originalBaseUrl === bp.upstream &&
    cur.bridgeProviderId === bp.id &&
    (cur.apiKey || null) === auth.apiKey &&
    (cur.apiKeyEnv || null) === auth.apiKeyEnv &&
    (cur.authStyle || 'bearer') === auth.authStyle;
  if (same) return cur;
  return bridge.setRoute(bp.routeId, {
    ...(cur || {}),
    upstream: origin,                 // 旧语义：upstream 只存 origin，路径随 <routeId>/<path> 传给桥接
    originalBaseUrl: bp.upstream,
    bridgeProviderId: bp.id,
    ...auth,                          // apiKey / apiKeyEnv / authStyle：供桥接自动注入
  });
}

// 为新建桥接模型挑 routeId：优先用 id；被历史路由占用且上游不同则换 <id>-2、-3…
function pickFreeRouteId(id, upstream) {
  const cfg = bridge.readConfig();
  const cur = cfg.routes[id];
  if (!cur) return id;
  if (cur.originalBaseUrl === upstream || cur.upstream === parseUpstream(upstream).origin) return id;
  let i = 2;
  while (cfg.routes[`${id}-${i}`]) i += 1;
  return `${id}-${i}`;
}

// ---------- 副本状态 / 默认模型维护 ----------

// 桥接模型在某个工具里的副本状态：
//   none     没有副本
//   synced   副本存在，且 BaseURL 指向本桥接模型的路由
//   conflict 同 id 的 provider 存在，但不是指向本路由的桥接副本
function copyStatus(bp, tool) {
  const copyId = copyIdFor(bp, tool);
  let data;
  try {
    data = STORES[tool].read();
  } catch (e) {
    return { status: 'error', copyId, error: e.message };
  }
  const prov = data.providers.find((p) => p.id === copyId);
  if (!prov) return { status: 'none', copyId };
  const parsed = bridge.parseBridgeUrl(prov.baseUrl);
  if (parsed && parsed.routeId === bp.routeId) {
    return { status: 'synced', copyId, modelCount: prov.models.length, baseUrl: prov.baseUrl };
  }
  return { status: 'conflict', copyId, baseUrl: prov.baseUrl };
}

// 同步后：若工具的默认模型指向本次同步里被移除的模型，清除默认设置
async function clearDefaultIfMissingModel(tool, providerId, models) {
  const store = STORES[tool];
  const def = store.read().defaultModel;
  if (!def || def.provider !== providerId) return false;
  if (models.some((m) => m.id === def.model)) return false;
  await store.clearDefaultModel();
  return true;
}

async function clearDefaultIfProviderGone(tool, providerId) {
  const store = STORES[tool];
  const def = store.read().defaultModel;
  if (!def || def.provider !== providerId) return false;
  await store.clearDefaultModel();
  return true;
}

// ---------- 同步引擎 ----------

// 把桥接模型写入某个工具的配置（创建/整体覆盖副本，模型列表/地址/Key/接口类型以桥接模型为准）
async function applySync(bp, tool) {
  if (!TOOLS.includes(tool)) throw new Error(`未知工具: ${tool}（仅支持 ${TOOLS.join(' / ')}）`);
  ensureRoute(bp);
  const copyId = copyIdFor(bp, tool);
  const entry = {
    id: copyId,
    name: bp.name,
    baseUrl: bridgedUrl(bp),
    style: bp.style,
    apiKey: keyForTool(tool, bp.apiKey),
    models: bp.models.map((m) => ({ id: m.id, name: m.name })),
  };
  const { existed } = await STORES[tool].upsertProvider(entry);
  if (!bp.agentIds) bp.agentIds = {};
  bp.agentIds[tool] = copyId;
  const defaultCleared = await clearDefaultIfMissingModel(tool, copyId, bp.models);
  return {
    ok: true,
    action: existed ? 'overwrite' : 'create',
    copyId,
    modelCount: bp.models.length,
    baseUrl: entry.baseUrl,
    defaultCleared,
  };
}

// 从某个工具删除副本（只删指向本桥接模型路由的副本，避免误删同名手工配置）
async function removeSync(bp, tool) {
  if (!TOOLS.includes(tool)) throw new Error(`未知工具: ${tool}（仅支持 ${TOOLS.join(' / ')}）`);
  const copyId = copyIdFor(bp, tool);
  const prov = STORES[tool].read().providers.find((p) => p.id === copyId);
  if (!prov) {
    if (bp.agentIds) delete bp.agentIds[tool];
    return { ok: true, removed: false, copyId, reason: 'no-copy' };
  }
  const parsed = bridge.parseBridgeUrl(prov.baseUrl);
  if (!parsed || parsed.routeId !== bp.routeId) {
    throw new Error(`工具 ${tool} 里的「${copyId}」不是本桥接模型的副本（BaseURL：${prov.baseUrl}），未删除`);
  }
  await STORES[tool].deleteProvider(copyId);
  const defaultCleared = await clearDefaultIfProviderGone(tool, copyId);
  if (bp.agentIds) delete bp.agentIds[tool];
  return { ok: true, removed: true, copyId, defaultCleared };
}

// 桥接模型发生变更后：对仍处于「已同步」状态的工具自动重新同步（覆盖分发）
async function reSyncTools(bp) {
  const results = [];
  for (const tool of TOOLS) {
    if (copyStatus(bp, tool).status !== 'synced') continue;
    try {
      results.push({ tool, ...(await applySync(bp, tool)) });
    } catch (e) {
      results.push({ tool, ok: false, error: e.message });
    }
  }
  return results;
}

// ---------- CRUD ----------

function create(input) {
  const { id, name, upstream, apiKey, style } = input || {};
  const doc = readFile();
  const bid = String(id || '').trim();
  if (!ID_RE.test(bid)) {
    throw new Error('ID 不合法：只允许字母/数字/点/下划线/连字符，字母或数字开头，最长 64 字符');
  }
  if (doc.providers.some((x) => x.id === bid)) throw new Error(`桥接模型 ${bid} 已存在`);
  const up = parseUpstream(upstream);
  const bp = {
    id: bid,
    name: String(name || '').trim() || bid,
    upstream: up.url,
    apiKey: normalizeKeyInput(apiKey),
    style: style === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    models: [],
    routeId: pickFreeRouteId(bid, up.url),
    agentIds: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  doc.providers.push(bp);
  writeFile(doc);
  ensureRoute(bp);
  return bp;
}

// patch: { name?, upstream?, apiKey?（留空/缺省=不修改）, style? }；id 创建后不可改
async function update(id, patch) {
  const doc = readFile();
  const bp = mustGet(doc, id);
  const p = patch || {};
  if (p.name !== undefined) bp.name = String(p.name).trim() || bp.name;
  if (p.upstream !== undefined && String(p.upstream).trim() !== '') bp.upstream = parseUpstream(p.upstream).url;
  if (p.apiKey !== undefined && String(p.apiKey).trim() !== '') bp.apiKey = normalizeKeyInput(p.apiKey);
  if (p.style !== undefined) bp.style = p.style === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
  bp.updatedAt = nowIso();
  ensureRoute(bp);
  const reSync = await reSyncTools(bp);
  writeFile(doc);
  return { provider: describe(bp), reSync };
}

// 删除桥接模型：先撤销各工具里的副本，再删记录与路由（路由仍被其它配置引用时保留）
async function remove(id) {
  const doc = readFile();
  const idx = doc.providers.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`不存在桥接模型: ${id}`);
  const bp = doc.providers[idx];
  const results = [];
  for (const tool of TOOLS) {
    try {
      results.push({ tool, ...(await removeSync(bp, tool)) });
    } catch (e) {
      results.push({ tool, ok: false, error: e.message });
    }
  }
  doc.providers.splice(idx, 1);
  writeFile(doc);
  const ref = bridge.routeReferencedElsewhere(bp.routeId, null, null, STORES);
  let routeRemoved = false;
  if (!ref) routeRemoved = bridge.removeRoute(bp.routeId);
  return { results, routeRemoved, routeKeptBy: ref || null };
}

async function addModels(id, models) {
  if (!Array.isArray(models) || !models.length) throw new Error('models 不能为空');
  const doc = readFile();
  const bp = mustGet(doc, id);
  const known = new Set(bp.models.map((m) => m.id));
  const added = [];
  for (const m of models) {
    const mid = String((m && m.id) || '').trim();
    if (!mid || known.has(mid)) continue;
    known.add(mid);
    const mname = String((m && m.name) || mid).trim() || mid;
    bp.models.push({ id: mid, name: mname });
    added.push(mid);
  }
  bp.updatedAt = nowIso();
  const reSync = await reSyncTools(bp);
  writeFile(doc);
  return { added, reSync };
}

async function deleteModels(id, modelIds) {
  if (!Array.isArray(modelIds) || !modelIds.length) throw new Error('modelIds 不能为空');
  const doc = readFile();
  const bp = mustGet(doc, id);
  const removed = [];
  bp.models = bp.models.filter((m) => {
    if (modelIds.includes(m.id)) {
      removed.push(m.id);
      return false;
    }
    return true;
  });
  bp.updatedAt = nowIso();
  const reSync = await reSyncTools(bp);
  writeFile(doc);
  return { removed, reSync };
}

// ---------- 对外描述（前端用；key 永不下发完整值） ----------

function describe(bp) {
  const port = bridge.readConfig().port;
  return {
    id: bp.id,
    name: bp.name,
    upstream: bp.upstream,
    style: bp.style,
    routeId: bp.routeId,
    bridgedUrl: bridgedUrl(bp, port),
    apiKeySet: !!bp.apiKey,
    apiKeyMasked: bp.apiKey
      ? (bp.apiKey.startsWith('env:') ? bp.apiKey : maskKey(bp.apiKey))
      : '（未设置）',
    apiKeyEnv: bp.apiKey && bp.apiKey.startsWith('env:') ? bp.apiKey.slice(4).trim() : null,
    models: bp.models.map((m) => ({ ...m })),
    copies: Object.fromEntries(TOOLS.map((t) => [t, copyStatus(bp, t)])),
    createdAt: bp.createdAt || null,
    updatedAt: bp.updatedAt || null,
    migrated: !!bp.migrated,
  };
}

// ---------- 旧数据迁移（旧版＝在 agent 的 provider 卡片上「一键走桥接」，无独立记录） ----------
// 把 bridge.json 里带 originalBaseUrl 的历史路由导入为桥接模型：
// 纯增量操作，不改写任何 agent 配置文件；副本继续指向原路由，agentIds 记录对应关系。

// 读某个工具 provider 的 key 原始存储形态，转换为桥接模型的 key 形式（env:NAME / 明文 / null）
function rawKeyOf(tool, provId) {
  try {
    if (tool === 'pi') {
      const doc = JSON.parse(fs.readFileSync(CONFIG_PATHS.pi, 'utf8'));
      const key = ((doc.providers || {})[provId] || {}).apiKey || '';
      if (key.startsWith('$')) return 'env:' + key.slice(1);
      if (key) return key;
      const auth = JSON.parse(fs.readFileSync(CONFIG_PATHS.piAuth, 'utf8'));
      return ((auth[provId] || {}).key) || null;
    }
    const doc = parseJsonc(fs.readFileSync(CONFIG_PATHS.opencode, 'utf8'));
    const key = (((doc.provider || {})[provId] || {}).options || {}).apiKey || '';
    const m = String(key).match(/^\{env:([^}]+)\}$/);
    if (m) return 'env:' + m[1].trim();
    if (key) return key;
    const auth = JSON.parse(fs.readFileSync(CONFIG_PATHS.ocAuth, 'utf8').replace(/^\uFEFF/, ''));
    return ((auth[provId] || {}).key) || null;
  } catch {
    return null;
  }
}

function migrateLegacy(doc) {
  const changes = [];
  const cfg = bridge.readConfig();
  for (const [routeId, route] of Object.entries(cfg.routes)) {
    if (route.bridgeProviderId) continue; // 已是新版数据
    if (!route.originalBaseUrl || !route.upstream) {
      changes.push(`路由 ${routeId}: 缺少原上游地址记录，跳过`);
      continue;
    }
    // 找出指向该路由的 provider（可能在两个工具里都有）
    const foundList = [];
    for (const tool of TOOLS) {
      let data;
      try {
        data = STORES[tool].read();
      } catch {
        continue;
      }
      const prov = data.providers.find((x) => {
        const parsed = bridge.parseBridgeUrl(x.baseUrl);
        return parsed && parsed.routeId === routeId;
      });
      if (prov) foundList.push({ tool, prov });
    }
    if (!foundList.length) {
      changes.push(`路由 ${routeId}: 两个工具的配置里都没有指向它的 provider，跳过`);
      continue;
    }
    const first = foundList[0];
    let bp = doc.providers.find((x) => x.id === (route.providerId || routeId));
    if (bp && bp.routeId !== routeId) bp = null; // 同 id 但属于另一条路由 → 另立条目
    if (!bp) bp = doc.providers.find((x) => x.routeId === routeId);
    if (!bp) {
      const base = ID_RE.test(route.providerId || '') ? route.providerId : routeId;
      let candidate = base;
      let i = 2;
      while (doc.providers.some((x) => x.id === candidate)) {
        candidate = `${base}-${i}`;
        i += 1;
      }
      bp = {
        id: candidate,
        name: first.prov.name || candidate,
        upstream: route.originalBaseUrl,
        apiKey: rawKeyOf(first.tool, first.prov.id),
        style: first.prov.style || 'openai-completions',
        models: first.prov.models.map((m) => ({ id: m.id, name: m.name })),
        routeId,
        agentIds: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
        migrated: true,
      };
      doc.providers.push(bp);
      changes.push(`导入「${bp.id}」（来自 ${first.tool}/${first.prov.id}，${bp.models.length} 个模型）`);
    }
    bp.agentIds = bp.agentIds || {};
    for (const { tool, prov } of foundList) {
      if (!bp.agentIds[tool]) {
        bp.agentIds[tool] = prov.id;
        changes.push(`「${bp.id}」登记 ${tool} 副本 ${prov.id}`);
      }
    }
    bridge.setRoute(routeId, { ...route, bridgeProviderId: bp.id });
  }
  doc.migratedV2 = true;
  return changes;
}

// ---------- 初始化（服务启动时调用） ----------

function init() {
  const doc = readFile();
  if (!doc.migratedV2) {
    const changes = migrateLegacy(doc);
    writeFile(doc);
    console.log(`[桥接模型] 旧桥接数据迁移完成（共 ${doc.providers.length} 个桥接模型）`);
    for (const c of changes) console.log(`  · ${c}`);
  }
  // 路由守卫：确保每个桥接模型在 bridge.json 里都有对应路由（被手工改过/丢失时自动补齐）
  for (const bp of readFile().providers) {
    try {
      ensureRoute(bp);
    } catch (e) {
      console.error(`[桥接模型] 路由供给失败 ${bp.id}: ${e.message}`);
    }
  }
  return readFile();
}

// ---------- 单工具同步入口（供路由层调用） ----------

async function syncToTool(id, tool) {
  const doc = readFile();
  const bp = mustGet(doc, id);
  if (!TOOLS.includes(tool)) throw new Error(`未知工具: ${tool}（仅支持 ${TOOLS.join(' / ')}）`);
  await bridge.ensureRunning().catch(() => {}); // 尽量提前拉起桥接进程（按需，失败不阻断同步）
  const r = await applySync(bp, tool);
  writeFile(doc);
  return { tool, ...r };
}

async function unsyncFromTool(id, tool) {
  const doc = readFile();
  const bp = mustGet(doc, id);
  const r = await removeSync(bp, tool);
  writeFile(doc);
  return { tool, ...r };
}

module.exports = {
  TOOLS,
  FILE,
  init,
  list,
  get,
  getOrThrow,
  findByRoute,
  describe,
  create,
  update,
  remove,
  addModels,
  deleteModels,
  syncToTool,
  unsyncFromTool,
  copyStatus,
  resolveKey,
  bridgedUrl,
};

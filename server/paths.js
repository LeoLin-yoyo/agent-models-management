// 两个 agent 工具的配置文件定位 + 写前备份
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATHS = {
  opencode: findFirst([
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
  ]),
  pi: path.join(os.homedir(), '.pi', 'agent', 'models.json'),
  piAuth: path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
  // opencode 的凭据文件（/connect 写入），实测带 UTF-8 BOM
  ocAuth: path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
};

// 读 JSON 文本并剥掉 UTF-8 BOM（opencode 的 auth.json 实测带 BOM，直接 parse 会炸）
function readJsonNoBom(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function findFirst(candidates) {
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

// 每次写配置前备份到 <config 所在目录>/ammp-backups/，最多保留 20 份
function backupConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const dir = path.join(path.dirname(configPath), 'ammp-backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(configPath)}.${stamp}.bak`);
  fs.copyFileSync(configPath, dest);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(configPath))).sort();
  while (files.length > 20) fs.unlinkSync(path.join(dir, files.shift()));
  return dest;
}

// 简单的进程内写锁，避免并发写同一配置文件
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

module.exports = { CONFIG_PATHS, backupConfig, withLock, readJsonNoBom };

// 两个 agent 工具的配置文件定位 + 写前备份 + 平台共享数据目录
// 路径基座可用环境变量覆盖（隔离测试 / 特殊部署）：AMMP_HOME 换用户主目录，AMMP_DATA_DIR 换数据目录
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.AMMP_HOME ? path.resolve(process.env.AMMP_HOME) : os.homedir();

// 平台运行数据（桥接配置、桥接模型注册表、测试结果、日志）默认放在仓库 data/ 下
const DATA_DIR = process.env.AMMP_DATA_DIR
  ? path.resolve(process.env.AMMP_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const CONFIG_PATHS = {
  opencode: findFirst([
    path.join(HOME, '.config', 'opencode', 'opencode.jsonc'),
    path.join(HOME, '.config', 'opencode', 'opencode.json'),
  ]),
  pi: path.join(HOME, '.pi', 'agent', 'models.json'),
  piAuth: path.join(HOME, '.pi', 'agent', 'auth.json'),
  // pi 的全局设置（默认模型 defaultProvider/defaultModel/defaultThinkingLevel 存这里）
  piSettings: path.join(HOME, '.pi', 'agent', 'settings.json'),
  // opencode 的凭据文件（/connect 写入），实测带 UTF-8 BOM
  ocAuth: path.join(HOME, '.local', 'share', 'opencode', 'auth.json'),
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

module.exports = { CONFIG_PATHS, DATA_DIR, HOME, backupConfig, withLock, readJsonNoBom };

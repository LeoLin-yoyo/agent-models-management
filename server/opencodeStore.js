// opencode 配置存储：~/.config/opencode/opencode.jsonc（JSONC）
const fs = require('fs');
const { parseJsonc } = require('./jsonc');
const { CONFIG_PATHS, backupConfig, withLock, readJsonNoBom } = require('./paths');
const { maskKey } = require('./mask');

const STYLES = { openai: '@ai-sdk/openai-compatible', anthropic: '@ai-sdk/anthropic' };

function styleOfNpm(npm) {
  return String(npm || '').includes('anthropic') ? 'anthropic-messages' : 'openai-completions';
}

// 读取 opencode auth.json（~/.local/share/opencode/auth.json），不存在/损坏时返回 {}
function loadAuth() {
  try {
    return readJsonNoBom(CONFIG_PATHS.ocAuth);
  } catch {
    return {};
  }
}

function loadRaw() {
  const raw = fs.readFileSync(CONFIG_PATHS.opencode, 'utf8');
  return { doc: parseJsonc(raw), raw };
}

function saveDoc(doc) {
  backupConfig(CONFIG_PATHS.opencode);
  fs.writeFileSync(CONFIG_PATHS.opencode, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function normalize(doc) {
  const providers = doc.provider || {};
  const auth = loadAuth();
  return Object.entries(providers).map(([id, p]) => {
    const hasInline = !!(p.options && p.options.apiKey);
    // 内联引用或真实值都算「配置里有 key」；配置里没有时兜底看 auth.json
    const authHas = !!(!hasInline && auth[id] && auth[id].key);
    return {
      tool: 'opencode',
      id,
      name: p.name || id,
      baseUrl: (p.options && p.options.baseURL) || '',
      style: styleOfNpm(p.npm),
      npm: p.npm || '',
      apiKeySource: hasInline ? (isEnvRef(p.options.apiKey) ? 'env-ref' : 'inline') : (authHas ? 'auth.json' : 'none'),
      apiKeyMasked: maskKey(hasInline ? p.options.apiKey : (authHas ? auth[id].key : null)),
      models: Object.entries(p.models || {}).map(([mid, m]) => ({
        id: mid,
        name: (m && m.name) || mid,
      })),
    };
  });
}

// 顶层 "model": "provider/model" 即新会话默认模型；provider id 不含斜杠，按第一个 / 切分
function readDefaultModel(doc) {
  const v = typeof doc.model === 'string' ? doc.model.trim() : '';
  const i = v.indexOf('/');
  if (!v || i <= 0 || i === v.length - 1) return null;
  return { provider: v.slice(0, i), model: v.slice(i + 1) };
}

function setDefaultModel(providerId, modelId) {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    doc.model = `${providerId}/${modelId}`;
    saveDoc(doc);
    return readDefaultModel(doc);
  });
}

function clearDefaultModel() {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    delete doc.model;
    saveDoc(doc);
    return null;
  });
}

function read() {
  const { doc } = loadRaw();
  return {
    tool: 'opencode',
    configPath: CONFIG_PATHS.opencode,
    providers: normalize(doc),
    defaultModel: readDefaultModel(doc),
  };
}

function getProviderDoc(doc, id) {
  doc.provider = doc.provider || {};
  const p = doc.provider[id];
  if (!p) throw new Error(`opencode 中不存在 provider: ${id}`);
  return p;
}

function createProvider({ id, name, baseUrl, apiKey, style }) {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    doc.provider = doc.provider || {};
    if (doc.provider[id]) throw new Error(`provider ${id} 已存在`);
    const options = { baseURL: baseUrl };
    if (apiKey) options.apiKey = apiKey;
    doc.provider[id] = {
      npm: STYLES[style === 'anthropic-messages' ? 'anthropic' : 'openai'],
      name: name || id,
      options,
      models: {},
    };
    saveDoc(doc);
  });
}

function updateProvider(id, patch) {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    const p = getProviderDoc(doc, id);
    p.options = p.options || {};
    if (patch.name != null && patch.name !== '') p.name = patch.name;
    if (patch.baseUrl != null && patch.baseUrl !== '') p.options.baseURL = patch.baseUrl;
    if (patch.apiKey) p.options.apiKey = patch.apiKey;
    if (patch.style) p.npm = STYLES[patch.style === 'anthropic-messages' ? 'anthropic' : 'openai'];
    if (patch.newId && patch.newId !== id) {
      if (doc.provider[patch.newId]) throw new Error(`provider ${patch.newId} 已存在`);
      const entries = Object.entries(doc.provider);
      doc.provider = {};
      for (const [k, v] of entries) doc.provider[k === id ? patch.newId : k] = v;
    }
    saveDoc(doc);
  });
}

function deleteProvider(id) {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    getProviderDoc(doc, id);
    delete doc.provider[id];
    saveDoc(doc);
  });
}

function addModels(id, models) {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    const p = getProviderDoc(doc, id);
    p.models = p.models || {};
    const added = [];
    for (const m of models) {
      if (!m.id || p.models[m.id]) continue;
      p.models[m.id] = { ...(m.name && m.name !== m.id ? { name: m.name } : {}), ...(m.extra || {}) };
      added.push(m.id);
    }
    saveDoc(doc);
    return added;
  });
}

function deleteModels(id, modelIds) {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    const p = getProviderDoc(doc, id);
    const removed = [];
    for (const mid of modelIds) {
      if (p.models && p.models[mid]) {
        delete p.models[mid];
        removed.push(mid);
      }
    }
    saveDoc(doc);
    return removed;
  });
}

// 探测用：key 优先级 = 配置内联 → auth.json（/connect 写入的凭据）
function resolveKey(id) {
  const { doc } = loadRaw();
  const p = getProviderDoc(doc, id);
  if (p.options && p.options.apiKey) return resolveApiKeyRef(p.options.apiKey);
  const auth = loadAuth();
  return (auth[id] && auth[id].key) || null;
}

// opencode 的 {env:VAR} 环境变量引用（官方语法：未设置时替换为空串）
function isEnvRef(value) {
  return typeof value === 'string' && /^\{env:[^}]+\}$/.test(value.trim());
}

// 把 key 还原成「实际值」：{env:VAR} → 读取环境变量（带 BOM 兜底），普通值原样返回
function resolveApiKeyRef(value) {
  if (typeof value !== 'string') return value ?? null;
  const m = value.trim().match(/^\{env:([^}]+)\}$/);
  if (m) {
    const name = m[1].trim();
    let v = process.env[name];
    // 部分环境变量值可能带 BOM，读出来会导致请求头异常，剥一下
    if (typeof v === 'string' && v.charCodeAt(0) === 0xfeff) v = v.slice(1);
    return v || null;
  }
  return value;
}

// 供跨工具同步用：以单条 provider 数据整体 upsert（存在则覆盖，不存在则新建）
// entry: { id, name, baseUrl, style, apiKey }，apiKey 为实际值（已由 crossSync 转换好）
function upsertProvider(entry) {
  return withLock('opencode', () => {
    const { doc } = loadRaw();
    doc.provider = doc.provider || {};
    const existed = !!doc.provider[entry.id];
    const options = { baseURL: entry.baseUrl };
    if (entry.apiKey) options.apiKey = entry.apiKey;
    const docp = {
      npm: STYLES[entry.style === 'anthropic-messages' ? 'anthropic' : 'openai'],
      name: entry.name || entry.id,
      options,
      models: {},
    };
    for (const m of entry.models || []) {
      if (!m || !m.id) continue;
      docp.models[m.id] = { ...(m.name && m.name !== m.id ? { name: m.name } : {}) };
    }
    doc.provider[entry.id] = docp;
    saveDoc(doc);
    return { existed };
  });
}

module.exports = {
  tool: 'opencode',
  read,
  createProvider,
  updateProvider,
  deleteProvider,
  addModels,
  deleteModels,
  resolveKey,
  upsertProvider,
  setDefaultModel,
  clearDefaultModel,
};

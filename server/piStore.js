// pi 配置存储：~/.pi/agent/models.json（key 可为 $ENV 引用，实际 key 也可能存在 auth.json）
// 默认模型存 ~/.pi/agent/settings.json 的 defaultProvider / defaultModel（可选 defaultThinkingLevel）
const fs = require('fs');
const { CONFIG_PATHS, backupConfig, withLock, readJsonNoBom } = require('./paths');
const { maskKey } = require('./mask');

function loadRaw() {
  const raw = fs.readFileSync(CONFIG_PATHS.pi, 'utf8');
  return { doc: JSON.parse(raw), raw };
}

function saveDoc(doc) {
  backupConfig(CONFIG_PATHS.pi);
  fs.writeFileSync(CONFIG_PATHS.pi, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATHS.piAuth, 'utf8'));
  } catch {
    return {};
  }
}

// settings.json 可能不存在或带 BOM，读不到就当 {}
function loadSettings() {
  try {
    return readJsonNoBom(CONFIG_PATHS.piSettings);
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  backupConfig(CONFIG_PATHS.piSettings);
  fs.writeFileSync(CONFIG_PATHS.piSettings, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// 默认模型：settings.json 的 defaultProvider + defaultModel 组成 provider/model
function readDefaultModel() {
  const s = loadSettings();
  if (!s.defaultProvider || !s.defaultModel) return null;
  return { provider: s.defaultProvider, model: s.defaultModel, thinkingLevel: s.defaultThinkingLevel || null };
}

// 设默认模型；thinkingLevel 传 null 时删除该键，undefined 时不改动，其余值写入
function setDefaultModel(providerId, modelId, thinkingLevel) {
  return withLock('pi-settings', () => {
    const s = loadSettings();
    s.defaultProvider = providerId;
    s.defaultModel = modelId;
    if (thinkingLevel === null) delete s.defaultThinkingLevel;
    else if (thinkingLevel != null && thinkingLevel !== '') s.defaultThinkingLevel = thinkingLevel;
    saveSettings(s);
    return readDefaultModel();
  });
}

function clearDefaultModel() {
  return withLock('pi-settings', () => {
    const s = loadSettings();
    delete s.defaultProvider;
    delete s.defaultModel;
    delete s.defaultThinkingLevel;
    saveSettings(s);
    return null;
  });
}

function apiKeySourceOf(p, id) {
  const key = p.apiKey || '';
  if (key.startsWith('$')) {
    const envName = key.slice(1);
    return process.env[envName] ? `env:${envName}` : `env:${envName}(未设置)`;
  }
  if (key) return 'inline';
  const auth = loadAuth();
  return auth[id] && auth[id].key ? 'auth.json' : 'none';
}

function normalize(doc) {
  const providers = doc.providers || {};
  return Object.entries(providers).map(([id, p]) => ({
    tool: 'pi',
    id,
    name: p.name || id,
    baseUrl: p.baseUrl || '',
    style: p.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    api: p.api || '',
    apiKeySource: apiKeySourceOf(p, id),
    // key 的存储形态：env-ref（$ENV 引用）/ inline（明文）/ auth.json / none
    // 跨工具同步时据此决定 key 转换策略
    sourceKind: p.apiKey && p.apiKey.startsWith('$') ? 'env-ref' : p.apiKey ? 'inline' : (loadAuth()[id] && loadAuth()[id].key ? 'auth.json' : 'none'),
    apiKeyMasked: maskKey(p.apiKey || (loadAuth()[id] || {}).key),
    models: (p.models || []).map((m) => ({ id: m.id, name: m.name || m.id })),
  }));
}

function read() {
  const { doc } = loadRaw();
  return {
    tool: 'pi',
    configPath: CONFIG_PATHS.pi,
    providers: normalize(doc),
    defaultModel: readDefaultModel(),
  };
}

function getProviderDoc(doc, id) {
  doc.providers = doc.providers || {};
  const p = doc.providers[id];
  if (!p) throw new Error(`pi 中不存在 provider: ${id}`);
  return p;
}

// 写入 key：支持 "env:NAME" 写成 $NAME 引用；空值保持不变
function normalizeApiKeyInput(input) {
  if (!input) return undefined;
  if (input.startsWith('env:')) return '$' + input.slice(4);
  return input;
}

function createProvider({ id, name, baseUrl, apiKey, style }) {
  return withLock('pi', () => {
    const { doc } = loadRaw();
    doc.providers = doc.providers || {};
    if (doc.providers[id]) throw new Error(`provider ${id} 已存在`);
    const p = {
      baseUrl,
      api: style === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      models: [],
    };
    if (name && name !== id) p.name = name;
    const key = normalizeApiKeyInput(apiKey);
    if (key) p.apiKey = key;
    if (p.api === 'openai-completions') p.compat = { supportsDeveloperRole: false };
    doc.providers[id] = p;
    saveDoc(doc);
  });
}

function updateProvider(id, patch) {
  return withLock('pi', () => {
    const { doc } = loadRaw();
    const p = getProviderDoc(doc, id);
    if (patch.name != null && patch.name !== '') p.name = patch.name;
    if (patch.baseUrl != null && patch.baseUrl !== '') p.baseUrl = patch.baseUrl;
    if (patch.style) p.api = patch.style;
    if (patch.apiKey) {
      const key = normalizeApiKeyInput(patch.apiKey);
      if (key) p.apiKey = key;
    }
    if (patch.newId && patch.newId !== id) {
      if (doc.providers[patch.newId]) throw new Error(`provider ${patch.newId} 已存在`);
      const entries = Object.entries(doc.providers);
      doc.providers = {};
      for (const [k, v] of entries) doc.providers[k === id ? patch.newId : k] = v;
    }
    saveDoc(doc);
  });
}

function deleteProvider(id) {
  return withLock('pi', () => {
    const { doc } = loadRaw();
    getProviderDoc(doc, id);
    delete doc.providers[id];
    saveDoc(doc);
  });
}

const PI_MODEL_DEFAULTS = { input: ['text'], contextWindow: 131072, maxTokens: 16384 };

function addModels(id, models) {
  return withLock('pi', () => {
    const { doc } = loadRaw();
    const p = getProviderDoc(doc, id);
    p.models = p.models || [];
    const known = new Set(p.models.map((m) => m.id));
    const added = [];
    for (const m of models) {
      if (!m.id || known.has(m.id)) continue;
      p.models.push({
        id: m.id,
        name: m.name && m.name !== m.id ? m.name : m.id,
        ...PI_MODEL_DEFAULTS,
        ...(m.extra || {}),
      });
      added.push(m.id);
    }
    saveDoc(doc);
    return added;
  });
}

function deleteModels(id, modelIds) {
  return withLock('pi', () => {
    const { doc } = loadRaw();
    const p = getProviderDoc(doc, id);
    const before = p.models.length;
    p.models = p.models.filter((m) => !modelIds.includes(m.id));
    saveDoc(doc);
    return before - p.models.length;
  });
}

// 探测用 key 解析：字面量 → $ENV → auth.json
function resolveKey(id) {
  const { doc } = loadRaw();
  const p = getProviderDoc(doc, id);
  if (p.apiKey && !p.apiKey.startsWith('$')) return p.apiKey;
  if (p.apiKey && p.apiKey.startsWith('$')) {
    const envVal = process.env[p.apiKey.slice(1)];
    if (envVal) return envVal;
  }
  const auth = loadAuth();
  return (auth[id] && auth[id].key) || null;
}

// 供跨工具同步用：以单条 provider 数据整体 upsert（存在则覆盖，不存在则新建）
// entry: { id, name, baseUrl, style, apiKey }，apiKey 为 pi 侧最终写入形式（$ENV 或明文，已由 crossSync 转换好）
function upsertProvider(entry) {
  return withLock('pi', () => {
    const { doc } = loadRaw();
    doc.providers = doc.providers || {};
    const existed = !!doc.providers[entry.id];
    const p = {
      baseUrl: entry.baseUrl,
      api: entry.style === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      models: [],
    };
    if (entry.name && entry.name !== entry.id) p.name = entry.name;
    if (entry.apiKey) p.apiKey = entry.apiKey;
    if (p.api === 'openai-completions') p.compat = { supportsDeveloperRole: false };
    const known = new Set();
    for (const m of entry.models || []) {
      if (!m || !m.id || known.has(m.id)) continue;
      known.add(m.id);
      p.models.push({
        id: m.id,
        name: m.name && m.name !== m.id ? m.name : m.id,
        ...PI_MODEL_DEFAULTS,
      });
    }
    doc.providers[entry.id] = p;
    saveDoc(doc);
    return { existed };
  });
}

module.exports = {
  tool: 'pi',
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

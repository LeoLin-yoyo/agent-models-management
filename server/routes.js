// REST API 路由
const path = require('path');
const express = require('express');
const fs = require('fs');
const opencodeStore = require('./opencodeStore');
const piStore = require('./piStore');
const probe = require('./probe');
const cli = require('./cliRunner');
const crossSync = require('./crossSync');
const bridge = require('./bridge');
const bridgeProviders = require('./bridgeProviders');
const { DATA_DIR } = require('./paths');

const router = express.Router();
const STORES = { opencode: opencodeStore, pi: piStore };

// 测试结果持久化（重启后仍能看到上次测试状态）；AMMP_DATA_DIR 可换目录（隔离测试）
const STATE_FILE = path.join(DATA_DIR, 'test-results.json');
let testState = {};
try {
  testState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {}

function saveTestState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(testState, null, 2));
}

const stateKey = (tool, p, m) => `${tool}/${p}/${m}`;

function getStore(tool) {
  const s = STORES[tool];
  if (!s) throw new Error(`未知工具: ${tool}（仅支持 opencode / pi）`);
  return s;
}

function findProvider(tool, providerId) {
  const store = getStore(tool);
  const prov = store.read().providers.find((x) => x.id === providerId);
  if (!prov) throw new Error(`${tool} 中不存在 provider: ${providerId}`);
  return { store, prov };
}

// 该 provider 的请求是否经本地桥接转发（走桥接的 provider，Key 已在桥接模型里配好，
// 不再做 Key 存在性校验：读不到值就透传给上游判定，由上游返回 401 等真实结果）
function isBridged(tool, prov) {
  return bridge.providerBridgeInfo(tool, prov.id, prov.baseUrl).bridged;
}

// ---------- 总览 ----------
router.get('/overview', (req, res) => {
  const result = {};
  for (const [tool, store] of Object.entries(STORES)) {
    const data = store.read();
    for (const prov of data.providers) {
      for (const m of prov.models) {
        m.test = testState[stateKey(tool, prov.id, m.id)] || null;
      }
      prov.bridge = bridge.providerBridgeInfo(tool, prov.id, prov.baseUrl);
    }
    result[tool] = data;
  }
  res.json(result);
});

// ---------- Provider CRUD ----------
router.post('/providers/create', async (req, res, next) => {
  try {
    const { tool, id, name, baseUrl, apiKey, style } = req.body || {};
    if (!id || !baseUrl) throw new Error('id 和 baseUrl 必填');
    await getStore(tool).createProvider({
      id: String(id).trim(),
      name,
      baseUrl: String(baseUrl).trim(),
      apiKey,
      style: style || 'openai-completions',
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/providers/update', async (req, res, next) => {
  try {
    const { tool, id, patch } = req.body || {};
    await getStore(tool).updateProvider(id, patch || {});
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/providers/delete', async (req, res, next) => {
  try {
    const { tool, id } = req.body || {};
    await getStore(tool).deleteProvider(id);
    const defaultCleared = clearDefaultIfReferenced(tool, id, null);
    res.json({ ok: true, defaultCleared });
  } catch (e) {
    next(e);
  }
});

// ---------- 模型 CRUD ----------
router.post('/models/add', async (req, res, next) => {
  try {
    const { tool, providerId, models } = req.body || {};
    if (!Array.isArray(models) || !models.length) throw new Error('models 不能为空');
    const added = await getStore(tool).addModels(providerId, models);
    res.json({ ok: true, added });
  } catch (e) {
    next(e);
  }
});

router.post('/models/delete', async (req, res, next) => {
  try {
    const { tool, providerId, modelIds } = req.body || {};
    if (!Array.isArray(modelIds) || !modelIds.length) throw new Error('modelIds 不能为空');
    const removed = await getStore(tool).deleteModels(providerId, modelIds);
    const defaultCleared = clearDefaultIfReferenced(tool, providerId, removed);
    res.json({ ok: true, removed, defaultCleared });
  } catch (e) {
    next(e);
  }
});

// ---------- 默认模型（新会话不再手动选模型） ----------
// opencode：配置顶层 "model": "provider/model"；pi：settings.json 的 defaultProvider/defaultModel
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 删除 provider / 模型后调用：默认模型引用了被删对象就一并清除，避免留下失效配置
function clearDefaultIfReferenced(tool, providerId, modelIds) {
  const def = getStore(tool).read().defaultModel;
  if (!def || def.provider !== providerId) return false;
  if (Array.isArray(modelIds) && !modelIds.includes(def.model)) return false;
  getStore(tool).clearDefaultModel();
  return true;
}

// body { tool, providerId, modelId, thinkingLevel? }
// providerId/modelId 任一为空 → 清除该工具的默认模型；thinkingLevel 仅 pi 支持
router.post('/default-model', async (req, res, next) => {
  try {
    const { tool } = req.body || {};
    const store = getStore(tool);
    const providerId = String(req.body?.providerId || '').trim();
    const modelId = String(req.body?.modelId || '').trim();

    if (!providerId || !modelId) {
      const def = await store.clearDefaultModel();
      return res.json({ ok: true, default: def, cleared: true });
    }

    const prov = store.read().providers.find((x) => x.id === providerId);
    if (!prov) throw new Error(`${tool} 中不存在 provider: ${providerId}`);
    if (!prov.models.some((m) => m.id === modelId)) {
      throw new Error(`${tool}/${providerId} 中不存在模型: ${modelId}`);
    }
    if (prov.apiKeySource === 'none') {
      throw new Error(
        `该 provider 未配置 API Key，设置了默认模型也不会生效（工具要求有可用 key），请先在「编辑」里配置 key`
      );
    }

    let thinkingLevel;
    if (tool === 'pi' && req.body.thinkingLevel !== undefined) {
      const tl = req.body.thinkingLevel;
      if (tl !== null && tl !== '' && !PI_THINKING_LEVELS.includes(tl)) {
        throw new Error(`thinkingLevel 不合法（可选：${PI_THINKING_LEVELS.join(' / ')}）`);
      }
      thinkingLevel = tl;
    }
    const def = await store.setDefaultModel(providerId, modelId, thinkingLevel);
    res.json({ ok: true, default: def });
  } catch (e) {
    next(e);
  }
});

// ---------- 远端模型同步（拉取 diff） ----------
router.get('/providers/remote-models', async (req, res, next) => {
  try {
    const { tool, provider } = req.query;
    const { store, prov } = findProvider(tool, provider);
    const apiKey = store.resolveKey(provider);
    if (!apiKey && !isBridged(tool, prov)) throw new Error('未找到该 provider 的 API key，无法拉取远端列表');
    const remote = await probe.listRemoteModels({ baseUrl: prov.baseUrl, apiKey, style: prov.style });
    const configured = prov.models.map((m) => m.id);
    const inSet = new Set(configured);
    const remoteSet = new Set(remote.models);
    res.json({
      ok: true,
      remote: remote.models,
      remoteCount: remote.total,
      configured,
      added: remote.models.filter((id) => !inSet.has(id)),
      removed: configured.filter((id) => !remoteSet.has(id)),
    });
  } catch (e) {
    next(e);
  }
});

// ---------- 模型测试 ----------
router.post('/test', async (req, res, next) => {
  try {
    const { tool, providerId, modelId, via = 'api' } = req.body || {};
    const { store, prov } = findProvider(tool, providerId);
    const started = Date.now();
    let result;
    if (via === 'cli') {
      result =
        tool === 'opencode'
          ? await cli.testViaOpencode(providerId, modelId)
          : await cli.testViaPi(providerId, modelId);
    } else {
      const apiKey = store.resolveKey(providerId);
      if (!apiKey && !isBridged(tool, prov)) throw new Error('未找到该 provider 的 API key，无法直接测试');
      result = await probe.testModel({ baseUrl: prov.baseUrl, apiKey, style: prov.style, modelId });
    }
    const state = {
      ok: !!result.ok,
      via,
      latencyMs: result.latencyMs || Date.now() - started,
      error: result.error || null,
      snippet: result.output || result.snippet || '',
      checkedAt: new Date().toISOString(),
    };
    testState[stateKey(tool, providerId, modelId)] = state;
    saveTestState();
    res.json({ ok: true, result: state });
  } catch (e) {
    next(e);
  }
});

// ---------- 跨工具同步（opencode ⇄ pi） ----------
// 预检 diff：direction 如 "pi->opencode" / "opencode->pi"；providers 可选（缺省全量）
router.get('/cross-sync/plan', (req, res, next) => {
  try {
    const { direction } = req.query;
    let providers = [];
    if (req.query.providers) {
      providers = String(req.query.providers).split(',').map((s) => s.trim()).filter(Boolean);
    }
    res.json({ ok: true, ...crossSync.plan(direction, providers) });
  } catch (e) {
    next(e);
  }
});

// 应用同步：body { direction, providers: [id,...] }
router.post('/cross-sync/apply', async (req, res, next) => {
  try {
    const { direction, providers } = req.body || {};
    if (!Array.isArray(providers) || !providers.length) throw new Error('providers 不能为空');
    // 注意 apply 是 async，必须 await 后再返回，否则响应体会丢掉 results/summary
    const r = await crossSync.apply(direction, providers);
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

// ---------- 即时问答 ----------
// body { tool, providerId, modelId, messages: [{role, content}] }
// 用服务端解析出的真实 key 直接调用网关；key 不会下发给前端
router.post('/chat', async (req, res, next) => {
  try {
    const { tool, providerId, modelId, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) throw new Error('messages 不能为空');
    if (messages.length > 40) throw new Error('对话轮数过多，请开新会话');
    for (const m of messages) {
      if (!m || typeof m.content !== 'string' || !['user', 'assistant', 'system'].includes(m.role)) {
        throw new Error('messages 格式不合法');
      }
      if (m.content.length > 32000) throw new Error('单条消息过长（>32000 字符）');
    }
    const { store, prov } = findProvider(tool, providerId);
    const apiKey = store.resolveKey(providerId);
    if (!apiKey && !isBridged(tool, prov)) throw new Error('未找到该 provider 的 API key，无法即时问答');
    const r = await probe.chatOnce({ baseUrl: prov.baseUrl, apiKey, style: prov.style, modelId, messages });
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

// ---------- 即时问答（流式 SSE） ----------
// 校验失败 → JSON 错误；成功后切 SSE：data:{"t":"增量"} / data:{"done":true,...} / data:{"error":"..."}
router.post('/chat/stream', async (req, res, next) => {
  let upstream = null;
  try {
    const { tool, providerId, modelId, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) throw new Error('messages 不能为空');
    if (messages.length > 40) throw new Error('对话轮数过多，请开新会话');
    for (const m of messages) {
      if (!m || typeof m.content !== 'string' || !['user', 'assistant', 'system'].includes(m.role)) {
        throw new Error('messages 格式不合法');
      }
      if (m.content.length > 32000) throw new Error('单条消息过长（>32000 字符）');
    }
    const { store, prov } = findProvider(tool, providerId);
    const apiKey = store.resolveKey(providerId);
    if (!apiKey && !isBridged(tool, prov)) throw new Error('未找到该 provider 的 API key，无法即时问答');

    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;
    upstream = probe.chatStream({ baseUrl: prov.baseUrl, apiKey, style: prov.style, modelId, messages });
    // 注意：不能用 req.on('close') —— 新版 Node 中它表示「请求体读取完成」，body-parser 读完就会触发，
    // 会误杀正在进行的流。正确姿势：res.on('close') 且 res.writableEnded 为 false 才是客户端提前断开。
    res.on('close', () => {
      if (!res.writableEnded) { closed = true; upstream.abort(); }
    });
    try {
      for await (const ev of upstream.gen) {
        if (closed) break;
        if (ev.type === 'text') res.write(`data: ${JSON.stringify({ t: ev.text })}\n\n`);
        else if (ev.type === 'end') res.write(`data: ${JSON.stringify({ done: true, latencyMs: ev.latencyMs, usage: ev.usage, empty: ev.empty })}\n\n`);
      }
    } catch (e) {
      if (!closed) res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
  } catch (e) {
    if (res.headersSent) {
      // SSE 已开始，改用 SSE 错误事件告知前端
      try { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); } catch {}
    } else {
      next(e);
    }
  } finally {
    if (upstream) upstream.abort();
  }
});

// ---------- 桥接（本地 TCP→HTTP/3 转发） ----------
// 桥接进程由 server/bridge.js 托管（配置 data/bridge.json）；以下接口供前端控制与查询
router.get('/bridge/status', async (req, res, next) => {
  try {
    const st = bridge.getStatus();
    st.reachable = await bridge.isUp();
    res.json({ ok: true, ...st });
  } catch (e) {
    next(e);
  }
});

router.post('/bridge/start', async (req, res, next) => {
  try {
    const r = await bridge.ensureRunning();
    const st = bridge.getStatus();
    st.reachable = await bridge.isUp();
    res.json({ ok: true, ...r, status: st });
  } catch (e) {
    next(e);
  }
});

router.post('/bridge/stop', async (req, res, next) => {
  try {
    const r = await bridge.stop();
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

// ---------- 桥接模型（「桥接管理」模块：独立配置 → 同步到 agent 工具） ----------
// 桥接模型存 data/bridge-providers.json，与 agent 配置解耦；以下接口供「桥接管理」页使用。

// 列表：附各工具副本状态、桥接地址与测试结果（key 不下发完整值）
router.get('/bridge/providers', (req, res, next) => {
  try {
    const port = bridge.readConfig().port;
    const providers = bridgeProviders.list().map((bp) => {
      const d = bridgeProviders.describe(bp);
      d.models = d.models.map((m) => ({
        ...m,
        test: testState[stateKey('bridge', bp.id, m.id)] || null,
      }));
      return d;
    });
    res.json({ ok: true, port, providers });
  } catch (e) {
    next(e);
  }
});

router.post('/bridge/providers/create', async (req, res, next) => {
  try {
    const bp = bridgeProviders.create(req.body || {});
    bridge.ensureRunning().catch(() => {}); // 顺手拉起桥接进程（按需，失败不影响创建）
    res.json({ ok: true, provider: bridgeProviders.describe(bp) });
  } catch (e) {
    next(e);
  }
});

router.post('/bridge/providers/update', async (req, res, next) => {
  try {
    const { id, patch } = req.body || {};
    const r = await bridgeProviders.update(id, patch || {});
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

router.post('/bridge/providers/delete', async (req, res, next) => {
  try {
    const { id } = req.body || {};
    const r = await bridgeProviders.remove(id);
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

router.post('/bridge/providers/models/add', async (req, res, next) => {
  try {
    const { id, models } = req.body || {};
    const r = await bridgeProviders.addModels(id, models);
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

router.post('/bridge/providers/models/delete', async (req, res, next) => {
  try {
    const { id, modelIds } = req.body || {};
    const r = await bridgeProviders.deleteModels(id, modelIds);
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

// 同步开关：enabled=true → 在工具配置里创建/覆盖指向本地桥接的 provider 副本；
// enabled=false → 从工具配置删除副本（仅删本桥接模型的副本，且删除前自动备份）
router.post('/bridge/providers/sync', async (req, res, next) => {
  try {
    const { id, tool, enabled } = req.body || {};
    const r = enabled
      ? await bridgeProviders.syncToTool(id, tool)
      : await bridgeProviders.unsyncFromTool(id, tool);
    res.json({ ok: true, ...r });
  } catch (e) {
    next(e);
  }
});

// 经桥接的 API 测试：请求走 http://127.0.0.1:<port>/<routeId>... 由 QUIC 转发到上游
// Key 已在添加桥接模型时配置好，这里不再校验（读不到值时直接透传，由上游判定；无 key 则不注入鉴权头）
router.post('/bridge/providers/test', async (req, res, next) => {
  try {
    const { id, modelId } = req.body || {};
    const bp = bridgeProviders.getOrThrow(id);
    if (!bp.models.some((m) => m.id === modelId)) throw new Error(`桥接模型 ${id} 中不存在模型: ${modelId}`);
    await bridge.ensureRunning().catch(() => {});
    const started = Date.now();
    const result = await probe.testModel({
      baseUrl: bridgeProviders.bridgedUrl(bp),
      apiKey: bridgeProviders.resolveKey(bp),
      style: bp.style,
      modelId,
    });
    const state = {
      ok: !!result.ok,
      via: 'api',
      latencyMs: result.latencyMs || Date.now() - started,
      error: result.error || null,
      snippet: result.snippet || '',
      checkedAt: new Date().toISOString(),
    };
    testState[stateKey('bridge', id, modelId)] = state;
    saveTestState();
    res.json({ ok: true, result: state });
  } catch (e) {
    next(e);
  }
});

// 经桥接拉取远端模型列表（diff 出新增/未列出）；Key 已在桥接模型里配置，不再校验
router.get('/bridge/providers/remote-models', async (req, res, next) => {
  try {
    const bp = bridgeProviders.getOrThrow(req.query.id);
    await bridge.ensureRunning().catch(() => {});
    const remote = await probe.listRemoteModels({
      baseUrl: bridgeProviders.bridgedUrl(bp),
      apiKey: bridgeProviders.resolveKey(bp),
      style: bp.style,
    });
    const configured = bp.models.map((m) => m.id);
    const inSet = new Set(configured);
    const remoteSet = new Set(remote.models);
    res.json({
      ok: true,
      remote: remote.models,
      remoteCount: remote.total,
      configured,
      added: remote.models.filter((x) => !inSet.has(x)),
      removed: configured.filter((x) => !remoteSet.has(x)),
    });
  } catch (e) {
    next(e);
  }
});

// ---------- 错误处理 ----------
router.use((err, req, res, next) => {
  res.status(400).json({ ok: false, error: err.message || String(err) });
});

module.exports = router;

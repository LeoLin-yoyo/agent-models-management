// REST API 路由
const express = require('express');
const fs = require('fs');
const path = require('path');
const opencodeStore = require('./opencodeStore');
const piStore = require('./piStore');
const probe = require('./probe');
const cli = require('./cliRunner');
const crossSync = require('./crossSync');
const bridge = require('./bridge');

const router = express.Router();
const STORES = { opencode: opencodeStore, pi: piStore };

// 测试结果持久化（重启后仍能看到上次测试状态）
const DATA_DIR = path.join(__dirname, '..', 'data');
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
    let p = patch || {};
    // 正在桥接的 provider：用户编辑的是「原上游地址」，
    // 同步更新路由的 upstream/originalBaseUrl，并把实际写入配置的地址重新改写成桥接地址
    const store = getStore(tool);
    const existing = store.read().providers.find((x) => x.id === id);
    const binfo = existing ? bridge.providerBridgeInfo(tool, id, existing.baseUrl) : null;
    if (binfo && binfo.bridged && p.baseUrl
        && !bridge.parseBridgeUrl(p.baseUrl)) {
      let origin;
      try {
        origin = new URL(p.baseUrl).origin;
      } catch {
        throw new Error(`BaseURL 不是合法 URL：${p.baseUrl}`);
      }
      const route = bridge.getRoute(binfo.routeId) || {};
      bridge.setRoute(binfo.routeId, {
        ...route,
        upstream: origin,
        originalBaseUrl: p.baseUrl,
        tool,
        providerId: p.newId || id,
      });
      p = { ...p, baseUrl: bridge.bridgeBaseUrl(binfo.routeId, p.baseUrl) };
    }
    await store.updateProvider(id, p);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/providers/delete', async (req, res, next) => {
  try {
    const { tool, id } = req.body || {};
    await getStore(tool).deleteProvider(id);
    res.json({ ok: true });
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
    res.json({ ok: true, removed });
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
    if (!apiKey) throw new Error('未找到该 provider 的 API key，无法拉取远端列表');
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
      if (!apiKey) throw new Error('未找到该 provider 的 API key，无法直接测试');
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
    if (!apiKey) throw new Error('未找到该 provider 的 API key，无法即时问答');
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
    if (!apiKey) throw new Error('未找到该 provider 的 API key，无法即时问答');

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

// 给某个 provider 打开/关闭桥接：
// enabled=true  -> 记录路由 + 把 BaseURL 改写为 http://127.0.0.1:<port>/<routeId><原路径>
// enabled=false -> 恢复原 BaseURL（路由 meta 里的 originalBaseUrl）+ 视引用情况删除路由
router.post('/bridge/toggle', async (req, res, next) => {
  try {
    const { tool, providerId, enabled } = req.body || {};
    const { store, prov } = findProvider(tool, providerId);
    const cfg = bridge.readConfig();

    if (enabled) {
      const parsed = bridge.parseBridgeUrl(prov.baseUrl, cfg.port);
      if (parsed) {
        const route = bridge.getRoute(parsed.routeId);
        return res.json({
          ok: true, already: true, bridged: true, routeId: parsed.routeId,
          upstream: route ? route.upstream : null, baseUrl: prov.baseUrl,
        });
      }
      let upstreamOrigin;
      try {
        upstreamOrigin = new URL(prov.baseUrl).origin;
      } catch {
        throw new Error(`BaseURL 不是合法 URL，无法桥接：${prov.baseUrl}`);
      }
      const routeId = bridge.pickRouteId(tool, providerId, upstreamOrigin);
      bridge.setRoute(routeId, {
        upstream: upstreamOrigin,
        tool,
        providerId,
        originalBaseUrl: prov.baseUrl,
      });
      const newBase = bridge.bridgeBaseUrl(routeId, prov.baseUrl);
      await store.updateProvider(providerId, { baseUrl: newBase });
      const startR = await bridge.ensureRunning();
      return res.json({
        ok: true, bridged: true, routeId, upstream: upstreamOrigin,
        baseUrl: newBase, started: startR,
      });
    }

    // 关闭桥接
    const parsed = bridge.parseBridgeUrl(prov.baseUrl, cfg.port);
    if (!parsed) {
      return res.json({ ok: true, already: true, bridged: false, baseUrl: prov.baseUrl });
    }
    const route = bridge.getRoute(parsed.routeId);
    if (!route || !route.originalBaseUrl) {
      throw new Error('找不到该 provider 的原上游地址记录（可能是手动改写的 BaseURL），请手动编辑恢复');
    }
    await store.updateProvider(providerId, { baseUrl: route.originalBaseUrl });
    const ref = bridge.routeReferencedElsewhere(parsed.routeId, tool, providerId, STORES);
    if (!ref) bridge.removeRoute(parsed.routeId);
    return res.json({
      ok: true, bridged: false, baseUrl: route.originalBaseUrl,
      routeKept: !!ref, routeKeptBy: ref,
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

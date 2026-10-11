// 直接对网关做 HTTP 探测：拉取远端模型列表 + 单模型对话测试
const TEST_PROMPT = '请只回复两个字：成功';

// 出站 URL 拼接：baseUrl 来自本地配置文件，此处防御性校验只允许 http/https 协议
function joinUrl(base, p) {
  const u = new URL(String(base));
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不支持的 URL 协议: ${u.protocol}（仅允许 http/https）`);
  }
  return String(base).replace(/\/+$/, '') + p;
}

// 鉴权头：有 key 才注入（key 为空时不要发 "Bearer null" 之类的脏头）
function authHeaders(key, style) {
  const h = { 'content-type': 'application/json', accept: 'application/json' };
  if (!key) return h;
  if (style === 'anthropic-messages') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  } else {
    h.authorization = `Bearer ${key}`;
  }
  return h;
}

async function fetchJson(url, { method = 'GET', headers, body, timeoutMs = 30000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// 拉取远端模型列表（OpenAI 兼容 GET /models；兼容 data/models 数组、裸数组等响应形态）
// apiKey 缺省/为空时不注入鉴权头（由上游或网关自行判定）
async function listRemoteModels({ baseUrl, apiKey, style }) {
  const url = joinUrl(baseUrl, '/models');
  const headers = { accept: 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    if (style === 'anthropic-messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  }
  const { ok, status, text } = await fetchJson(url, { headers, timeoutMs: 20000 });
  if (!ok) {
    let snippet = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      snippet = j.error?.message || j.message || snippet;
    } catch {}
    throw new Error(`GET /models 失败 (HTTP ${status})：${snippet}`);
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('GET /models 返回的不是 JSON');
  }
  const arr = Array.isArray(j) ? j : j.data || j.models || j.result || [];
  const ids = arr
    .map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model))
    .filter((x) => typeof x === 'string' && x);
  return { models: [...new Set(ids)].sort(), total: ids.length };
}

// 单模型对话测试，返回 {ok, latencyMs, status, error?, snippet?}
async function testModel({ baseUrl, apiKey, style, modelId }) {
  const isAnthropic = style === 'anthropic-messages';
  const url = joinUrl(baseUrl, isAnthropic ? '/messages' : '/chat/completions');
  const body = isAnthropic
    ? { model: modelId, max_tokens: 100, messages: [{ role: 'user', content: TEST_PROMPT }] }
    : { model: modelId, max_tokens: 100, stream: false, messages: [{ role: 'user', content: TEST_PROMPT }] };
  const r = await fetchJson(url, {
    method: 'POST',
    headers: authHeaders(apiKey, style),
    body: JSON.stringify(body),
  });
  const base = { latencyMs: r.latencyMs, status: r.status };
  if (!r.ok) {
    let msg = r.text.slice(0, 400);
    try {
      const j = JSON.parse(r.text);
      msg = j.error?.message || j.message || j.error || msg;
    } catch {}
    return { ...base, ok: false, error: `HTTP ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` };
  }
  try {
    const j = JSON.parse(r.text);
    let snippet = '';
    if (isAnthropic) {
      snippet = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    } else {
      const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      snippet = m.content || m.reasoning_content || m.reasoning || '';
    }
    if (r.status === 200) return { ...base, ok: true, snippet: String(snippet).slice(0, 120) };
    return { ...base, ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ...base, ok: false, error: `响应解析失败: ${e.message}` };
  }
}

// 即时问答：与指定模型进行一次（或多轮）对话
// messages: [{role:'user'|'assistant'|'system', content:'...'}]
async function chatOnce({ baseUrl, apiKey, style, modelId, messages, timeoutMs = 120000, maxTokens = 2048 }) {
  const isAnthropic = style === 'anthropic-messages';
  const url = joinUrl(baseUrl, isAnthropic ? '/messages' : '/chat/completions');
  let body;
  if (isAnthropic) {
    // anthropic：system 独立字段，messages 只能是 user/assistant
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    body = {
      model: modelId,
      max_tokens: maxTokens,
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
      ...(system ? { system } : {}),
    };
  } else {
    body = { model: modelId, max_tokens: maxTokens, stream: false, messages };
  }
  const r = await fetchJson(url, {
    method: 'POST',
    headers: authHeaders(apiKey, style),
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (!r.ok) {
    let msg = r.text.slice(0, 500);
    try {
      const j = JSON.parse(r.text);
      msg = j.error?.message || j.message || j.error || msg;
    } catch {}
    throw new Error(`HTTP ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  const j = JSON.parse(r.text); // 解析失败会 throw，由调用方统一兜错
  let text = '';
  if (isAnthropic) {
    text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else {
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    text = m.content || m.reasoning_content || m.reasoning || '';
  }
  const usage = j.usage || null;
  return { text: String(text), latencyMs: r.latencyMs, usage };
}

// 流式对话（SSE）：返回 { gen: 异步生成器(yield {type:'text'|'end',...}), abort() }
// 兼容 OpenAI（data: {choices:[{delta:{content}}]} … [DONE]）与 Anthropic（content_block_delta / text_delta）两种流格式
function chatStream({ baseUrl, apiKey, style, modelId, messages, maxTokens = 2048, idleTimeoutMs = 120000 }) {
  const ctrl = new AbortController();
  let idleTimer = null;
  const touchIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(new Error('流式响应空闲超时')), idleTimeoutMs);
  };
  const gen = (async function* () {
    try {
      const isAnthropic = style === 'anthropic-messages';
      const url = joinUrl(baseUrl, isAnthropic ? '/messages' : '/chat/completions');
      let body;
      if (isAnthropic) {
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        body = {
          model: modelId,
          max_tokens: maxTokens,
          stream: true,
          messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
          ...(system ? { system } : {}),
        };
      } else {
        body = { model: modelId, max_tokens: maxTokens, stream: true, messages };
      }
      touchIdle();
      const res = await fetch(url, { method: 'POST', headers: authHeaders(apiKey, style), body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text.slice(0, 500);
        try {
          const j = JSON.parse(text);
          msg = j.error?.message || j.message || j.error || msg;
        } catch {}
        throw new Error(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      }
      if (!res.body) throw new Error('网关不支持流式响应');
      const started = Date.now();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let usage = null;
      let got = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        touchIdle();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue; // 忽略空行 / event: / 注释行
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || '网关流式返回错误');
          if (isAnthropic) {
            if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) {
              got = true;
              yield { type: 'text', text: j.delta.text };
            }
            if (j.type === 'message_start' && j.message?.usage) usage = { ...usage, ...j.message.usage };
            if (j.type === 'message_delta' && j.usage) usage = { ...usage, ...j.usage };
            if (j.type === 'error') throw new Error(j.error?.message || 'anthropic 流错误');
          } else {
            const ch = j.choices && j.choices[0];
            const d = ch && (ch.delta || ch.message);
            const piece = (d && (d.content || d.reasoning_content)) || '';
            if (piece) { got = true; yield { type: 'text', text: piece }; }
            if (j.usage) usage = j.usage;
          }
        }
      }
      yield { type: 'end', latencyMs: Date.now() - started, usage, empty: !got };
    } finally {
      clearTimeout(idleTimer);
    }
  })();
  return { gen, abort: () => ctrl.abort() };
}

module.exports = { listRemoteModels, testModel, chatOnce, chatStream, TEST_PROMPT };

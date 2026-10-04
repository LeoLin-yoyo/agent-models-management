// agent-models-management 前端
'use strict';

const $ = (s) => document.querySelector(s);

let overview = null; // {opencode:{configPath,providers:[]}, pi:{...}}
let selected = null; // {tool, id}
const testing = new Set(); // 正在测试的 `${tool}/${p}/${m}`
let providerModal = null; // {mode:'create'} | {mode:'edit', tool, id}
let syncData = null; // 远端同步暂存
let providerFilter = ''; // 侧栏 provider 模糊搜索（跨 opencode / pi）
let modelFilter = ''; // 当前 provider 内的模型模糊搜索
let crossSyncState = null; // 跨工具同步：{ plan, checked:Set, direction }
let bridgeState = null; // 桥接状态（/api/bridge/status）

// ---------- 工具函数 ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtRel(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString();
}

async function pool(items, limit, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    })
  );
}

function toast(msg, type = '') {
  const t = el('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 8000 : 4000);
}

// ---------- 数据 ----------
async function refresh() {
  const [ov, bs] = await Promise.all([
    api('/api/overview'),
    api('/api/bridge/status').catch(() => null),
  ]);
  overview = ov;
  bridgeState = bs;
  // 选中的 provider 被删掉则清空选中
  if (selected) {
    const prov = overview[selected.tool]?.providers.find((p) => p.id === selected.id);
    if (!prov) selected = null;
  }
  render();
}

function findProv(tool, id) {
  return overview?.[tool]?.providers.find((p) => p.id === id) || null;
}

// ---------- 渲染 ----------
function render() {
  renderSidebar();
  renderContent();
  renderBridgeChip();
  renderDefaultBtnTitle();
  updateBackTop();
}

// ---------- 默认模型 ----------
// overview[tool].defaultModel = { provider, model, thinkingLevel? } | null
function defaultModelStatus(tool) {
  const def = overview?.[tool]?.defaultModel;
  return def ? `${def.provider}/${def.model}` : '未设置';
}

function renderDefaultBtnTitle() {
  const btn = $('#btn-default-model');
  if (!btn) return;
  btn.title =
    '设置新会话默认使用的模型（当前）\n' +
    `opencode: ${defaultModelStatus('opencode')}\n` +
    `pi: ${defaultModelStatus('pi')}`;
}

async function setDefaultModel(tool, prov, m) {
  try {
    await api('/api/default-model', { tool, providerId: prov.id, modelId: m.id });
    toast(`已设为 ${tool} 新会话默认模型：${prov.id}/${m.id}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function clearDefaultModel(tool) {
  try {
    await api('/api/default-model', { tool, providerId: '', modelId: '' });
    toast(`已清除 ${tool} 的默认模型`, 'success');
    await refresh();
    if ($('#modal-default-model') && !$('#modal-default-model').classList.contains('hidden')) renderDefaultModal();
  } catch (e) {
    toast(e.message, 'error');
  }
}

let dmState = null; // 默认模型弹窗暂存：{ opencode:{providerId,modelId}, pi:{providerId,modelId,thinkingLevel} }

function openDefaultModal() {
  dmState = {};
  for (const tool of ['opencode', 'pi']) {
    const def = overview?.[tool]?.defaultModel;
    dmState[tool] = {
      providerId: def?.provider || '',
      modelId: def?.model || '',
      thinkingLevel: def?.thinkingLevel || '',
    };
  }
  renderDefaultModal();
  showModal('#modal-default-model');
}

function renderDefaultModal() {
  if (!dmState) return;
  const body = $('#dm-body');
  body.textContent = '';
  for (const tool of ['opencode', 'pi']) {
    const st = dmState[tool];
    const providers = overview?.[tool]?.providers || [];
    // provider 变了或已不存在时，模型选择随之失效
    const models = (providers.find((p) => p.id === st.providerId) || { models: [] }).models;
    if (st.modelId && !models.some((m) => m.id === st.modelId)) st.modelId = '';

    const providerSel = el(
      'select',
      { onchange: (e) => {
          st.providerId = e.target.value;
          // 单模型 provider 直接预选，省一次点击；否则清空待选
          const ms = (providers.find((p) => p.id === st.providerId) || { models: [] }).models;
          st.modelId = ms.length === 1 ? ms[0].id : '';
          renderDefaultModal();
        } },
      el('option', { value: '' }, providers.length ? '（选择 Provider）' : '（暂无 Provider）'),
      providers.map((p) => el('option', { value: p.id }, p.name === p.id ? p.id : `${p.name}（${p.id}）`))
    );
    providerSel.value = st.providerId;
    const modelSel = el(
      'select',
      // 重渲染以刷新保存按钮的可用状态（disabled 在渲染时计算）
      { onchange: (e) => { st.modelId = e.target.value; renderDefaultModal(); } },
      el('option', { value: '' }, '（选择模型）'),
      models.map((m) => el('option', { value: m.id }, m.name === m.id ? m.id : `${m.name}（${m.id}）`))
    );
    modelSel.value = st.modelId;

    const form = el('div', { class: 'form' },
      el('label', {}, el('span', { class: 'k' }, 'Provider'), providerSel),
      el('label', {}, el('span', { class: 'k' }, '模型'), modelSel),
    );
    if (tool === 'pi') {
      const thinkSel = el(
        'select',
        { onchange: (e) => { st.thinkingLevel = e.target.value; } },
        el('option', { value: '' }, '（不设置，跟随工具默认 medium）'),
        ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((l) => el('option', { value: l }, l))
      );
      thinkSel.value = st.thinkingLevel;
      form.append(el('label', {}, el('span', { class: 'k' }, '思考等级'), thinkSel));
    }

    const saveBtn = el('button', { class: 'btn primary', onclick: () => saveDefaultTool(tool) }, '保存');
    saveBtn.disabled = !st.modelId;
    const clearBtn = el('button', { class: 'btn danger', onclick: () => clearDefaultModel(tool) }, '清除默认');
    clearBtn.disabled = !overview?.[tool]?.defaultModel;

    body.append(
      el('div', { class: 'dm-tool' },
        el('h3', {}, tool, el('span', { class: 'dm-current' }, `当前：${defaultModelStatus(tool)}`)),
        form,
        el('div', { class: 'modal-actions dm-actions' }, saveBtn, clearBtn),
      )
    );
  }
}

async function saveDefaultTool(tool) {
  const st = dmState?.[tool];
  if (!st || !st.modelId) return;
  const body = { tool, providerId: st.providerId, modelId: st.modelId };
  if (tool === 'pi') body.thinkingLevel = st.thinkingLevel || null; // 空串 → 清除已存思考等级
  try {
    await api('/api/default-model', body);
    toast(`已设为 ${tool} 新会话默认模型：${st.providerId}/${st.modelId}`, 'success');
    await refresh();
    renderDefaultModal();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 回到顶部 ----------
const BACK_TOP_THRESHOLD = 300; // 滚动超过该距离才显示按钮
function updateBackTop() {
  const box = $('#content');
  $('#btn-back-top').classList.toggle('show', !!box && box.scrollTop > BACK_TOP_THRESHOLD);
}
$('#content').addEventListener('scroll', updateBackTop, { passive: true });
$('#btn-back-top').addEventListener('click', () => {
  $('#content').scrollTo({ top: 0, behavior: 'smooth' });
});

function renderSidebar() {
  const side = $('#sidebar');
  side.textContent = '';
  // 侧栏全局模糊搜索：跨 opencode / pi 过滤 provider
  const search = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '🔍 搜索 Provider（ID / 名称）',
    value: providerFilter,
    oninput: (e) => {
      // 整组重建后把焦点和光标还给输入框，避免打字断触
      const selStart = e.target.selectionStart;
      providerFilter = e.target.value;
      renderSidebar();
      const input = $('#sidebar input.search-input');
      if (input) {
        input.focus();
        const pos = Math.min(selStart, input.value.length);
        input.setSelectionRange(pos, pos);
      }
    },
  });
  side.append(search);
  const kw = providerFilter.trim().toLowerCase();
  for (const tool of ['opencode', 'pi']) {
    const data = overview?.[tool];
    const all = data?.providers || [];
    const hit = kw ? all.filter((p) => p.id.toLowerCase().includes(kw) || p.name.toLowerCase().includes(kw)) : all;
    if (kw && !hit.length) continue;
    const group = el('div', { class: 'side-group' }, el('h3', {}, tool));
    if (!hit.length) {
      group.append(el('div', { class: 'side-empty' }, '暂无 provider'));
    }
    for (const p of hit) {
      const item = el(
        'div',
        {
          class: `side-item${selected?.tool === tool && selected?.id === p.id ? ' active' : ''}`,
          onclick: () => { selected = { tool, id: p.id }; modelFilter = ''; render(); },
        },
        el('span', {}, p.name),
        el('span', { class: 'count' }, String(p.models.length))
      );
      group.append(item);
    }
    side.append(group);
  }
  if (kw && !side.querySelector('.side-group')) {
    side.append(el('div', { class: 'side-empty' }, `无匹配「${providerFilter.trim()}」的 provider`));
  }
}

function testBadge(tool, pid, m) {
  const key = `${tool}/${pid}/${m.id}`;
  if (testing.has(key)) {
    return el('span', { class: 'badge pending' }, el('span', { class: 'spin' }), '测试中');
  }
  const t = m.test;
  if (!t) return el('span', { class: 'badge none' }, '未测试');
  if (t.ok) {
    return el('span', { class: 'badge ok' },
      '✓', `${t.latencyMs}ms`,
      el('span', { class: 'via' }, t.via === 'cli' ? 'CLI' : 'API'));
  }
  return el('span', { class: 'badge fail', title: t.error || '' }, `✗ ${(t.error || '失败').slice(0, 60)}`);
}

function renderContent() {
  const box = $('#content');
  box.textContent = '';
  if (!selected) {
    box.append(
      el('div', { class: 'empty-tip' },
        '← 从左侧选择一个 Provider',
        el('br'),
        '支持：模型增删、拉取远端模型同步、API / CLI 一键测试')
    );
    return;
  }
  const prov = findProv(selected.tool, selected.id);
  if (!prov) return;

  // ---- Provider 信息卡 ----
  const styleLabel = prov.style === 'anthropic-messages' ? 'Anthropic 兼容' : 'OpenAI 兼容';
  box.append(
    el('div', { class: 'provider-card' },
      el('div', { class: 'provider-head' },
        el('h2', {}, prov.name),
        el('span', { class: 'tag' }, selected.tool),
        el('span', { class: `tag${prov.style === 'anthropic-messages' ? ' anthropic' : ''}` }, styleLabel),
        el('span', { class: 'tag' }, `id: ${prov.id}`),
        prov.bridge && prov.bridge.bridged
          ? el('span', { class: 'tag bridge', title: `经本地 QUIC 桥接转发\n上游：${prov.bridge.upstream || '未知'}\n路由：/${prov.bridge.routeId}/` }, '🌉 经桥接')
          : null,
        el('span', { class: 'spacer' }),
      ),
      el('div', { class: 'provider-meta' },
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'BaseURL'), el('span', { class: 'v mid' }, prov.baseUrl)),
        prov.bridge && prov.bridge.bridged
          ? el('div', { class: 'kv' }, el('span', { class: 'k' }, '上游地址'), el('span', { class: 'v mid' }, prov.bridge.originalBaseUrl || prov.bridge.upstream || '—'))
          : null,
        el('div', { class: 'kv' },
          el('span' , { class: 'k' }, 'API Key'),
          el('span', { class: 'v' }, `${prov.apiKeyMasked || '（无）'}　来源: ${prov.apiKeySource}`)),
      ),
      el('div', { class: 'provider-actions' },
        el('button', { class: 'btn primary', onclick: () => openSyncModal() }, '⟳ 拉取远端模型（同步）'),
        el('button', { class: 'btn', onclick: () => openProviderModal('edit') }, '编辑'),
        el('button', {
          class: 'btn',
          title: '把该 Provider 的请求经本地桥接（QUIC/HTTP3）转发，绕过 TCP 阻断；BaseURL 会被改写，可随时取消',
          onclick: () => toggleProviderBridge(prov),
        }, prov.bridge && prov.bridge.bridged ? '🌉 取消桥接' : '🌉 走桥接'),
        el('button', { class: 'btn danger', onclick: () => deleteProvider(prov) }, '删除 Provider'),
      ),
    )
  );

  // 模型模糊搜索（ID / 显示名，大小写不敏感）
  const kw = modelFilter.trim().toLowerCase();
  const hitModels = kw
    ? prov.models.filter((m) => m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw))
    : prov.models;

  // ---- 工具栏 ----
  box.append(
    el('div', { class: 'toolbar' },
      el('button', { class: 'btn', onclick: () => testProvider(prov, 'api', hitModels.map((m) => m.id)) }, '▶ 测试全部（API）'),
      el('button', { class: 'btn', onclick: () => openAddModelsModal(prov) }, '＋ 新增模型'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint' }, kw ? `命中 ${hitModels.length} / 共 ${prov.models.length} 个模型` : `${prov.models.length} 个模型`),
    )
  );

  // ---- 模型搜索框 ----
  if (prov.models.length) {
    const searchRow = el('div', { class: 'search-row' });
    searchRow.append(
      el('input', {
        class: 'search-input',
        type: 'search',
        placeholder: '🔍 模糊搜索模型（匹配 ID / 显示名，大小写不敏感）',
        value: modelFilter,
        oninput: (e) => {
          const pos = e.target.selectionStart;
          modelFilter = e.target.value;
          renderContent();
          const inp = $('#content input.search-input');
          if (inp) { inp.focus(); const p2 = Math.min(pos, inp.value.length); inp.setSelectionRange(p2, p2); }
        },
      })
    );
    if (kw) searchRow.append(el('button', { class: 'btn small', onclick: () => { modelFilter = ''; renderContent(); } }, '清空 ×'));
    box.append(searchRow);
  }

  // ---- 模型表 ----
  if (!prov.models.length) {
    box.append(el('div', { class: 'empty-tip' }, '该 Provider 还没有模型，点「拉取远端模型（同步）」或「新增模型」'));
    return;
  }
  if (kw && !hitModels.length) {
    box.append(el('div', { class: 'empty-tip' }, `没有匹配「${modelFilter.trim()}」的模型`));
    return;
  }
  const tbody = el('tbody');
  const defModel = overview?.[selected.tool]?.defaultModel;
  for (const m of hitModels) {
    const key = `${selected.tool}/${prov.id}/${m.id}`;
    const isDefault = !!(defModel && defModel.provider === prov.id && defModel.model === m.id);
    tbody.append(
      el('tr', { 'data-key': key },
        el('td', {}, testBadge(selected.tool, prov.id, m)),
        el('td', { class: 'mid' },
          isDefault ? el('span', { class: 'tag default', title: '新会话默认模型（点操作列「取消默认」可移除）' }, '⭐ 默认') : null,
          ` ${m.id}`),
        el('td', { class: 'mname' }, m.name),
        el('td', { class: 'mname' }, m.test ? fmtRel(m.test.checkedAt) : '—'),
        el('td', {},
          el('div', { class: 'row-actions' },
            isDefault
              ? el('button', { class: 'btn small star', title: '点击取消该工具的默认模型', onclick: () => clearDefaultModel(selected.tool) }, '★ 取消默认')
              : el('button', { class: 'btn small', title: '设为该工具新会话的默认模型', onclick: () => setDefaultModel(selected.tool, prov, m) }, '☆ 设为默认'),
            el('button', { class: 'btn small', title: '用该模型进行多轮对话', onclick: () => openChatModal(selected.tool, prov.id, m.id) }, '💬 即时问答'),
            el('button', { class: 'btn small', onclick: () => runTest(selected.tool, prov.id, m.id, 'api') }, 'API 测试'),
            el('button', { class: 'btn small', onclick: () => runTest(selected.tool, prov.id, m.id, 'cli') }, 'CLI 测试'),
            el('button', { class: 'btn small danger', onclick: () => deleteModel(prov, m) }, '删除'),
          ))
      )
    );
  }
  box.append(
    el('table', { class: 'models' },
      el('thead', {},
        el('tr', {},
          el('th', { style: 'width:170px' }, '状态'),
          el('th', {}, '模型 ID'),
          el('th', {}, '显示名'),
          el('th', { style: 'width:110px' }, '上次测试'),
          el('th', { style: 'width:330px' }, '操作'))),
      tbody)
  );
}

// ---------- 测试 ----------
async function runTest(tool, pid, mid, via) {
  const key = `${tool}/${pid}/${mid}`;
  testing.add(key);
  render();
  try {
    const { result } = await api('/api/test', { tool, providerId: pid, modelId: mid, via });
    const prov = findProv(tool, pid);
    const m = prov?.models.find((x) => x.id === mid);
    if (m) m.test = result;
    if (!result.ok) toast(`${tool}/${pid}/${mid} 测试失败：${result.error}`, 'error');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    testing.delete(key);
    render();
  }
}

async function testProvider(prov, via, onlyIds) {
  const set = Array.isArray(onlyIds) ? new Set(onlyIds) : null;
  const jobs = prov.models.filter((m) => !set || set.has(m.id)).map((m) => [selected.tool, prov.id, m.id]);
  toast(`开始测试 ${prov.name} 的 ${jobs.length} 个模型…`);
  await pool(jobs, 3, ([t, p, m]) => runTest(t, p, m, via));
}

async function testAll() {
  const jobs = [];
  for (const tool of ['opencode', 'pi']) {
    for (const p of overview?.[tool]?.providers || []) {
      for (const m of p.models) jobs.push([tool, p.id, m.id]);
    }
  }
  toast(`开始测试全部 ${jobs.length} 个模型…`);
  await pool(jobs, 3, ([t, p, m]) => runTest(t, p, m, 'api'));
  toast('全部测试完成');
}

// ---------- Provider 弹窗 ----------
function openProviderModal(mode) {
  providerModal = mode === 'edit' ? { mode, tool: selected.tool, id: selected.id } : { mode };
  const prov = mode === 'edit' ? findProv(selected.tool, selected.id) : null;
  $('#provider-modal-title').textContent = mode === 'edit' ? `编辑 Provider（${selected.tool}/${selected.id}）` : '新增 Provider';
  $('#pf-tool').value = mode === 'edit' ? selected.tool : 'opencode';
  $('#pf-tool').disabled = mode === 'edit';
  $('#pf-id').value = prov ? prov.id : '';
  $('#pf-name').value = prov ? prov.name : '';
  $('#pf-baseurl').value = prov ? prov.baseUrl : '';
  // 正在桥接的 provider：编辑框展示「原上游地址」，并提示实际请求地址
  const bh = $('#pf-baseurl-hint');
  if (bh) {
    if (prov && prov.bridge && prov.bridge.bridged) {
      $('#pf-baseurl').value = prov.bridge.originalBaseUrl || prov.bridge.upstream || prov.baseUrl;
      bh.style.display = '';
      bh.textContent = `该 Provider 正在经桥接（路由 /${prov.bridge.routeId}/），实际请求地址：${prov.baseUrl}。` +
        '这里编辑的是原上游地址，保存后会自动保持桥接（路由同步更新）。';
    } else {
      bh.style.display = 'none';
      bh.textContent = '';
    }
  }
  $('#pf-key').value = '';
  $('#pf-key').placeholder = prov ? `留空保持不变（当前 ${prov.apiKeyMasked || '无'}）` : 'sk-... 或 env:变量名';
  $('#pf-style').value = prov ? prov.style : 'openai-completions';
  $('#pf-key-hint-pi').style.display = $('#pf-tool').value === 'pi' ? '' : 'none';
  showModal('#modal-provider');
  if (mode === 'create') $('#pf-id').focus();
}

async function saveProvider() {
  const id = $('#pf-id').value.trim();
  const baseUrl = $('#pf-baseurl').value.trim();
  const name = $('#pf-name').value.trim();
  const apiKey = $('#pf-key').value.trim();
  const style = $('#pf-style').value;
  try {
    if (providerModal.mode === 'create') {
      const tool = $('#pf-tool').value;
      if (!id) throw new Error('请填写 Provider ID');
      if (!baseUrl) throw new Error('请填写 BaseURL');
      await api('/api/providers/create', { tool, id, name, baseUrl, apiKey, style });
      selected = { tool, id };
      toast(`已创建 ${tool}/${id}`, 'success');
    } else {
      const { tool, id: oldId } = providerModal;
      const patch = { name, baseUrl, style };
      if (apiKey) patch.apiKey = apiKey;
      if (id && id !== oldId) patch.newId = id;
      await api('/api/providers/update', { tool, id: oldId, patch });
      selected = { tool, id: patch.newId || oldId };
      toast('已保存', 'success');
    }
    hideModal('#modal-provider');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteProvider(prov) {
  if (!confirm(`确定删除 provider「${prov.name}」（${selected.tool}/${prov.id}）？\n删除前会自动备份配置文件。`)) return;
  try {
    const r = await api('/api/providers/delete', { tool: selected.tool, id: prov.id });
    if (r.defaultCleared) toast(`它是 ${selected.tool} 的默认模型来源，默认设置已一并清除`, 'success');
    toast(`已删除 ${selected.tool}/${prov.id}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 新增模型弹窗 ----------
function openAddModelsModal(prov) {
  $('#add-models-target').textContent = `目标：${selected.tool}/${prov.id}`;
  $('#add-models-input').value = '';
  showModal('#modal-add-models');
}

async function saveAddModels() {
  const lines = $('#add-models-input').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const models = [];
  for (const line of lines) {
    const [id, name] = line.split('|').map((s) => s.trim());
    if (id) models.push({ id, name: name || id });
  }
  if (!models.length) { toast('请至少填写一个模型 ID', 'error'); return; }
  const prov = findProv(selected.tool, selected.id);
  try {
    const { added } = await api('/api/models/add', { tool: selected.tool, providerId: selected.id, models });
    toast(`已添加 ${added.length} 个模型${models.length - added.length ? `（${models.length - added.length} 个已存在被跳过）` : ''}`, 'success');
    hideModal('#modal-add-models');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteModel(prov, m) {
  if (!confirm(`确定从 ${selected.tool}/${prov.id} 删除模型「${m.id}」？`)) return;
  try {
    const r = await api('/api/models/delete', { tool: selected.tool, providerId: prov.id, modelIds: [m.id] });
    if (r.defaultCleared) toast(`它是 ${selected.tool} 的默认模型，默认设置已一并清除`, 'success');
    toast(`已删除 ${m.id}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 桥接 ----------
function renderBridgeChip() {
  const chip = $('#bridge-chip');
  if (!chip) return;
  const st = bridgeState;
  if (!st || !st.ok) {
    chip.className = 'chip unknown';
    chip.textContent = '🌉 桥接 ?';
    chip.title = '无法获取桥接状态（服务未响应？）';
    return;
  }
  const up = !!st.reachable;
  chip.className = 'chip ' + (up ? 'ok' : 'warn');
  chip.textContent = up ? `🌉 桥接 :${st.port} · ${st.routes.length} 路由` : '🌉 桥接未运行';
  chip.title = up
    ? `监听 http://127.0.0.1:${st.port}（pid ${st.pid || '外部进程'}）\n` +
      st.routes.map((r) => `  /${r.id}/  ->  ${r.upstream}`).join('\n')
    : '点击查看详情 / 启动桥接';
}

async function toggleProviderBridge(prov) {
  const bridged = !!(prov.bridge && prov.bridge.bridged);
  const tip = bridged
    ? `取消桥接：BaseURL 将恢复为原上游地址\n${prov.bridge.upstream || ''}`
    : `开启桥接：将把 BaseURL 改写为本地桥接地址（请求经 QUIC/HTTP3 转发到 ${prov.baseUrl}）\n原地址会记录在桥接配置中，可随时取消。`;
  if (!confirm(tip)) return;
  try {
    const r = await api('/api/bridge/toggle', { tool: selected.tool, providerId: prov.id, enabled: !bridged });
    toast(!bridged
      ? `已开启桥接：${r.upstream} -> 127.0.0.1 桥接（新 BaseURL：${r.baseUrl}）`
      : `已取消桥接，BaseURL 恢复为 ${r.baseUrl}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openBridgeModal() {
  renderBridgeModal();
  showModal('#modal-bridge');
}

function renderBridgeModal() {
  const body = $('#bridge-body');
  body.textContent = '';
  const st = bridgeState;
  if (!st || !st.ok) {
    body.append(el('p', { class: 'hint' }, '无法获取桥接状态，请确认服务正常后重试。'));
    return;
  }
  const statusText = st.reachable
    ? `运行中${st.pid ? `（pid ${st.pid}）` : '（外部进程）'}`
    : (st.running ? '进程存在但无响应（正在重启？）' : '未运行');
  body.append(
    el('div', { class: 'provider-meta' },
      el('div', { class: 'kv' }, el('span', { class: 'k' }, '状态'), el('span', { class: 'v' }, statusText)),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, '监听地址'), el('span', { class: 'v mid' }, `http://127.0.0.1:${st.port}`)),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Python'), el('span', { class: 'v mid' }, st.python || '—')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, '配置文件'), el('span', { class: 'v mid' }, st.configFile || '—')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, '运行日志'), el('span', { class: 'v mid' }, st.logFile || '—')),
    )
  );
  const routes = st.routes || [];
  body.append(el('h4', { style: 'margin-top:16px' }, `路由（${routes.length}）`));
  if (!routes.length) {
    body.append(el('p', { class: 'hint' }, '暂无路由 —— 在 Provider 卡片点「🌉 走桥接」即可添加'));
  } else {
    const list = el('div', { class: 'sync-list' });
    for (const r of routes) {
      list.append(
        el('div', { class: 'sync-row' },
          el('span', { class: 'mid' }, `/${r.id}/`),
          el('span', { class: 'sub' }, `${r.upstream || '?'}${r.tool ? `  ·  ${r.tool}/${r.providerId}` : ''}`))
      );
    }
    body.append(list);
  }
  $('#btn-bridge-power').textContent = st.reachable ? '停止桥接' : '启动桥接';
}

async function bridgePower() {
  const up = !!(bridgeState && bridgeState.reachable);
  try {
    if (up) {
      if (!confirm('停止桥接后，所有走桥接的 Provider 将无法访问，确定？')) return;
      await api('/api/bridge/stop', {});
      toast('桥接已停止', 'success');
    } else {
      await api('/api/bridge/start', {});
      toast('桥接已启动', 'success');
    }
    await refresh();
    renderBridgeModal();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 即时问答 ----------
let chatState = null; // { tool, providerId, modelId, messages: [{role, content}] }

function openChatModal(tool, providerId, modelId) {
  const prov = findProv(tool, providerId);
  if (!prov) return;
  const hasKey = prov.apiKeyMasked && prov.apiKeyMasked !== '未设置';
  if (!hasKey && !confirm(`该 provider 未配置 API Key，直接对话大概率会失败，仍要继续吗？`)) return;
  chatState = { tool, providerId, modelId, messages: [], generating: false };
  $('#chat-model-label').textContent = `${tool}/${providerId} · ${modelId}`;
  $('#chat-log').textContent = '';
  $('#chat-input').value = '';
  $('#btn-chat-send').disabled = true;
  showModal('#modal-chat');
  $('#chat-input').focus();
}

function chatScrollBottom() {
  const box = $('#chat-log');
  box.scrollTop = box.scrollHeight;
}

function chatAppendMsg(role, cls) {
  const bubble = el('div', { class: `chat-msg ${role} ${cls || ''}` });
  $('#chat-log').append(bubble);
  chatScrollBottom();
  return bubble;
}

async function chatSend() {
  if (!chatState || chatState.generating) return;
  const input = $('#chat-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  const sendBtn = $('#btn-chat-send');
  sendBtn.disabled = true;

  chatState.messages.push({ role: 'user', content });
  const userBubble = chatAppendMsg('user');
  userBubble.textContent = content;

  // 流式气泡：增量实时追加；「…」占位符在收到首个增量/出错时移除
  const pending = chatAppendMsg('assistant');
  const textNode = document.createTextNode('');
  const ph = el('span', { class: 'chat-meta' }, '…');
  pending.append(textNode, ph);
  chatState.generating = true;

  let full = '';
  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: chatState.tool,
        providerId: chatState.providerId,
        modelId: chatState.modelId,
        messages: chatState.messages,
      }),
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      // 校验阶段失败：仍是 JSON 错误响应
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let meta = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.t) {
          if (!full) ph.remove();
          full += ev.t;
          textNode.textContent = full;
          chatScrollBottom();
        } else if (ev.error) {
          throw new Error(ev.error);
        } else if (ev.done) {
          meta = ev;
        }
      }
    }
    chatState.messages.push({ role: 'assistant', content: full });
    ph.remove();
    if (!full) {
      pending.classList.add('error');
      textNode.textContent = '（模型返回了空内容）';
    } else {
      pending.append(el('div', { class: 'chat-meta' },
        `${((meta?.latencyMs || 0) / 1000).toFixed(1)}s${meta?.usage?.total_tokens ? ` · ${meta.usage.total_tokens} tokens` : ''}`));
    }
  } catch (e) {
    ph.remove();
    pending.classList.add('error');
    if (full) pending.append(el('div', { class: 'chat-meta' }, `（收到 ${full.length} 字后中断：${e.message}）`));
    else textNode.textContent = `✗ ${e.message}`;
  } finally {
    chatState.generating = false;
    ph.remove();
    sendBtn.disabled = !$('#chat-input').value.trim();
    $('#chat-input').focus();
    chatScrollBottom();
  }
}

// ---------- 远端同步弹窗 ----------
async function openSyncModal() {
  const prov = findProv(selected.tool, selected.id);
  $('#sync-provider-label').textContent = `${selected.tool}/${prov.id}`;
  $('#sync-body').textContent = '';
  $('#sync-body').append(el('p', { class: 'hint' }, '正在拉取远端模型列表…'));
  $('#btn-sync-apply').style.display = 'none';
  syncData = null;
  showModal('#modal-sync');
  try {
    syncData = await api(`/api/providers/remote-models?tool=${encodeURIComponent(selected.tool)}&provider=${encodeURIComponent(prov.id)}`);
    renderSyncBody(prov);
  } catch (e) {
    $('#sync-body').textContent = '';
    $('#sync-body').append(el('p', { class: 'hint' }, `拉取失败：${e.message}`, el('br'), '部分网关不支持 /models 列表接口，可改用「新增模型」手动填写。'));
  }
}

function renderSyncBody(prov) {
  const body = $('#sync-body');
  body.textContent = '';
  const { added, removed, remote, configured } = syncData;
  const addedSet = new Set();
  const removedSet = new Set();

  const mkSection = (title, ids, checkedByDefault, cls, applySet) => {
    if (!ids.length) return null;
    const list = el('div', { class: 'sync-list' });
    for (const id of ids) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = checkedByDefault;
      cb.addEventListener('change', () => {
        if (cb.checked) applySet.add(id); else applySet.delete(id);
        updateApplyBtn();
      });
      if (checkedByDefault) applySet.add(id);
      // data-mid：顶部搜索框按模型 ID 过滤行时用
      list.append(el('label', { class: `sync-row ${cls}`, 'data-mid': id }, cb, el('span', { class: 'mid' }, id)));
    }
    const section = el('div', { class: 'sync-section' });
    // 全选/全不选：只作用于本区当前搜索可见的行，避免误伤被过滤隐藏的项与另一个区
    const bar = el('div', { class: 'sync-tools' },
      el('label', { class: 'hint check-all' },
        el('input', { type: 'checkbox', onchange: (e) => {
          for (const row of section.querySelectorAll('.sync-row')) {
            if (row.style.display === 'none') continue;
            const cb2 = row.querySelector('input[type=checkbox]');
            const mid = row.dataset.mid;
            cb2.checked = e.target.checked;
            if (cb2.checked) applySet.add(mid); else applySet.delete(mid);
          }
          updateApplyBtn();
        } }),
        ' 全选/全不选（当前可见）'),
      el('span', { class: 'hint n-hit' }, '')
    );
    section.append(el('h4', {}, title, el('span', { class: 'n' }, `${ids.length} 个`)), bar, list);
    return section;
  };

  const secAdd = mkSection('➕ 远端新增（API 有、配置里没有）', added, true, '', addedSet);
  const secDel = mkSection('➖ 远端未列出（可能已下线）', removed, false, 'removed', removedSet);

  if (secAdd) body.append(secAdd);
  if (secDel) body.append(secDel);
  if (!secAdd && !secDel) {
    body.append(el('p', { class: 'sync-ok' }, `✓ 远端 ${remote.length} 个模型与本地配置（${configured.length} 个）完全一致，无需变更`));
  }

  // 搜索框过滤：同时作用于「远端新增」「远端未列出」两个列表
  const filterInput = $('#sync-filter');
  filterInput.value = '';
  filterInput.oninput = () => {
    const kw = filterInput.value.trim().toLowerCase();
    let hits = 0;
    for (const row of body.querySelectorAll('.sync-row')) {
      const mid = row.dataset.mid || '';
      const match = !kw || mid.toLowerCase().includes(kw);
      row.style.display = match ? '' : 'none';
      if (match) hits++;
    }
    for (const badge of body.querySelectorAll('.n-hit')) {
      badge.textContent = kw ? `命中 ${hits} 个` : '';
    }
  };

  updateApplyBtn();

  function updateApplyBtn() {
    const n = addedSet.size + removedSet.size;
    const btn = $('#btn-sync-apply');
    btn.style.display = '';
    btn.textContent = n ? `应用 ${addedSet.size} 个新增 / ${removedSet.size} 个删除` : '应用（未勾选任何变更）';
    btn.disabled = n === 0;
  }

  syncData._addedSet = addedSet;
  syncData._removedSet = removedSet;
}

async function applySync() {
  if (!syncData) return;
  const addIds = [...syncData._addedSet].map((id) => ({ id, name: id }));
  const delIds = [...syncData._removedSet];
  try {
    let added = [], removed = [];
    if (addIds.length) added = (await api('/api/models/add', { tool: selected.tool, providerId: selected.id, models: addIds })).added;
    if (delIds.length) removed = (await api('/api/models/delete', { tool: selected.tool, providerId: selected.id, modelIds: delIds })).removed;
    toast(`同步完成：新增 ${added.length}，删除 ${removed.length}`, 'success');
    hideModal('#modal-sync');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 跨工具同步弹窗（opencode ⇄ pi） ----------
function openCrossSyncModal() {
  crossSyncState = null;
  $('#cs-direction').value = 'pi->opencode';
  $('#cs-filter').value = '';
  $('#btn-cs-apply').style.display = 'none';
  showModal('#modal-cross-sync');
  loadCsPlan();
}

async function loadCsPlan() {
  const direction = $('#cs-direction').value;
  const body = $('#cs-body');
  body.textContent = '';
  body.append(el('p', { class: 'hint' }, '正在计算差异…'));
  $('#btn-cs-apply').style.display = 'none';
  try {
    crossSyncState = await api(`/api/cross-sync/plan?direction=${encodeURIComponent(direction)}`);
    // 默认全选（源端存在的 provider）
    crossSyncState.checked = new Set(crossSyncState.items.filter((x) => x.action !== 'missing').map((x) => x.id));
    renderCsBody();
  } catch (e) {
    body.textContent = '';
    body.append(el('p', { class: 'hint' }, `预检失败：${e.message}`));
  }
}

function renderCsBody() {
  const body = $('#cs-body');
  body.textContent = '';
  if (!crossSyncState) { body.append(el('p', { class: 'hint' }, '请先选择同步方向')); return; }
  const { source, target, items, checked } = crossSyncState;
  const list = el('div', { class: 'sync-list' });
  for (const it of items) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = checked.has(it.id);
    if (it.action === 'missing') cb.disabled = true; // 源端不存在，不可勾选
    cb.addEventListener('change', () => {
      if (cb.checked) checked.add(it.id); else checked.delete(it.id);
      updateCsBtn();
    });
    const tag = it.action === 'overwrite'
      ? `覆盖更新（目标现有 ${it.targetModels} 个模型 → 以源端 ${it.sourceModels} 个为准）`
      : it.action === 'create'
        ? `新建（${it.sourceModels} 个模型）`
        : '源端不存在，不会执行';
    const notes = it.notes && it.notes.length ? ` · ${it.notes.join('；')}` : '';
    // data-pid：同时含 ID 与名称（小写），供搜索框模糊过滤
    list.append(
      el('label', { class: `sync-row${it.action === 'missing' ? ' removed' : ''}`, 'data-pid': `${it.id} ${it.sourceName || ''}`.toLowerCase() },
        cb,
        el('span', { class: 'mid' }, `${it.sourceName || it.id}（${it.id}）`),
        el('span', { class: 'sub' }, tag + notes))
    );
  }
  const nOverwrite = items.filter((x) => x.action === 'overwrite').length;
  const nCreate = items.filter((x) => x.action === 'create').length;
  body.append(
    el('div', { class: 'sync-section' },
      el('h4', {}, `${source} → ${target}`, el('span', { class: 'n' }, `${items.length} 个 provider`)),
      list),
    el('p', { class: 'hint' }, `预检结果：新建 ${nCreate} 个、覆盖更新 ${nOverwrite} 个。写入前自动备份目标端配置文件。`)
  );
  updateCsBtn();

  function updateCsBtn() {
    const btn = $('#btn-cs-apply');
    btn.style.display = '';
    const n = checked.size;
    btn.textContent = n ? `执行同步（已选 ${n} 个）` : '执行同步（未选择）';
    btn.disabled = n === 0;
  }
  crossSyncState._updateBtn = updateCsBtn;
}

function applyCsFilter() {
  const kw = $('#cs-filter').value.trim().toLowerCase();
  let hits = 0;
  for (const row of $('#cs-body').querySelectorAll('.sync-row')) {
    const match = !kw || (row.dataset.pid || '').includes(kw);
    row.style.display = match ? '' : 'none';
    if (match) hits++;
  }
}

async function applyCrossSync() {
  if (!crossSyncState || !crossSyncState.checked.size) return;
  const direction = $('#cs-direction').value;
  const ids = [...crossSyncState.checked];
  const target = crossSyncState.target;
  if (!confirm(`确定向「${target}」同步 ${ids.length} 个 provider？\n已存在的同 ID provider 会被覆盖更新（BaseURL / 接口类型 / 模型以源端为准），写入前自动备份。`)) return;
  const btn = $('#btn-cs-apply');
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const r = await api('/api/cross-sync/apply', { direction, providers: ids });
    const s = r.summary;
    const lines = r.results.map((x) =>
      x.ok ? `✓ ${x.id}（${x.action === 'create' ? '新建' : '覆盖'}，${x.models} 个模型，${x.keyNote}）` : `✗ ${x.id}：${x.error}`
    );
    toast(`跨工具同步完成：新建 ${s.created}，覆盖 ${s.overwritten}${s.failed ? `，失败 ${s.failed}` : ''}\n${lines.join('\n')}`, s.failed ? 'error' : 'success');
    hideModal('#modal-cross-sync');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
    crossSyncState._updateBtn && crossSyncState._updateBtn();
  }
}

// ---------- 弹窗通用 ----------
function showModal(sel) { $(sel).classList.remove('hidden'); }
function hideModal(sel) { $(sel).classList.add('hidden'); }

document.querySelectorAll('.modal-overlay').forEach((ov) => {
  // 带 data-persist 的弹窗（即时问答）：点击外部空白不关闭，避免误触丢对话
  ov.addEventListener('mousedown', (e) => { if (e.target === ov && !ov.hasAttribute('data-persist')) ov.classList.add('hidden'); });
});
document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => b.closest('.modal-overlay').classList.add('hidden'));
});
document.addEventListener('keydown', (e) => {
  // ESC 同样不关闭 data-persist 弹窗（防误按丢上下文）
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => { if (!m.hasAttribute('data-persist')) m.classList.add('hidden'); });
});

// ---------- 事件绑定 ----------
$('#btn-refresh').addEventListener('click', () => refresh().then(() => toast('已刷新', 'success')).catch((e) => toast(e.message, 'error')));
$('#btn-add-provider').addEventListener('click', () => openProviderModal('create'));
$('#btn-test-all').addEventListener('click', () => testAll().catch((e) => toast(e.message, 'error')));
$('#btn-provider-save').addEventListener('click', saveProvider);
$('#btn-add-models-save').addEventListener('click', saveAddModels);
$('#btn-sync-apply').addEventListener('click', applySync);
$('#btn-cross-sync').addEventListener('click', openCrossSyncModal);
$('#btn-default-model').addEventListener('click', openDefaultModal);
$('#bridge-chip').addEventListener('click', openBridgeModal);
$('#btn-bridge-power').addEventListener('click', bridgePower);
$('#btn-cs-plan').addEventListener('click', () => loadCsPlan().catch((e) => toast(e.message, 'error')));
$('#btn-cs-apply').addEventListener('click', applyCrossSync);
$('#cs-direction').addEventListener('change', () => loadCsPlan().catch((e) => toast(e.message, 'error')));
$('#cs-filter').addEventListener('input', applyCsFilter);
$('#btn-chat-send').addEventListener('click', chatSend);
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
});
$('#chat-input').addEventListener('input', () => {
  $('#btn-chat-send').disabled = !$('#chat-input').value.trim() || !chatState;
});
$('#btn-chat-clear').addEventListener('click', () => {
  if (chatState) chatState.messages = [];
  $('#chat-log').textContent = '';
  $('#chat-input').focus();
});
$('#pf-tool').addEventListener('change', () => {
  $('#pf-key-hint-pi').style.display = $('#pf-tool').value === 'pi' ? '' : 'none';
});

refresh().catch((e) => toast(`加载失败: ${e.message}`, 'error'));

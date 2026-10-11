// 模型配置视图：opencode / pi 的 Provider 与模型管理（原主界面逻辑）
// 桥接相关内容已全部移出到「桥接管理」视图：这里的桥接 Provider 只读展示标签，修改请到桥接管理。
'use strict';
import { $, el, api, toast, fmtRel, pool, testBadge, showModal, hideModal } from './util.js';
import { state, refresh, findProv, switchTab } from './state.js';
import { renderSyncDiff } from './syncDiff.js';
import { openChatModal } from './chat.js';

let providerModal = null; // {mode:'create'} | {mode:'edit', tool, id}
let syncData = null;      // 远端同步暂存
let syncSets = null;      // { addedSet, removedSet }
let dmState = null;       // 默认模型弹窗暂存

// ---------- 渲染 ----------
export function render() {
  renderSidebar();
  renderContent();
}

export function renderDefaultBtnTitle() {
  const btn = $('#btn-default-model');
  if (!btn) return;
  btn.title =
    '设置新会话默认使用的模型（当前）\n' +
    `opencode: ${defaultModelStatus('opencode')}\n` +
    `pi: ${defaultModelStatus('pi')}`;
}

function defaultModelStatus(tool) {
  const def = state.overview?.[tool]?.defaultModel;
  return def ? `${def.provider}/${def.model}` : '未设置';
}

// ---------- 侧栏 ----------
function renderSidebar() {
  const side = $('#sidebar');
  side.textContent = '';
  // 侧栏全局模糊搜索：跨 opencode / pi 过滤 provider
  const search = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '🔍 搜索 Provider（ID / 名称）',
    value: state.providerFilter,
    oninput: (e) => {
      // 整组重建后把焦点和光标还给输入框，避免打字断触
      const selStart = e.target.selectionStart;
      state.providerFilter = e.target.value;
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
  const kw = state.providerFilter.trim().toLowerCase();
  for (const tool of ['opencode', 'pi']) {
    const data = state.overview?.[tool];
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
          class: `side-item${state.selected?.tool === tool && state.selected?.id === p.id ? ' active' : ''}`,
          onclick: () => { state.selected = { tool, id: p.id }; state.modelFilter = ''; refreshView(); },
        },
        el('span', {}, p.name),
        el('span', { class: 'count' }, String(p.models.length))
      );
      group.append(item);
    }
    side.append(group);
  }
  if (kw && !side.querySelector('.side-group')) {
    side.append(el('div', { class: 'side-empty' }, `无匹配「${state.providerFilter.trim()}」的 provider`));
  }
}

// 本视图内部状态变化（选中/搜索/测试中）的重绘入口
function refreshView() {
  render();
}

// ---------- 内容区 ----------
function renderContent() {
  const box = $('#content');
  box.textContent = '';
  if (!state.selected) {
    box.append(
      el('div', { class: 'empty-tip' },
        '← 从左侧选择一个 Provider',
        el('br'),
        '支持：模型增删、拉取远端模型同步、API / CLI 一键测试',
        el('br'),
        '需要走桥接的 API 统一在「🌉 桥接管理」里配置与同步')
    );
    return;
  }
  const prov = findProv(state.selected.tool, state.selected.id);
  if (!prov) return;

  // ---- Provider 信息卡 ----
  const styleLabel = prov.style === 'anthropic-messages' ? 'Anthropic 兼容' : 'OpenAI 兼容';
  const bridged = prov.bridge && prov.bridge.bridged;
  box.append(
    el('div', { class: 'provider-card' },
      el('div', { class: 'provider-head' },
        el('h2', {}, prov.name),
        el('span', { class: 'tag' }, state.selected.tool),
        el('span', { class: `tag${prov.style === 'anthropic-messages' ? ' anthropic' : ''}` }, styleLabel),
        el('span', { class: 'tag' }, `id: ${prov.id}`),
        bridged
          ? el('span', {
              class: 'tag bridge',
              title: prov.bridge.bridgeProviderId
                ? `由「桥接管理」的桥接模型「${prov.bridge.bridgeProviderId}」同步生成\n上游：${prov.bridge.originalBaseUrl || prov.bridge.upstream || '未知'}\n（在本页对地址/Key/模型的改动，会在下次同步时被覆盖）`
                : `经本地 QUIC 桥接转发（未纳管）\n上游：${prov.bridge.upstream || '未知'}\n路由：/${prov.bridge.routeId}/`,
            }, prov.bridge.bridgeProviderId ? '🌉 桥接同步' : '🌉 经桥接')
          : null,
        el('span', { class: 'spacer' }),
      ),
      el('div', { class: 'provider-meta' },
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'BaseURL'), el('span', { class: 'v mid' }, prov.baseUrl)),
        bridged
          ? el('div', { class: 'kv' }, el('span', { class: 'k' }, '上游地址'), el('span', { class: 'v mid' }, prov.bridge.originalBaseUrl || prov.bridge.upstream || '—'))
          : null,
        el('div', { class: 'kv' },
          el('span', { class: 'k' }, 'API Key'),
          el('span', { class: 'v' }, `${prov.apiKeyMasked || '（无）'}　来源: ${prov.apiKeySource}`)),
      ),
      el('div', { class: 'provider-actions' },
        el('button', { class: 'btn primary', onclick: () => openSyncModal() }, '⟳ 拉取远端模型（同步）'),
        el('button', { class: 'btn', onclick: () => openProviderModal('edit') }, '编辑'),
        bridged
          ? el('button', {
              class: 'btn',
              title: '桥接模型在「桥接管理」模块中统一维护',
              onclick: () => switchTab('bridge', { bSelected: prov.bridge.bridgeProviderId || undefined }),
            }, '🌉 在桥接管理中查看')
          : null,
        el('button', { class: 'btn danger', onclick: () => deleteProvider(prov) }, '删除 Provider'),
      ),
    )
  );

  // 模型模糊搜索（ID / 显示名，大小写不敏感）
  const kw = state.modelFilter.trim().toLowerCase();
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
        value: state.modelFilter,
        oninput: (e) => {
          const pos = e.target.selectionStart;
          state.modelFilter = e.target.value;
          renderContent();
          const inp = $('#content input.search-input');
          if (inp) { inp.focus(); const p2 = Math.min(pos, inp.value.length); inp.setSelectionRange(p2, p2); }
        },
      })
    );
    if (kw) searchRow.append(el('button', { class: 'btn small', onclick: () => { state.modelFilter = ''; renderContent(); } }, '清空 ×'));
    box.append(searchRow);
  }

  // ---- 模型表 ----
  if (!prov.models.length) {
    box.append(el('div', { class: 'empty-tip' }, '该 Provider 还没有模型，点「拉取远端模型（同步）」或「新增模型」'));
    return;
  }
  if (kw && !hitModels.length) {
    box.append(el('div', { class: 'empty-tip' }, `没有匹配「${state.modelFilter.trim()}」的模型`));
    return;
  }
  const tbody = el('tbody');
  const defModel = state.overview?.[state.selected.tool]?.defaultModel;
  for (const m of hitModels) {
    const key = `${state.selected.tool}/${prov.id}/${m.id}`;
    const isDefault = !!(defModel && defModel.provider === prov.id && defModel.model === m.id);
    tbody.append(
      el('tr', { 'data-key': key },
        el('td', {}, testBadge(key, m.test, state.testing)),
        el('td', { class: 'mid' },
          isDefault ? el('span', { class: 'tag default', title: '新会话默认模型（点操作列「取消默认」可移除）' }, '⭐ 默认') : null,
          ` ${m.id}`),
        el('td', { class: 'mname' }, m.name),
        el('td', { class: 'mname' }, m.test ? fmtRel(m.test.checkedAt) : '—'),
        el('td', {},
          el('div', { class: 'row-actions' },
            isDefault
              ? el('button', { class: 'btn small star', title: '点击取消该工具的默认模型', onclick: () => clearDefaultModel(state.selected.tool) }, '★ 取消默认')
              : el('button', { class: 'btn small', title: '设为该工具新会话的默认模型', onclick: () => setDefaultModel(state.selected.tool, prov, m) }, '☆ 设为默认'),
            el('button', { class: 'btn small', title: '用该模型进行多轮对话', onclick: () => openChatModal(state.selected.tool, prov.id, m.id) }, '💬 即时问答'),
            el('button', { class: 'btn small', onclick: () => runTest(state.selected.tool, prov.id, m.id, 'api') }, 'API 测试'),
            el('button', { class: 'btn small', onclick: () => runTest(state.selected.tool, prov.id, m.id, 'cli') }, 'CLI 测试'),
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
  state.testing.add(key);
  refreshView();
  try {
    const { result } = await api('/api/test', { tool, providerId: pid, modelId: mid, via });
    const prov = findProv(tool, pid);
    const m = prov?.models.find((x) => x.id === mid);
    if (m) m.test = result;
    if (!result.ok) toast(`${tool}/${pid}/${mid} 测试失败：${result.error}`, 'error');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.testing.delete(key);
    refreshView();
  }
}

async function testProvider(prov, via, onlyIds) {
  const set = Array.isArray(onlyIds) ? new Set(onlyIds) : null;
  const jobs = prov.models.filter((m) => !set || set.has(m.id)).map((m) => [state.selected.tool, prov.id, m.id]);
  toast(`开始测试 ${prov.name} 的 ${jobs.length} 个模型…`);
  await pool(jobs, 3, ([t, p, m]) => runTest(t, p, m, via));
}

export async function testAll() {
  const jobs = [];
  for (const tool of ['opencode', 'pi']) {
    for (const p of state.overview?.[tool]?.providers || []) {
      for (const m of p.models) jobs.push([tool, p.id, m.id]);
    }
  }
  toast(`开始测试全部 ${jobs.length} 个模型…`);
  await pool(jobs, 3, ([t, p, m]) => runTest(t, p, m, 'api'));
  toast('全部测试完成');
}

// ---------- Provider 弹窗 ----------
export function openProviderModal(mode) {
  providerModal = mode === 'edit' ? { mode, tool: state.selected.tool, id: state.selected.id } : { mode };
  const prov = mode === 'edit' ? findProv(state.selected.tool, state.selected.id) : null;
  $('#provider-modal-title').textContent = mode === 'edit' ? `编辑 Provider（${state.selected.tool}/${state.selected.id}）` : '新增 Provider';
  $('#pf-tool').value = mode === 'edit' ? state.selected.tool : 'opencode';
  $('#pf-tool').disabled = mode === 'edit';
  $('#pf-id').value = prov ? prov.id : '';
  $('#pf-name').value = prov ? prov.name : '';
  $('#pf-baseurl').value = prov ? prov.baseUrl : '';
  // 正在桥接的 provider：说明由桥接管理模块维护（地址按同步结果展示，不在此处回写上游）
  const bh = $('#pf-baseurl-hint');
  if (bh) {
    if (prov && prov.bridge && prov.bridge.bridged) {
      bh.style.display = '';
      bh.textContent = prov.bridge.bridgeProviderId
        ? `该 Provider 由「桥接管理」的桥接模型「${prov.bridge.bridgeProviderId}」同步生成，实际请求地址经本地桥接（上游：${prov.bridge.originalBaseUrl || prov.bridge.upstream || '—'}）。` +
          '地址 / Key / 模型的修改请在「桥接管理」里操作；在本页修改会在下次同步时被覆盖。'
        : `该 Provider 正在经桥接（路由 /${prov.bridge.routeId}/）。`;
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
      state.selected = { tool, id };
      toast(`已创建 ${tool}/${id}`, 'success');
    } else {
      const { tool, id: oldId } = providerModal;
      const patch = { name, baseUrl, style };
      if (apiKey) patch.apiKey = apiKey;
      if (id && id !== oldId) patch.newId = id;
      await api('/api/providers/update', { tool, id: oldId, patch });
      state.selected = { tool, id: patch.newId || oldId };
      toast('已保存', 'success');
    }
    hideModal('#modal-provider');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteProvider(prov) {
  if (!confirm(`确定删除 provider「${prov.name}」（${state.selected.tool}/${prov.id}）？\n删除前会自动备份配置文件。`)) return;
  try {
    const r = await api('/api/providers/delete', { tool: state.selected.tool, id: prov.id });
    if (r.defaultCleared) toast(`它是 ${state.selected.tool} 的默认模型来源，默认设置已一并清除`, 'success');
    toast(`已删除 ${state.selected.tool}/${prov.id}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 新增模型弹窗 ----------
function openAddModelsModal(prov) {
  $('#add-models-target').textContent = `目标：${state.selected.tool}/${prov.id}`;
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
  try {
    const { added } = await api('/api/models/add', { tool: state.selected.tool, providerId: state.selected.id, models });
    toast(`已添加 ${added.length} 个模型${models.length - added.length ? `（${models.length - added.length} 个已存在被跳过）` : ''}`, 'success');
    hideModal('#modal-add-models');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteModel(prov, m) {
  if (!confirm(`确定从 ${state.selected.tool}/${prov.id} 删除模型「${m.id}」？`)) return;
  try {
    const r = await api('/api/models/delete', { tool: state.selected.tool, providerId: prov.id, modelIds: [m.id] });
    if (r.defaultCleared) toast(`它是 ${state.selected.tool} 的默认模型，默认设置已一并清除`, 'success');
    toast(`已删除 ${m.id}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 默认模型 ----------
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

export function openDefaultModal() {
  dmState = {};
  for (const tool of ['opencode', 'pi']) {
    const def = state.overview?.[tool]?.defaultModel;
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
    const providers = state.overview?.[tool]?.providers || [];
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
    clearBtn.disabled = !state.overview?.[tool]?.defaultModel;

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

// ---------- 远端同步弹窗 ----------
async function openSyncModal() {
  const prov = findProv(state.selected.tool, state.selected.id);
  if (!prov) return;
  $('#sync-provider-label').textContent = `${state.selected.tool}/${prov.id}`;
  $('#sync-body').textContent = '';
  $('#sync-body').append(el('p', { class: 'hint' }, '正在拉取远端模型列表…'));
  $('#btn-sync-apply').style.display = 'none';
  syncData = null;
  syncSets = null;
  showModal('#modal-sync');
  try {
    syncData = await api(`/api/providers/remote-models?tool=${encodeURIComponent(state.selected.tool)}&provider=${encodeURIComponent(prov.id)}`);
    syncSets = renderSyncDiff({
      container: $('#sync-body'),
      filterInput: $('#sync-filter'),
      data: syncData,
      onChange: updateApplyBtn,
    });
    updateApplyBtn(); // renderSyncDiff 内部回调发生在赋值之前，这里补一次刷新按钮状态
  } catch (e) {
    $('#sync-body').textContent = '';
    $('#sync-body').append(el('p', { class: 'hint' }, `拉取失败：${e.message}`, el('br'), '部分网关不支持 /models 列表接口，可改用「新增模型」手动填写。'));
  }
}

function updateApplyBtn() {
  const btn = $('#btn-sync-apply');
  if (!syncSets) return;
  const n = syncSets.addedSet.size + syncSets.removedSet.size;
  btn.style.display = '';
  btn.textContent = n ? `应用 ${syncSets.addedSet.size} 个新增 / ${syncSets.removedSet.size} 个删除` : '应用（未勾选任何变更）';
  btn.disabled = n === 0;
}

async function applySync() {
  if (!syncData || !syncSets) return;
  const addIds = [...syncSets.addedSet].map((id) => ({ id, name: id }));
  const delIds = [...syncSets.removedSet];
  try {
    let added = [], removed = [];
    if (addIds.length) added = (await api('/api/models/add', { tool: state.selected.tool, providerId: state.selected.id, models: addIds })).added;
    if (delIds.length) removed = (await api('/api/models/delete', { tool: state.selected.tool, providerId: state.selected.id, modelIds: delIds })).removed;
    toast(`同步完成：新增 ${added.length}，删除 ${removed.length}`, 'success');
    hideModal('#modal-sync');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 事件绑定（静态弹窗/表单） ----------
export function initEvents() {
  $('#btn-provider-save').addEventListener('click', saveProvider);
  $('#btn-add-models-save').addEventListener('click', saveAddModels);
  $('#btn-sync-apply').addEventListener('click', applySync);
  $('#pf-tool').addEventListener('change', () => {
    $('#pf-key-hint-pi').style.display = $('#pf-tool').value === 'pi' ? '' : 'none';
  });
}

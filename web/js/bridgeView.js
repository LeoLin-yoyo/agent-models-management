// 桥接管理视图（独立模块）：桥接服务的桥接模型 —— 配置被墙 API，再同步给 opencode / pi
// 与「模型配置」视图解耦：这里不直接编辑工具配置，只通过「同步」创建/更新指向本地桥接的 provider 副本。
'use strict';
import { $, el, api, toast, fmtRel, pool, testBadge, showModal, hideModal } from './util.js';
import { state, refresh, findBridge, findBridgeByRoute, notify } from './state.js';
import { renderSyncDiff } from './syncDiff.js';

let bpModal = null;   // {mode:'create'} | {mode:'edit', id}
let bsyncBpId = null; // 远端同步弹窗对应的桥接模型 id
let bsyncData = null;
let bsyncSets = null;

// ---------- 渲染 ----------
export function render() {
  renderSidebar();
  renderContent();
}

// 顶栏桥接状态徽标（全局，app 每次重绘时调用）
export function renderBridgeChip() {
  const chip = $('#bridge-chip');
  if (!chip) return;
  const st = state.bridgeState;
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
    ? `监听 http://127.0.0.1:${st.port}（pid ${st.pid || '外部进程'}）\n点击进入「桥接管理」`
    : '点击进入「桥接管理」查看详情 / 启动桥接';
}

function kv(k, v, cls = 'mid') {
  return el('div', { class: 'kv' }, el('span', { class: 'k' }, k), el('span', { class: `v ${cls}` }, v));
}

// ---------- 侧栏 ----------
function renderSidebar() {
  const side = $('#bridge-sidebar');
  side.textContent = '';
  const search = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '🔍 搜索桥接模型（ID / 名称 / 上游）',
    value: state.bFilter,
    oninput: (e) => {
      const selStart = e.target.selectionStart;
      state.bFilter = e.target.value;
      renderSidebar();
      const input = $('#bridge-sidebar input.search-input');
      if (input) {
        input.focus();
        const pos = Math.min(selStart, input.value.length);
        input.setSelectionRange(pos, pos);
      }
    },
  });
  side.append(search);

  const providers = state.bridgeProviders?.providers || [];
  const kw = state.bFilter.trim().toLowerCase();
  const hit = kw
    ? providers.filter((p) =>
        p.id.toLowerCase().includes(kw) || p.name.toLowerCase().includes(kw) || (p.upstream || '').toLowerCase().includes(kw))
    : providers;
  const group = el('div', { class: 'side-group' }, el('h3', {}, `桥接模型（${providers.length}）`));
  if (!hit.length) {
    group.append(el('div', { class: 'side-empty' }, providers.length ? `无匹配「${state.bFilter.trim()}」` : '暂无桥接模型'));
  }
  for (const p of hit) {
    const synced = ['opencode', 'pi'].filter((t) => p.copies?.[t]?.status === 'synced');
    group.append(
      el('div', {
        class: `side-item${state.bSelected === p.id ? ' active' : ''}`,
        title: synced.length ? `已同步到：${synced.join('、')}` : '尚未同步到任何工具',
        onclick: () => { state.bSelected = p.id; state.bModelFilter = ''; notify(); },
      },
        el('span', {}, synced.length ? `${p.name} 🌉` : p.name),
        el('span', { class: 'count' }, String(p.models.length))
      )
    );
  }
  side.append(group);
}

// ---------- 内容区 ----------
function renderContent() {
  const box = $('#bridge-content');
  box.textContent = '';
  const bp = findBridge(state.bSelected);
  if (bp) renderDetail(box, bp);
  else renderHome(box);
}

// 未选中桥接模型：桥接服务状态 + 路由总览 + 使用说明
function renderHome(box) {
  const st = state.bridgeState;
  if (!st || !st.ok) {
    box.append(el('p', { class: 'hint' }, '无法获取桥接状态，请确认服务正常后点「刷新」。'));
  } else {
    const statusText = st.reachable
      ? `运行中${st.pid ? `（pid ${st.pid}）` : '（外部进程）'}`
      : (st.running ? '进程存在但无响应（正在重启？）' : '未运行');
    box.append(
      el('div', { class: 'provider-card' },
        el('div', { class: 'provider-head' },
          el('h2', {}, '🌉 本地 QUIC 桥接'),
          el('span', { class: `tag bridge` }, statusText),
          el('span', { class: 'spacer' }),
        ),
        el('div', { class: 'provider-meta' },
          kv('监听地址', `http://127.0.0.1:${st.port}`),
          kv('Python', st.python || '—'),
          kv('配置文件', st.configFile || '—'),
          kv('运行日志', st.logFile || '—'),
        ),
        el('div', { class: 'provider-actions' },
          el('button', {
            class: `btn ${st.reachable ? 'danger' : 'primary'}`,
            onclick: () => bridgePower(),
          }, st.reachable ? '停止桥接' : '启动桥接'),
          el('button', { class: 'btn ghost', onclick: () => refresh().then(() => toast('已刷新', 'success')).catch((e) => toast(e.message, 'error')) }, '刷新状态'),
        ),
      )
    );
    // 路由总览
    const routes = st.routes || [];
    const rc = el('div', { class: 'provider-card' }, el('h3', { style: 'margin-bottom:8px' }, `桥接路由（${routes.length}）`));
    if (!routes.length) {
      rc.append(el('p', { class: 'hint' }, '暂无路由：创建桥接模型后会自动供给路由'));
    } else {
      const list = el('div', { class: 'sync-list' });
      for (const r of routes) {
        const owner = findBridgeByRoute(r.id);
        list.append(
          el('div', { class: 'sync-row' },
            el('span', { class: 'mid' }, `/${r.id}/`),
            el('span', { class: 'sub' }, `→ ${r.upstream || '?'}`),
            owner
              ? el('span', { class: 'hint' }, `桥接模型：${owner.name}`)
              : el('span', { class: 'hint', title: '没有对应的桥接模型（历史遗留或手工配置）' }, '（无对应桥接模型）'))
        );
      }
      rc.append(list);
    }
    box.append(rc);
  }

  const hasAny = (state.bridgeProviders?.providers || []).length > 0;
  box.append(
    el('div', { class: 'empty-tip' },
      hasAny ? '← 从左侧选择一个桥接模型查看详情与同步' : '还没有桥接模型',
      el('br'),
      '工作流：①「＋ 新增桥接模型」配置被墙的 API（上游地址 / Key / 模型清单）；',
      el('br'),
      '② 在桥接模型详情里把模型「同步」给 opencode / pi；③ 工具配置里会自动生成指向本地桥接的 Provider（增删改自动跟随）',
    )
  );
}

// 选中桥接模型：档案卡 + 同步区 + 模型表
function renderDetail(box, bp) {
  const styleLabel = bp.style === 'anthropic-messages' ? 'Anthropic 兼容' : 'OpenAI 兼容';
  box.append(
    el('div', { class: 'provider-card' },
      el('div', { class: 'provider-head' },
        el('h2', {}, bp.name),
        el('span', { class: 'tag' }, `id: ${bp.id}`),
        el('span', { class: `tag${bp.style === 'anthropic-messages' ? ' anthropic' : ''}` }, styleLabel),
        el('span', { class: 'tag bridge' }, `路由 /${bp.routeId}/`),
        bp.migrated ? el('span', { class: 'tag', title: '由旧版「一键走桥接」的历史数据自动迁移而来' }, '已迁移') : null,
        el('span', { class: 'spacer' }),
      ),
      el('div', { class: 'provider-meta' },
        kv('上游地址', bp.upstream),
        kv('本地桥接地址', bp.bridgedUrl),
        kv('API Key', `${bp.apiKeyMasked}${bp.apiKeyEnv ? '（本机环境变量）' : ''}`),
      ),
      el('div', { class: 'provider-actions' },
        el('button', { class: 'btn', onclick: () => openBpModal('edit', bp.id) }, '编辑'),
        el('button', { class: 'btn primary', onclick: () => openBridgeSyncModal(bp) }, '⟳ 拉取远端模型（经桥接）'),
        el('button', { class: 'btn danger', onclick: () => deleteBp(bp) }, '删除桥接模型'),
      ),
    )
  );

  // 同步区
  box.append(
    el('div', { class: 'sync-card' },
      el('h3', {}, '同步到 Agent 工具', el('span', { class: 'hint' }, '同步会在目标工具配置里创建/更新指向本地桥接的 Provider')),
      syncToolRow(bp, 'opencode'),
      syncToolRow(bp, 'pi'),
      el('p', { class: 'hint', style: 'margin-top:8px' },
        '同步后，在桥接模型里增删模型、修改地址 / Key / 接口类型会自动重新同步；取消同步只删除指向本桥接的副本。')
    )
  );

  // 模型区
  const kw = state.bModelFilter.trim().toLowerCase();
  const hitModels = kw
    ? bp.models.filter((m) => m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw))
    : bp.models;
  box.append(
    el('div', { class: 'toolbar' },
      el('button', { class: 'btn', onclick: () => testAllModels(bp) }, '▶ 测试全部（API，经桥接）'),
      el('button', { class: 'btn', onclick: () => openBridgeAddModels(bp) }, '＋ 新增模型'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint' }, kw ? `命中 ${hitModels.length} / 共 ${bp.models.length} 个模型` : `${bp.models.length} 个模型`),
    )
  );
  if (bp.models.length) {
    const searchRow = el('div', { class: 'search-row' });
    searchRow.append(
      el('input', {
        class: 'search-input',
        type: 'search',
        placeholder: '🔍 模糊搜索模型（匹配 ID / 显示名）',
        value: state.bModelFilter,
        oninput: (e) => {
          const pos = e.target.selectionStart;
          state.bModelFilter = e.target.value;
          renderContent();
          const inp = $('#bridge-content input.search-input');
          if (inp) { inp.focus(); const p2 = Math.min(pos, inp.value.length); inp.setSelectionRange(p2, p2); }
        },
      })
    );
    if (kw) searchRow.append(el('button', { class: 'btn small', onclick: () => { state.bModelFilter = ''; renderContent(); } }, '清空 ×'));
    box.append(searchRow);
  }

  if (!bp.models.length) {
    box.append(el('div', { class: 'empty-tip' }, '还没有模型，点「拉取远端模型（经桥接）」或「新增模型」'));
    return;
  }
  if (kw && !hitModels.length) {
    box.append(el('div', { class: 'empty-tip' }, `没有匹配「${state.bModelFilter.trim()}」的模型`));
    return;
  }
  const tbody = el('tbody');
  for (const m of hitModels) {
    const key = `bridge/${bp.id}/${m.id}`;
    tbody.append(
      el('tr', { 'data-key': key },
        el('td', {}, testBadge(key, m.test, state.testing)),
        el('td', { class: 'mid' }, m.id),
        el('td', { class: 'mname' }, m.name),
        el('td', { class: 'mname' }, m.test ? fmtRel(m.test.checkedAt) : '—'),
        el('td', {},
          el('div', { class: 'row-actions' },
            el('button', { class: 'btn small', onclick: () => runTest(bp, m.id) }, 'API 测试'),
            el('button', { class: 'btn small danger', onclick: () => deleteModel(bp, m) }, '删除'),
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
          el('th', { style: 'width:190px' }, '操作'))),
      tbody)
  );
}

// 单个工具的同步状态行
function syncToolRow(bp, tool) {
  const c = bp.copies?.[tool] || { status: 'none' };
  const row = el('div', { class: 'sync-tool-row' }, el('span', { class: 'tool-name' }, tool));
  if (c.status === 'synced') {
    row.append(
      el('span', { class: 'badge ok', title: `副本 provider：${c.copyId}\n${c.baseUrl || ''}` }, `已同步 · ${c.modelCount} 个模型`),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn small', title: '按桥接模型的当前配置覆盖刷新副本', onclick: () => resync(bp, tool) }, '重新同步'),
      el('button', { class: 'btn small danger', title: '从该工具配置中删除副本 provider（删除前自动备份）', onclick: () => unsync(bp, tool) }, '取消同步'),
    );
  } else if (c.status === 'conflict') {
    row.append(
      el('span', { class: 'badge warn', title: `${tool} 里已存在同 ID（${c.copyId}）的 provider，但不是桥接副本\n当前 BaseURL：${c.baseUrl || '—'}` }, `同 ID 冲突：${c.copyId}`),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn small', title: '用桥接配置整体覆盖该 provider（删除前自动备份）', onclick: () => syncTo(bp, tool, true) }, '覆盖为桥接'),
    );
  } else if (c.status === 'error') {
    row.append(el('span', { class: 'badge fail', title: c.error || '' }, '配置读取失败'));
  } else {
    row.append(
      el('span', { class: 'badge none' }, '未同步'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn small', onclick: () => syncTo(bp, tool, false) }, `同步到 ${tool}`),
    );
  }
  return row;
}

// 同步结果提示文案（自动重同步的结果拼进 toast）
function reSyncNote(reSync) {
  const list = reSync || [];
  const ok = list.filter((r) => r.ok).map((r) => `${r.tool}（${r.action === 'create' ? '新建' : '更新'}）`);
  const bad = list.filter((r) => !r.ok);
  let s = ok.length ? `；已自动重新同步：${ok.join('、')}` : '';
  if (bad.length) s += `；同步失败：${bad.map((b) => `${b.tool}（${b.error}）`).join('；')}`;
  return s;
}

// ---------- 同步操作 ----------
async function syncTo(bp, tool, overwrite) {
  const c = bp.copies?.[tool];
  const tip = overwrite
    ? `「${tool}」里已存在同 ID 的 provider「${c?.copyId || bp.id}」，同步会将它整体覆盖为指向本地桥接的配置（写入前自动备份）。继续？`
    : `把桥接模型「${bp.name}」同步到 ${tool}？\n将创建/更新 Provider「${c?.copyId || bp.id}」，BaseURL 指向本地桥接（${bp.bridgedUrl}）。`;
  if (!confirm(tip)) return;
  try {
    const r = await api('/api/bridge/providers/sync', { id: bp.id, tool, enabled: true });
    toast(`已同步到 ${tool}：${r.action === 'create' ? '创建' : '更新'} Provider「${r.copyId}」（${r.modelCount} 个模型）${r.defaultCleared ? '；原默认模型已一并清除' : ''}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function resync(bp, tool) {
  try {
    const r = await api('/api/bridge/providers/sync', { id: bp.id, tool, enabled: true });
    toast(`已重新同步到 ${tool}：Provider「${r.copyId}」（${r.modelCount} 个模型）`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function unsync(bp, tool) {
  const c = bp.copies?.[tool];
  if (!confirm(`取消同步：从 ${tool} 的配置中删除副本 Provider「${c.copyId}」？\n（删除前自动备份；只删除指向本桥接的副本）`)) return;
  try {
    const r = await api('/api/bridge/providers/sync', { id: bp.id, tool, enabled: false });
    toast(r.removed
      ? `已从 ${tool} 删除副本「${r.copyId}」${r.defaultCleared ? '；原默认模型已一并清除' : ''}`
      : `${tool} 中本就没有副本，无需删除`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteBp(bp) {
  if (!confirm(`确定删除桥接模型「${bp.name}」（${bp.id}）？\n· 已同步到 opencode / pi 的副本 Provider 会一并删除（删除前自动备份）\n· 对应的桥接路由会移除（仍被其它配置引用时保留）`)) return;
  try {
    const r = await api('/api/bridge/providers/delete', { id: bp.id });
    const lines = r.results.map((x) =>
      x.removed ? `✓ 已从 ${x.tool} 删除副本「${x.copyId}」` : (x.ok ? `· ${x.tool}：无副本` : `✗ ${x.tool}：${x.error}`));
    if (r.routeKeptBy) lines.push(`· 路由 /${bp.routeId}/ 仍被 ${r.routeKeptBy} 引用，已保留`);
    toast(`已删除桥接模型「${bp.id}」\n${lines.join('\n')}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 测试 ----------
async function runTest(bp, mid) {
  const key = `bridge/${bp.id}/${mid}`;
  state.testing.add(key);
  notify();
  try {
    const { result } = await api('/api/bridge/providers/test', { id: bp.id, modelId: mid });
    const item = findBridge(bp.id)?.models.find((x) => x.id === mid);
    if (item) item.test = result;
    if (!result.ok) toast(`桥接模型 ${bp.id}/${mid} 测试失败：${result.error}`, 'error');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.testing.delete(key);
    notify();
  }
}

async function testAllModels(bp) {
  const jobs = bp.models.map((m) => m.id);
  toast(`开始经桥接测试 ${bp.name} 的 ${jobs.length} 个模型…`);
  await pool(jobs, 3, (mid) => runTest(bp, mid));
}

// ---------- 桥接模型 新增/编辑 ----------
export function openBpModal(mode, id) {
  bpModal = { mode, id: id || null };
  const bp = mode === 'edit' ? findBridge(id) : null;
  $('#bp-modal-title').textContent = mode === 'edit' ? `编辑桥接模型（${id}）` : '新增桥接模型';
  $('#bp-id').value = bp ? bp.id : '';
  $('#bp-id').disabled = mode === 'edit';
  $('#bp-name').value = bp ? bp.name : '';
  $('#bp-upstream').value = bp ? bp.upstream : '';
  $('#bp-key').value = '';
  $('#bp-key').placeholder = bp
    ? `留空保持不变（当前 ${bp.apiKeyMasked}）`
    : 'sk-... 或 env:MY_KEY';
  $('#bp-style').value = bp ? bp.style : 'openai-completions';
  updateBpHint();
  showModal('#modal-bridge-provider');
  if (mode === 'create') $('#bp-id').focus();
}

function updateBpHint() {
  const hint = $('#bp-hint');
  if (!hint) return;
  if (bpModal && bpModal.mode === 'edit') {
    hint.textContent = 'ID 创建后不可修改（用于关联已同步的副本 Provider 与桥接路由）。';
    return;
  }
  const port = state.bridgeProviders?.port || state.bridgeState?.port || 8787;
  const id = $('#bp-id').value.trim() || 'my-gateway';
  hint.textContent = `本地桥接地址将形如 http://127.0.0.1:${port}/${id}/…；同步到工具后请求经 QUIC 转发到上游。`;
}

async function saveBpModal() {
  const id = $('#bp-id').value.trim();
  const name = $('#bp-name').value.trim();
  const upstream = $('#bp-upstream').value.trim();
  const apiKey = $('#bp-key').value.trim();
  const style = $('#bp-style').value;
  try {
    if (!bpModal) return;
    if (bpModal.mode === 'create') {
      if (!id) throw new Error('请填写 ID');
      if (!upstream) throw new Error('请填写上游地址 BaseURL');
      await api('/api/bridge/providers/create', { id, name, upstream, apiKey, style });
      state.bSelected = id;
      toast(`已创建桥接模型「${id}」，接下来可在详情里同步给 opencode / pi`, 'success');
    } else {
      const patch = { name, upstream, style };
      if (apiKey) patch.apiKey = apiKey;
      const r = await api('/api/bridge/providers/update', { id: bpModal.id, patch });
      toast(`已保存${reSyncNote(r.reSync)}`, 'success');
    }
    hideModal('#modal-bridge-provider');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 桥接模型 新增模型 ----------
function openBridgeAddModels(bp) {
  $('#bam-target').textContent = `目标：桥接模型 ${bp.id}（上游 ${bp.upstream}）`;
  $('#bam-input').value = '';
  showModal('#modal-bridge-add-models');
}

async function saveBridgeAddModels() {
  const bp = findBridge(state.bSelected);
  if (!bp) return;
  const lines = $('#bam-input').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const models = [];
  for (const line of lines) {
    const [id, name] = line.split('|').map((s) => s.trim());
    if (id) models.push({ id, name: name || id });
  }
  if (!models.length) { toast('请至少填写一个模型 ID', 'error'); return; }
  try {
    const r = await api('/api/bridge/providers/models/add', { id: bp.id, models });
    toast(`已添加 ${r.added.length} 个模型${models.length - r.added.length ? `（${models.length - r.added.length} 个已存在被跳过）` : ''}${reSyncNote(r.reSync)}`, 'success');
    hideModal('#modal-bridge-add-models');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteModel(bp, m) {
  if (!confirm(`确定从桥接模型「${bp.id}」删除模型「${m.id}」？\n（已同步的工具会一并移除该模型）`)) return;
  try {
    const r = await api('/api/bridge/providers/models/delete', { id: bp.id, modelIds: [m.id] });
    toast(`已删除 ${m.id}${reSyncNote(r.reSync)}`, 'success');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 桥接模型 远端同步（经桥接拉取） ----------
async function openBridgeSyncModal(bp) {
  bsyncBpId = bp.id;
  bsyncData = null;
  bsyncSets = null;
  $('#bsync-label').textContent = bp.id;
  $('#bsync-body').textContent = '';
  $('#bsync-body').append(el('p', { class: 'hint' }, '正在经桥接拉取远端模型列表…'));
  $('#btn-bsync-apply').style.display = 'none';
  showModal('#modal-bridge-sync');
  try {
    bsyncData = await api(`/api/bridge/providers/remote-models?id=${encodeURIComponent(bp.id)}`);
    bsyncSets = renderSyncDiff({
      container: $('#bsync-body'),
      filterInput: $('#bsync-filter'),
      data: bsyncData,
      onChange: updateBsyncBtn,
    });
    updateBsyncBtn(); // renderSyncDiff 内部回调发生在赋值之前，这里补一次刷新按钮状态
  } catch (e) {
    $('#bsync-body').textContent = '';
    $('#bsync-body').append(el('p', { class: 'hint' }, `拉取失败：${e.message}`, el('br'), '请确认桥接进程在运行、API Key 可用；部分网关不支持 /models 列表接口，可改用「新增模型」手动填写。'));
  }
}

function updateBsyncBtn() {
  const btn = $('#btn-bsync-apply');
  if (!bsyncSets) return;
  const n = bsyncSets.addedSet.size + bsyncSets.removedSet.size;
  btn.style.display = '';
  btn.textContent = n ? `应用 ${bsyncSets.addedSet.size} 个新增 / ${bsyncSets.removedSet.size} 个删除` : '应用（未勾选任何变更）';
  btn.disabled = n === 0;
}

async function applyBridgeSync() {
  if (!bsyncBpId || !bsyncSets) return;
  const addIds = [...bsyncSets.addedSet].map((id) => ({ id, name: id }));
  const delIds = [...bsyncSets.removedSet];
  try {
    let added = [], removed = [];
    if (addIds.length) added = (await api('/api/bridge/providers/models/add', { id: bsyncBpId, models: addIds })).added;
    if (delIds.length) removed = (await api('/api/bridge/providers/models/delete', { id: bsyncBpId, modelIds: delIds })).removed;
    toast(`同步完成：新增 ${added.length}，删除 ${removed.length}（已同步的工具会自动重新同步）`, 'success');
    hideModal('#modal-bridge-sync');
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 桥接进程 启停 ----------
async function bridgePower() {
  const up = !!(state.bridgeState && state.bridgeState.reachable);
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
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 事件绑定 ----------
export function initEvents() {
  $('#btn-bp-save').addEventListener('click', saveBpModal);
  $('#bp-id').addEventListener('input', updateBpHint);
  $('#btn-bam-save').addEventListener('click', saveBridgeAddModels);
  $('#btn-bsync-apply').addEventListener('click', applyBridgeSync);
}

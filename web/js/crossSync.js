// 跨工具同步弹窗（模型配置视图）：opencode ⇄ pi 的 provider 级同步
'use strict';
import { $, el, api, toast, showModal, hideModal } from './util.js';
import { refresh } from './state.js';

let csState = null; // { source, target, items, checked:Set, _updateBtn? }

export function openCrossSyncModal() {
  csState = null;
  $('#cs-direction').value = 'pi->opencode';
  $('#cs-filter').value = '';
  $('#btn-cs-apply').style.display = 'none';
  showModal('#modal-cross-sync');
  loadPlan();
}

async function loadPlan() {
  const direction = $('#cs-direction').value;
  const body = $('#cs-body');
  body.textContent = '';
  body.append(el('p', { class: 'hint' }, '正在计算差异…'));
  $('#btn-cs-apply').style.display = 'none';
  try {
    csState = await api(`/api/cross-sync/plan?direction=${encodeURIComponent(direction)}`);
    // 默认全选（源端存在的 provider）
    csState.checked = new Set(csState.items.filter((x) => x.action !== 'missing').map((x) => x.id));
    renderBody();
  } catch (e) {
    body.textContent = '';
    body.append(el('p', { class: 'hint' }, `预检失败：${e.message}`));
  }
}

function renderBody() {
  const body = $('#cs-body');
  body.textContent = '';
  if (!csState) { body.append(el('p', { class: 'hint' }, '请先选择同步方向')); return; }
  const { source, target, items, checked } = csState;
  const list = el('div', { class: 'sync-list' });
  for (const it of items) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = checked.has(it.id);
    if (it.action === 'missing') cb.disabled = true; // 源端不存在，不可勾选
    cb.addEventListener('change', () => {
      if (cb.checked) checked.add(it.id); else checked.delete(it.id);
      updateBtn();
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
  updateBtn();

  function updateBtn() {
    const btn = $('#btn-cs-apply');
    btn.style.display = '';
    const n = checked.size;
    btn.textContent = n ? `执行同步（已选 ${n} 个）` : '执行同步（未选择）';
    btn.disabled = n === 0;
  }
  csState._updateBtn = updateBtn;
}

function applyFilter() {
  const kw = $('#cs-filter').value.trim().toLowerCase();
  for (const row of $('#cs-body').querySelectorAll('.sync-row')) {
    const match = !kw || (row.dataset.pid || '').includes(kw);
    row.style.display = match ? '' : 'none';
  }
}

async function applyCrossSync() {
  if (!csState || !csState.checked.size) return;
  const direction = $('#cs-direction').value;
  const ids = [...csState.checked];
  const target = csState.target;
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
    csState._updateBtn && csState._updateBtn();
  }
}

export function initEvents() {
  $('#btn-cs-plan').addEventListener('click', () => loadPlan().catch((e) => toast(e.message, 'error')));
  $('#btn-cs-apply').addEventListener('click', applyCrossSync);
  $('#cs-direction').addEventListener('change', () => loadPlan().catch((e) => toast(e.message, 'error')));
  $('#cs-filter').addEventListener('input', applyFilter);
}

// 远端模型 diff 面板（勾选集 + 渲染），供「模型配置」与「桥接管理」的远端同步弹窗共用
'use strict';
import { el } from './util.js';

// opts: { container, filterInput, data:{added,removed,remote,configured}, onChange(sets) }
// 返回 { addedSet, removedSet } —— 当前勾选的新增/删除集合
export function renderSyncDiff({ container, filterInput, data, onChange }) {
  container.textContent = '';
  const addedSet = new Set();
  const removedSet = new Set();
  const { added, removed, remote, configured } = data;

  const emit = () => onChange({ addedSet, removedSet });

  const mkSection = (title, ids, checkedByDefault, cls, applySet) => {
    if (!ids.length) return null;
    const list = el('div', { class: 'sync-list' });
    for (const id of ids) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = checkedByDefault;
      cb.addEventListener('change', () => {
        if (cb.checked) applySet.add(id); else applySet.delete(id);
        emit();
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
          emit();
        } }),
        ' 全选/全不选（当前可见）'),
      el('span', { class: 'hint n-hit' }, '')
    );
    section.append(el('h4', {}, title, el('span', { class: 'n' }, `${ids.length} 个`)), bar, list);
    return section;
  };

  const secAdd = mkSection('➕ 远端新增（API 有、配置里没有）', added, true, '', addedSet);
  const secDel = mkSection('➖ 远端未列出（可能已下线）', removed, false, 'removed', removedSet);

  if (secAdd) container.append(secAdd);
  if (secDel) container.append(secDel);
  if (!secAdd && !secDel) {
    container.append(el('p', { class: 'sync-ok' }, `✓ 远端 ${remote.length} 个模型与本地配置（${configured.length} 个）完全一致，无需变更`));
  }

  // 搜索框过滤：同时作用于「远端新增」「远端未列出」两个列表
  filterInput.value = '';
  filterInput.oninput = () => {
    const kw = filterInput.value.trim().toLowerCase();
    let hits = 0;
    for (const row of container.querySelectorAll('.sync-row')) {
      const mid = row.dataset.mid || '';
      const match = !kw || mid.toLowerCase().includes(kw);
      row.style.display = match ? '' : 'none';
      if (match) hits++;
    }
    for (const badge of container.querySelectorAll('.n-hit')) {
      badge.textContent = kw ? `命中 ${hits} 个` : '';
    }
  };

  emit();
  return { addedSet, removedSet };
}

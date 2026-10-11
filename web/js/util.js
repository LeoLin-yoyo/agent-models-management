// 通用工具：DOM 构造 / API 调用 / 通知 / 弹窗控制 / 小工具
'use strict';

export const $ = (s) => document.querySelector(s);

export function el(tag, attrs = {}, ...children) {
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

export async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function fmtRel(iso) {
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

export async function pool(items, limit, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    })
  );
}

export function toast(msg, type = '') {
  const t = el('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 8000 : 4000);
}

// 测试状态徽章（模型配置 / 桥接管理共用）：testing 为正在测试的 key 集合
export function testBadge(key, test, testing) {
  if (testing.has(key)) {
    return el('span', { class: 'badge pending' }, el('span', { class: 'spin' }), '测试中');
  }
  if (!test) return el('span', { class: 'badge none' }, '未测试');
  if (test.ok) {
    return el('span', { class: 'badge ok' },
      '✓', `${test.latencyMs}ms`,
      el('span', { class: 'via' }, test.via === 'cli' ? 'CLI' : 'API'));
  }
  return el('span', { class: 'badge fail', title: test.error || '' }, `✗ ${(test.error || '失败').slice(0, 60)}`);
}

// ---------- 弹窗通用 ----------
export function showModal(sel) { $(sel).classList.remove('hidden'); }
export function hideModal(sel) { $(sel).classList.add('hidden'); }

export function initModals() {
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
}

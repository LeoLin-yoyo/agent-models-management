// 入口：页签导航（模型配置 / 桥接管理）、顶栏按钮、全局重渲染与启动
'use strict';
import { $, toast, initModals } from './util.js';
import { state, setOnChange, refresh, switchTab } from './state.js';
import * as agentView from './agentView.js';
import * as bridgeView from './bridgeView.js';
import * as crossSync from './crossSync.js';
import * as chat from './chat.js';

// ---------- 全局重渲染 ----------
function renderAll() {
  renderTabs();
  bridgeView.renderBridgeChip();
  if (state.activeTab === 'agent') {
    agentView.render();
    agentView.renderDefaultBtnTitle();
  } else {
    bridgeView.render();
  }
  updateBackTop();
}
setOnChange(renderAll);

function renderTabs() {
  const isAgent = state.activeTab === 'agent';
  $('#tab-agent').classList.toggle('active', isAgent);
  $('#tab-bridge').classList.toggle('active', !isAgent);
  $('#agent-actions').classList.toggle('hidden', !isAgent);
  $('#bridge-actions').classList.toggle('hidden', isAgent);
  $('#view-agent').classList.toggle('hidden', !isAgent);
  $('#view-bridge').classList.toggle('hidden', isAgent);
}

// ---------- 回到顶部 ----------
const BACK_TOP_THRESHOLD = 300;
function activeScrollBox() {
  return state.activeTab === 'agent' ? $('#content') : $('#bridge-content');
}
function updateBackTop() {
  const box = activeScrollBox();
  $('#btn-back-top').classList.toggle('show', !!box && box.scrollTop > BACK_TOP_THRESHOLD);
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 页签
  $('#tab-agent').addEventListener('click', () => switchTab('agent'));
  $('#tab-bridge').addEventListener('click', () => switchTab('bridge'));
  $('#bridge-chip').addEventListener('click', () => switchTab('bridge'));

  // 模型配置视图（顶栏）
  $('#btn-refresh').addEventListener('click', () => refresh().then(() => toast('已刷新', 'success')).catch((e) => toast(e.message, 'error')));
  $('#btn-add-provider').addEventListener('click', () => agentView.openProviderModal('create'));
  $('#btn-test-all').addEventListener('click', () => agentView.testAll().catch((e) => toast(e.message, 'error')));
  $('#btn-default-model').addEventListener('click', () => agentView.openDefaultModal());
  $('#btn-cross-sync').addEventListener('click', () => crossSync.openCrossSyncModal());

  // 桥接管理视图（顶栏）
  $('#btn-bridge-add').addEventListener('click', () => bridgeView.openBpModal('create'));
  $('#btn-bridge-refresh').addEventListener('click', () => refresh().then(() => toast('已刷新', 'success')).catch((e) => toast(e.message, 'error')));

  // 回到顶部
  $('#content').addEventListener('scroll', updateBackTop, { passive: true });
  $('#bridge-content').addEventListener('scroll', updateBackTop, { passive: true });
  $('#btn-back-top').addEventListener('click', () => activeScrollBox()?.scrollTo({ top: 0, behavior: 'smooth' }));

  // 各视图/弹窗内部绑定
  agentView.initEvents();
  bridgeView.initEvents();
  crossSync.initEvents();
  chat.initEvents();
  initModals();
}

bindEvents();

// 支持 URL hash 直达：#bridge 或 #bridge/<桥接模型id>（便于分享/刷新后回到桥接管理）
{
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash === 'bridge' || hash.startsWith('bridge/')) {
    state.activeTab = 'bridge';
    const id = decodeURIComponent(hash.split('/')[1] || '');
    if (id) state.bSelected = id;
  }
}

refresh().catch((e) => toast(`加载失败: ${e.message}`, 'error'));

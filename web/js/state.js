// 全局状态与数据加载：视图层共享；数据变更后统一 notify() 触发重渲染
'use strict';
import { api } from './util.js';

export const state = {
  overview: null,        // 模型配置视图：{opencode:{configPath,providers,defaultModel}, pi:{...}}
  bridgeState: null,     // 桥接进程状态（/api/bridge/status）
  bridgeProviders: null, // 桥接模型列表（/api/bridge/providers）
  selected: null,        // 模型配置视图选中：{tool, id}
  bSelected: null,       // 桥接管理视图选中：桥接模型 id
  providerFilter: '',    // 模型配置：侧栏 provider 搜索
  modelFilter: '',       // 模型配置：当前 provider 内模型搜索
  bFilter: '',           // 桥接管理：侧栏搜索
  bModelFilter: '',      // 桥接管理：当前桥接模型内模型搜索
  testing: new Set(),    // 正在测试的 key（`工具/provider/模型` 或 `bridge/桥接模型/模型`）
  activeTab: 'agent',    // 'agent' | 'bridge'
};

let onChange = () => {};
export function setOnChange(fn) { onChange = fn; }
export function notify() { onChange(); }

export async function refresh() {
  const [ov, bs, bp] = await Promise.all([
    api('/api/overview'),
    api('/api/bridge/status').catch(() => null),
    api('/api/bridge/providers').catch(() => null),
  ]);
  state.overview = ov;
  state.bridgeState = bs;
  state.bridgeProviders = bp;
  // 选中对象已不存在则清空
  if (state.selected && !findProv(state.selected.tool, state.selected.id)) state.selected = null;
  if (state.bSelected && !findBridge(state.bSelected)) state.bSelected = null;
  notify();
}

export function findProv(tool, id) {
  return state.overview?.[tool]?.providers.find((p) => p.id === id) || null;
}

export function findBridge(id) {
  return state.bridgeProviders?.providers.find((p) => p.id === id) || null;
}

export function findBridgeByRoute(routeId) {
  return state.bridgeProviders?.providers.find((p) => p.routeId === routeId) || null;
}

// 切换一级视图（模型配置 / 桥接管理）；opts.bSelected 可顺带选中某个桥接模型
export function switchTab(tab, opts = {}) {
  state.activeTab = tab;
  if (tab === 'bridge' && opts.bSelected !== undefined) state.bSelected = opts.bSelected;
  notify();
}

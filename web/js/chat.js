// 即时问答弹窗（模型配置视图）：流式对话
'use strict';
import { $, el, showModal } from './util.js';
import { findProv } from './state.js';

let chatState = null; // { tool, providerId, modelId, messages: [{role, content}], generating }

export function openChatModal(tool, providerId, modelId) {
  const prov = findProv(tool, providerId);
  if (!prov) return;
  // 走桥接的 provider，Key 已在桥接模型里配好，不再提示 Key 缺失
  const bridged = !!(prov.bridge && prov.bridge.bridged);
  const hasKey = prov.apiKeyMasked && prov.apiKeyMasked !== '未设置';
  if (!hasKey && !bridged && !confirm(`该 provider 未配置 API Key，直接对话大概率会失败，仍要继续吗？`)) return;
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

export function initEvents() {
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
}

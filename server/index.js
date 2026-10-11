// agent-models-management 服务入口：http://127.0.0.1:3210
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const api = require('./routes');
const bridge = require('./bridge');
const bridgeProviders = require('./bridgeProviders');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/api', api);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || '服务器内部错误' });
});

const noOpen = process.argv.includes('--no-open');
const basePort = Number(process.env.PORT) || 3210;
const maxTries = 5;

function openBrowser(url) {
  if (noOpen) return;
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function listen(port, triesLeft) {
  const server = app.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`agent-models-management 已启动: ${url}`);
    openBrowser(url);
    // 桥接模型注册表：旧数据迁移 + 路由补齐（独立模块；失败不影响主服务）
    try {
      bridgeProviders.init();
    } catch (e) {
      console.error('[桥接模型] 初始化失败:', e.message);
    }
    // 桥接：按需拉起（静默子进程；失败不影响主服务）
    bridge
      .ensureRunning()
      .then((r) => console.log('[桥接]', r.started ? `已启动 (pid ${r.pid})` : `未启动：${r.reason}`))
      .catch((e) => console.error('[桥接] 启动失败:', e.message));
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1}...`);
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('启动失败:', e.message);
      process.exit(1);
    }
  });
}

listen(basePort, maxTries);

// 退出时带走桥接子进程（Ctrl+C / 正常终止）
function shutdown() {
  bridge
    .stop()
    .catch(() => {})
    .finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

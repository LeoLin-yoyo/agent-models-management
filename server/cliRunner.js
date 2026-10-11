// CLI 端到端测试：真正用 opencode / pi 跑一次对话。
// 全程不经过 shell（shell:false + 参数数组），避免任何命令注入面。
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { TEST_PROMPT } = require('./probe');

const SCRATCH = path.join(os.tmpdir(), 'ammp-cli-test');
fs.mkdirSync(SCRATCH, { recursive: true });

// 解析真实可执行入口（npm 全局目录下；可用环境变量覆盖）
function nodeDir() {
  return path.dirname(process.execPath);
}

function resolveOpencode() {
  // 优先环境变量；其余按 npm 全局目录下的已知布局依次探测（旧路径 opencode-ai/bin 已失效）
  const candidates = [
    process.env.AMMP_OPENCODE_PATH,
    path.join(nodeDir(), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    path.join(nodeDir(), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(nodeDir(), 'opencode.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function resolvePi() {
  const candidates = [
    process.env.AMMP_PI_PATH,
    path.join(nodeDir(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return { node: true, path: c };
  return null;
}

function runDirect(argv, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      cwd: SCRATCH,
      windowsHide: true,
      // stdin 必须关闭：CLI 检测到管道 stdin 时会等待输入直到超时
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 杀掉整棵进程树（CLI 可能有自己的子进程）
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动 ${argv[0]}: ${e.message}`, latencyMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = (out || '').trim();
      const errText = (err || '').trim();
      if (timedOut) {
        resolve({ ok: false, error: `超时（${Math.round(timeoutMs / 1000)}s）未返回`, output: output.slice(0, 400), latencyMs: Date.now() - started });
      } else if (code === 0 && output) {
        resolve({ ok: true, output: output.slice(0, 400), latencyMs: Date.now() - started });
      } else {
        resolve({ ok: false, error: `退出码 ${code}${errText ? '：' + errText.slice(0, 300) : '，无输出'}`, output: output.slice(0, 400), latencyMs: Date.now() - started });
      }
    });
  });
}

// 防御性校验：provider/model id 仅做控制字符与长度限制（真正的注入面已由 shell:false 消除）
function safeId(x, label) {
  if (typeof x !== 'string' || !x.trim()) throw new Error(`${label} 不能为空`);
  if (x.length > 200 || /[\0\r\n]/.test(x)) throw new Error(`${label} 含非法字符或过长`);
  return x.trim();
}

async function testViaOpencode(providerId, modelId) {
  providerId = safeId(providerId, 'provider id');
  modelId = safeId(modelId, 'model id');
  const exe = resolveOpencode();
  if (!exe) return { ok: false, error: '未找到 opencode 可执行文件（node_modules/opencode-ai/bin/opencode.exe），可用 AMMP_OPENCODE_PATH 指定' };
  return runDirect([exe, 'run', '-m', `${providerId}/${modelId}`, TEST_PROMPT], 150000);
}

async function testViaPi(providerId, modelId) {
  providerId = safeId(providerId, 'provider id');
  modelId = safeId(modelId, 'model id');
  const pi = resolvePi();
  if (!pi) return { ok: false, error: '未找到 pi 入口（@earendil-works/pi-coding-agent/dist/bundle/cli.js），可用 AMMP_PI_PATH 指定' };
  const argv = pi.node ? [process.execPath, pi.path] : [pi.path];
  return runDirect(
    [
      ...argv,
      '-p',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--thinking', 'off',
      '--provider', providerId,
      '--model', modelId,
      TEST_PROMPT,
    ],
    90000
  );
}

module.exports = { testViaOpencode, testViaPi };

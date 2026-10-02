# Agent 模型管理

本地可视化平台，统一管理 **opencode** 与 **pi** 两个终端 agent 工具的 LLM Provider 与模型配置。

## 启动

**快捷命令（推荐）**：把仓库里的 `bin/ammp.cmd` 所在目录加入用户 PATH（如 `%USERPROFILE%\bin`），在任意终端（CMD / PowerShell / Git Bash）输入：

```bash
ammp        # 启动服务并在浏览器打开；已在运行则直接打开浏览器
ammp stop   # 停止服务
```

> PATH 注册在用户级注册表（HKCU\Environment\Path），新开的终端才能直接用 `ammp`。

**手动启动**：

```bash
start.bat        # 双击即可，自动打开浏览器（前台窗口）
# 或
npm start        # http://127.0.0.1:3210 （--no-open 不自动开浏览器，PORT=xxx 换端口）
```

仅依赖 Node.js（无需构建）。服务只监听 127.0.0.1，不对局域网开放。

## 功能

| 功能 | 说明 |
|---|---|
| 配置总览 | 读取两个工具的全部 provider / 模型，展示 key 来源与打码 |
| 拉取远端模型 | 调用网关 `GET /models`，diff 出「远端新增」「远端未列出（疑似下线）」，勾选后一键同步 |
| 一键测试（API） | 直接向网关发一次小对话请求，得到成功/失败与延迟，可全量并发跑 |
| 一键测试（CLI） | 用 `opencode run -m provider/model` / `pi -p --provider --model` 真实跑一次端到端对话 |
| Provider / 模型增删改 | 界面上直接改配置文件，每次写入前自动备份 |
| 桥接（QUIC） | 对 TCP 被阻断、HTTP/3 可用的 API：一键「走桥接」自动改写 BaseURL，请求经本机 127.0.0.1:8787 用 QUIC 转发（含流式 SSE），可随时取消恢复 |

## 修改的配置文件

- opencode：`~/.config/opencode/opencode.jsonc`
- pi：`~/.pi/agent/models.json`（key 支持 `env:变量名` 写法，写入为 `$变量名`；也兼容 `auth.json` 里的 key）

每次保存前，原配置会备份到同目录 `ammp-backups/`（保留最近 20 份）。

## 注意

- API 级测试按 provider 的接口类型探测：`OpenAI 兼容` 打 `/chat/completions`，`Anthropic 兼容` 打 `/messages`。
- pi 的 key 解析顺序：models.json 字面量 → `$ENV` 环境变量 → `auth.json`。测试需在本机环境变量中能取到 key。
- 部分网关不提供 `GET /models`，此时同步会提示失败，可手动「新增模型」。
- opencode 配置是 JSONC；本工具保存后会以标准 JSON（2 空格缩进）重写，注释会丢失（有备份兜底），当前配置无注释不受影响。
- 测试历史保存在 `data/test-results.json`，重启后仍可查看上次测试结果。

## 桥接（本地 TCP→HTTP/3 转发）

部分 API 域名在 TCP 上被防火墙阻断（TLS 明文 SNI 触发 RST），但同一服务在 HTTP/3(QUIC) 可用。
本平台内置托管桥接（`bridge/quic_bridge.py`，aioquic 实现），随服务自动拉起（静默子进程、无窗口，
意外退出会自动重启，最多连试 5 次）：

- Provider 卡片点「🌉 走桥接」：自动记录路由并把该工具配置里的 BaseURL 改写为
  `http://127.0.0.1:8787/<routeId>/<原路径>`；点「🌉 取消桥接」恢复原地址并清理路由。
- 顶栏「🌉 桥接」徽标显示运行状态；点开可查看路由列表 / 启停桥接。
- 路由配置 `data/bridge.json`（热生效，无需重启）；桥接日志 `data/bridge.log`。
- 走桥接的 Provider，其「拉取远端模型 / API 测试 / 即时问答（含 SSE）」自动经桥接。
- 依赖 Python + aioquic；Python 路径可在 `data/bridge.json` 的
  `python` 字段或环境变量 `AMMP_PYTHON` 指定（默认取 PATH 里的 python）。

## 开机自启（静默后台，无窗口）

- `autostart.cmd`：防重复（3210 已在监听则退出）+ 以 `--no-open` 静默启动，日志追加到 `data/server-out.log`。
- Startup 目录的 `ammp_silent.vbs`：登录时以隐藏窗口调用 `autostart.cmd`（不弹黑框、不开浏览器）。
- 禁用自启：删除 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ammp_silent.vbs`。
- 手动控制：`ammp`（启动/开浏览器）、`ammp stop`（停止服务并顺带停掉桥接进程）。

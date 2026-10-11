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
start.bat        # 双击即可：后台隐藏启动 + 自动打开浏览器（脚本立即退出，无命令行窗口）
# 或
ammp             # 同上（推荐；已在运行则只打开浏览器）
npm start        # 前台运行，日志直接输出到当前终端（--no-open 不自动开浏览器，PORT=xxx 换端口）
```

仅依赖 Node.js（无需构建）。服务只监听 127.0.0.1，不对局域网开放。

## 功能

| 功能 | 说明 |
|---|---|
| 配置总览 | 读取两个工具的全部 provider / 模型，展示 key 来源与打码 |
| 默认模型 | 一键把某个模型设为该工具新会话的默认模型（opencode 写配置顶层 `model`，pi 写 `settings.json` 的 `defaultProvider/defaultModel`），顶栏「⭐ 默认模型」可集中查看与修改；删除该 provider/模型时自动清除默认 |
| 拉取远端模型 | 调用网关 `GET /models`，diff 出「远端新增」「远端未列出（疑似下线）」，勾选后一键同步 |
| 一键测试（API） | 直接向网关发一次小对话请求，得到成功/失败与延迟，可全量并发跑 |
| 一键测试（CLI） | 用 `opencode run -m provider/model` / `pi -p --provider --model` 真实跑一次端到端对话 |
| Provider / 模型增删改 | 界面上直接改配置文件，每次写入前自动备份 |
| 桥接管理（独立模块） | 顶栏「🌉 桥接管理」：先配置「桥接模型」（被墙 API 的上游地址 / Key / 模型清单），再一键同步给 opencode / pi——工具配置里自动生成指向本地桥接的 Provider，后续增删改自动跟随；支持经桥接的 API 测试与远端模型拉取 |

## 修改的配置文件

- opencode：`~/.config/opencode/opencode.jsonc`
- pi：`~/.pi/agent/models.json`（key 支持 `env:变量名` 写法，写入为 `$变量名` 引用；也兼容 `auth.json` 里的 key）
- 默认模型额外写：opencode 同文件顶层 `model` 字段；pi 另写 `~/.pi/agent/settings.json`（`defaultProvider` / `defaultModel` / 可选 `defaultThinkingLevel`）

每次保存前，原配置会备份到同目录 `ammp-backups/`（保留最近 20 份）。

## 注意

- API 级测试按 provider 的接口类型探测：`OpenAI 兼容` 打 `/chat/completions`，`Anthropic 兼容` 打 `/messages`。
- pi 的 key 解析顺序：models.json 字面量 → `$ENV` 环境变量 → `auth.json`。测试需在本机环境变量中能取到 key。
- 部分网关不提供 `GET /models`，此时同步会提示失败，可手动「新增模型」。
- opencode 配置是 JSONC；本工具保存后会以标准 JSON（2 空格缩进）重写，注释会丢失（有备份兜底），当前配置无注释不受影响。
- 测试历史保存在 `data/test-results.json`，重启后仍可查看上次测试结果。

## 桥接管理（独立模块）

部分 API 域名在 TCP 上被防火墙阻断（TLS 明文 SNI 触发 RST），但同一服务在 HTTP/3(QUIC) 可用。
本平台内置托管桥接（`bridge/quic_bridge.py`，aioquic 实现），随服务自动拉起（静默子进程、无窗口，
意外退出会自动重启，最多连试 5 次）。

顶栏「🌉 桥接管理」是**独立模块**，与模型配置页完全分开，工作流：

1. **配置桥接模型**：「＋ 新增桥接模型」填写被墙 API 的上游地址、API Key（支持 `env:变量名` 引用）、
   接口类型与模型清单（可经桥接「拉取远端模型」同步）。
   **Key 只需在这里填一次，且以这里的为准**：桥接会用配置的 Key 覆盖请求里的鉴权，客户端（agent、编辑器、
   curl）传的 Key 一律忽略——填错、填空、随便填都不影响调用。只有桥接模型**没配** Key 时才透传客户端的。
   BaseURL 写到 `http://127.0.0.1:8787/<路由>/v1` 或 `http://127.0.0.1:8787/<路由>` 都可以（缺 `/v1` 会自动补）。
2. **同步给 agent**：在桥接模型详情里对 opencode / pi 点「同步」——工具配置里自动创建/更新一个
   BaseURL 指向 `http://127.0.0.1:8787/<路由>/` 的 Provider（含 Key 与模型，写入前自动备份）；
   之后在桥接模型里增删模型、改地址 / Key 会**自动重新同步**；「取消同步」删除该副本。
   同 ID 冲突（工具里已有同名 Provider）会明确提示，可选择覆盖。
3. **测试**：桥接模型支持经桥接的 API 测试与远端模型拉取；同步到工具后也可用原有的 CLI 测试 / 即时问答。

- 桥接模型注册表：`data/bridge-providers.json`；路由配置：`data/bridge.json`（热生效，无需重启）；桥接日志 `data/bridge.log`。
- 模型配置页里由桥接同步生成的 Provider 会标注「🌉 桥接同步」，修改请在桥接管理里进行（本页改动会在下次同步时被覆盖）。
- 旧版「Provider 卡片一键走桥接」产生的数据在服务启动时自动迁移为桥接模型（纯增量，不改写工具配置；
  已不再被任何配置引用的历史路由保留原样，标注「无对应桥接模型」）。
- 依赖 Python + aioquic；Python 路径可在 `data/bridge.json` 的 `python` 字段或环境变量 `AMMP_PYTHON` 指定（默认取 PATH 里的 python）。
- 环境变量 `AMMP_HOME` / `AMMP_DATA_DIR` 可分别覆盖 agent 配置基目录与平台数据目录（隔离测试用）。

## 开机自启（静默后台，无窗口）

**全程无命令行窗口**：无论 `start.bat` / `ammp` / 开机自启，服务和桥接都隐藏运行。

- `start.bat`（双击）：经 `bin/run_hidden.vbs` 隐藏启动，脚本立即退出（旧版是前台窗口 + pause，已改掉）。
- `ammp`（启动）：同样经 `bin/run_hidden.vbs` → `bin/ammp_run.cmd` 隐藏拉起
  （旧写法 `start /min cmd` 会留一个最小化的控制台窗口，已改掉）。
- 桥接进程：优先用 **`pythonw.exe`**（无控制台子系统，物理上不会弹窗）；旧配置里的 `python.exe`
  会自动升级为 `pythonw.exe`。同时 spawn 带 `windowsHide`。
- `autostart.cmd`：防重复（3210 已在监听则退出）+ 走同一套隐藏启动（`--no-open`，日志追加到 `data/server-out.log`）。
- Startup 目录的 `ammp_silent.vbs`：登录时以隐藏窗口调用 `autostart.cmd`（不弹黑框、不开浏览器）。
- 禁用自启：删除 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ammp_silent.vbs`。
- 手动控制：`ammp`（隐藏启动 / 已在运行则开浏览器）、`ammp stop`（停止服务并顺带停掉桥接进程）。

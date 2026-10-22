# metis-pi

[English](README.md) | **简体中文**

为 Pi 提供 Codex 风格的紧凑转录界面，并附带独立的 goal、skill 输入、condense 和执行工具。当前版本 **0.21.0**，开发与宿主检查针对 **Pi 1.4.0**。

## 安装

需要 Node.js >=22.19.0 和 Pi 1.4.0。在本地检出目录运行：

```bash
pi install .
```

重启 Pi 加载改动；在主题选择器中选择 `metis-pi`。Git 安装可使用 `pi install git:git@github.com:Rycen7822/metis-pi.git`。本包保留独立执行工具，安装前应移除或禁用独立的 `@howaboua/pi-codex-conversion`，避免同名工具重复注册。

Metis 内置维护 `pi-web-access`、`pi-session-recall` 和 `@narumitw/pi-lsp`。激活前应移除或禁用原来的独立 npm 包入口，避免重复工具或 `/lsp` 命令；原文件和历史会话保留。详见[内置维护扩展](docs/features/managed-plugins.md)和 [LSP 指南](docs/features/lsp.md)。

可按 Pi 的包入口过滤禁用独立功能，例如在包配置中使用 `"extensions": ["-extensions/goal.ts"]`。详细用法见[功能手册](docs/README.md)。

## 功能

| 功能 | 行为与说明 |
| --- | --- |
| [工具转录](docs/features/display.md) | 内建工具的紧凑标题、探索分组、流式 write 预览与 edit/write diff；第三方工具保留自己的 renderer。 |
| [思考显示](docs/features/display.md#思考块) | 流式显示最新 6 行，结束后折叠；左键切换折叠/可滚动窥视，右键切换全展开/关闭；全展开时左键不变，Ctrl+T 保留宿主行为。 |
| [输入与状态](docs/features/interface.md#输入区) | 灰色输入面、模型/上下文信息；[Working/footer](docs/features/interface.md#统计口径) 显示运行阶段、实测输出速度、用量和未提交改动量。 |
| [选区复制](docs/features/selection-copy.md) | fullscreen 下将所选显示内容按来源映射还原为逻辑文本；无法验证的行回退原生提取。 |
| [长历史](docs/features/interface.md#全屏历史与留白) | 最多保留 5,000 显示行的窗口，按需翻页并释放派生缓存；原始会话记录保留。 |
| [goal](docs/features/goal.md) | `/goal` 设定持久目标、计时与预算，按目标状态跨轮续跑。 |
| [多 skill](docs/features/skills.md) | 一次输入多个 skill，展开为宿主格式并在转录中合并折叠。 |
| [ast-grep skill](docs/features/skills.md#随包-skills) | 随 Metis 安装和更新的结构搜索指导及规则参考，由 Pi 原生发现；需要 PATH 中已有 `ast-grep`，不自动安装 CLI 或增加服务。 |
| [MCP](docs/configuration.md#mcp) | 默认关闭；缓存目录、按需连接、空闲回收，共用 Pi 原生 CLI/OAuth 与工具权限。 |
| [Neural Search](docs/features/neural-search.md) | 一个 deferred `neural_search` 聚合本地路径/内容搜索；常驻简短目录，原生 `tool_search` 发现后直接调用，Rust 引擎与集成均由 Metis 维护，支持 Linux x64（glibc ≥2.31）。 |
| [LSP](docs/features/lsp.md) | 一个 direct `lsp` 工具，以 `action: diagnostics/fix` 和扁平参数调用；修复默认预览，`/lsp` 查看命令可用性。只按名字的只读 allowlist 须另按参数限制写入。 |
| [子代理](docs/subagents/native.md) | metis 原生维护持久 Pi 子代理；工具 deferred 按需发现，默认经原生 codemode 调用，支持明确问题和完成唤醒。Linux/WSL 需 Python 3.11+；通过 Pi 配置选择一个子代理提供者。 |
| [执行工具](docs/execution.md) | 为 Pi 原生 codemode 提供按需调用的 PTY 工具；普通图片使用 Pi `read` + `image()`，provider 和登录由 Pi 提供。 |
| [Dynamic agents](docs/features/dynamic-agents.md) | 按 provider/模型从全局 TOML 选择全局指令策略，在下一次 agent run 生效；仅替换请求中的全局指令，保留项目规则和源文件。 |
| [Action Fusion](docs/features/action-fusion.md) | 原生 edit/write 支持 `then_run`；修改成功后执行命令，分别保留状态、diff 和完整日志，支持 Pi 原生 codemode 调用；排除 `extensions/action-fusion.ts` 可统一关闭所有融合入口。 |
| [Codex 远端压缩](docs/features/codex-compaction.md) | `openai` / `openai-codex` 的 `/compact` 与自动压缩支持远端加密 checkpoint，持久化回放；ChatGPT OAuth Responses 可经旧 Codex 路径压缩。 |
| [condense](docs/features/condense.md) | 默认关闭，沿用 contextPrune；独立测量确定性替换，付费摘要须满足压力和完整消息 proxy 预算；不足时保留待处理证据，支持分页回读与 token 用量显示。 |

metis 自有偏好统一使用全局 `~/.pi/agent/metis-pi.toml`（跟随 `PI_CODING_AGENT_DIR`），不再使用项目 metis 覆盖。`/metis-config init` 在缺少 TOML 时按默认值创建配置并安装同目录[参数说明](metis-pi-config.md)，不导入、改写或备份其他配置文件。LSP 只读 `[lsp]`，旧 LSP JSON 的配置值须手动复制，init 不导入。已有 TOML 直接编辑所需配置项并保留个性化值；子代理后端也使用 `[subagents]`，须先安全结束任务再重启 daemon 生效。[TOML 模板](metis-pi.toml)列出全部默认值。`[appearance] enabled = false` 只关闭显示层；Pi 自有模型/主题/packages/MCP 凭据仍留原处。详见[配置参考](docs/configuration.md)。

## 兼容边界

- 显示层只接管来源明确的 Pi 内建工具；未知宿主形状、第三方补丁或不可修改原型会退避，原因见 `/codex-ui`。
- 精确复制依赖 fullscreen 应用选区；Markdown 表格、未知 token、图片等保留原生回退。终端原生选区不受此插件控制。
- 5,000 行是保留窗口上限；单个超大组件仍可能完整排版一次，原生搜索仅覆盖已加载窗口。
- 本包的主界面外观与其它替换 editor/footer/Working 的插件可能冲突。`pi-copy-soft-wrap` 的启发式复制由本包精确路径接管，建议只保留一套。
- 随包原生 PTY helper 仅包含 linux-x64 载荷，详见[执行工具](docs/execution.md)。

[兼容性说明](docs/compatibility.md)记录宿主契约与限制，不保证任意插件组合完全兼容。

## 开发

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

运行可见交互检查用 `npm run test:pty`，静态预览用 `npm run preview`。具体测试范围、源码检查与文档维护见[开发说明](docs/development.md)；模块职责见[架构](docs/architecture.md)，版本差异见[CHANGELOG.md](CHANGELOG.md)。

## 来源与许可

基于 `pi-codex-style-tools` 修改，保留 MIT 许可。goal 衍生代码使用 Apache-2.0 上游，codex-conversion 和内置 LSP 使用 MIT 上游；归属及修改说明见 [NOTICE](NOTICE)、[LICENSE](LICENSE)、[LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)。本项目与 OpenAI、Pi 上游无官方关联。

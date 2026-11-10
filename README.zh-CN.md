# metis-pi

[English](README.md) | **简体中文**

Pi 的 Codex 风格转录界面与工作流扩展。**Metis 0.21.0 仅适配 Pi 1.5.2**，需要 Node.js **22.19.0+**。

## 安装

```bash
pi install git:git@github.com:Rycen7822/metis-pi.git
# 本地开发：npm install 后执行 pi install .
```

安装或更新 Metis 前先使用 Pi 1.5.2；旧 SDK 不再支持。官方 managed 布局通过普通 Git/npm 安装或 `pi update --extensions`，会自动安装随包预编译的 [SDK 补丁](sdk-patches/pi-1.5.2/README.md)。Metis 准备完整新发行目录后切换启动指针，旧目录和用户数据保留；重启 Pi 后生效，`/reload` 无法替换运行中的 SDK。其他 Pi 版本或非 managed 布局保持原样并提示。

重启 Pi 并选择 `metis-pi` 主题。先禁用同名独立提供者：`@howaboua/pi-codex-conversion`、`pi-web-access`、`pi-session-recall`、`@narumitw/pi-lsp`，以及 agent-stuff 的 BTW/commit/github/uv 资源；原文件和会话保留。详见[内置维护扩展](docs/features/managed-plugins.md)和 [LSP](docs/features/lsp.md)。

用 Pi 包入口过滤单独停用功能，例如在包配置中设 `"extensions": ["-extensions/goal.ts"]`；详见[功能手册](docs/README.md)。

## 功能

| 功能 | 行为 |
| --- | --- |
| [工具转录](docs/features/display.md) | 内建工具紧凑行、探索分组、流式 write 预览与 diff；第三方保留原生 renderer。 |
| [思考显示](docs/features/display.md#思考块) | 流式显示最新 6 行，结束折叠；左键切换窥视，右键切换全展开/关闭，Ctrl+T 沿用宿主。 |
| [输入与状态](docs/features/interface.md#输入区) | 灰色输入区、模型/上下文、Working 阶段、实时估算/校准速度、用量及未提交改动。 |
| [选区复制](docs/features/selection-copy.md) | fullscreen 应用选区还原逻辑原文，无法验证的内容回退原生提取。 |
| [长历史](docs/features/interface.md#全屏历史与留白) | 最多保留 5,000 显示行，按需翻页、释放派生缓存；原始记录完整保存。 |
| [goal](docs/features/goal.md) | `/goal` 管理持久目标、计时、预算及跨轮续跑。 |
| [BTW](docs/features/managed-plugins.md#btw-旁路对话) | 沿用当前 Pi 模型/认证的旁路对话，可将摘要送回主会话。 |
| [多 skill](docs/features/skills.md) | 一次展开多个 skill，在转录中合并折叠。 |
| [随包 skills](docs/features/skills.md#随包-skills) | `ast-grep`、`commit`、`github`、`uv`；外部 CLI 另装。 |
| [MCP](docs/configuration.md#mcp) | 默认关闭；缓存发现、懒连接、空闲回收，共用原生 CLI/OAuth 与权限。 |
| [Neural Search](docs/features/neural-search.md) | 经 `tool_search` 发现 deferred `neural_search`，提供原生路径/内容搜索及 CPU 语义搜索。 |
| [LSP](docs/features/lsp.md) | direct `lsp` 诊断/修复，`write: true` 才写入；只读策略请同时检查 `action` 和 `write`。 |
| [子代理](docs/subagents/native.md) | 持久 Pi 子代理、deferred codemode 工具、问题与完成唤醒；需 Python 3.11+，只启用一个提供者。 |
| [执行工具](docs/execution.md) | deferred PTY 会话；图片用 Pi `read` + `image()`，provider 和登录归 Pi。 |
| [Dynamic agents](docs/features/dynamic-agents.md) | 按 provider/模型选择下一 run 的全局指令，保留项目规则与源文件。 |
| [Action Fusion](docs/features/action-fusion.md) | edit/write 成功后执行 `then_run`，分别保留状态、diff 和日志。 |
| [远端压缩](docs/features/codex-compaction.md) | OpenAI/Codex 加密检查点、持久化回放与跨模型恢复。 |
| [condense](docs/features/condense.md) | 默认关闭的 contextPrune；证据可回读，付费摘要受压力/预算约束，用量单列。 |

偏好统一存于全局 `~/.pi/agent/metis-pi.toml`（跟随 `PI_CODING_AGENT_DIR`），项目级覆盖不在支持范围内。`/metis-config init` 创建缺失默认配置及[参数说明](metis-pi-config.md)，已有 TOML 直接编辑，缺项采用[默认模板](metis-pi.toml)。旧 LSP JSON 须手工迁移，子代理后端变更后须安全重启 daemon。`[appearance] enabled = false` 只关显示；Pi 的模型/主题/packages/trust/MCP 凭据仍留原处。详见[配置参考](docs/configuration.md)。

## 兼容边界

- 只接管来源明确的内建工具；陌生宿主、外来补丁或冻结原型走原生，`/codex-ui` 说明原因。
- 精确复制依赖 fullscreen 应用选区；表格、未知 Markdown、图片和终端原生选区保留各自回退。
- 5,000 行限制显示窗口；超大组件可能完整排版一次，原生搜索只查已加载历史。
- editor/footer/Working 替换可能冲突；与 `pi-copy-soft-wrap` 只能启用其一。
- 随包 PTY/FFF 支持 Linux x64（FFF 要求 glibc ≥2.31）及 Windows 10/11 x64；Windows 需 Git Bash，semantic 另需准备 Linux x64 运行包。更新已加载原生资产前先退出 Pi。

[兼容性](docs/compatibility.md)列出契约与限制，插件组合请以实测为准。

## 开发

```bash
npm ci --ignore-scripts --bin-links=false --no-audit --no-fund
npm run verify
```

`npm run test:pty` 检查终端交互，`npm run preview` 生成静态预览。[开发说明](docs/development.md)涵盖检查/构建/发布，[架构](docs/architecture.md)列出所有权，[CHANGELOG](CHANGELOG.md)记录版本变更。

## 来源与许可

基于 `pi-codex-style-tools`（MIT）；goal、BTW、commit/github/uv 保留 Apache-2.0 来源，codex-conversion 与 LSP 保留 MIT 来源。详见 [NOTICE](NOTICE)、[LICENSE](LICENSE)、[LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)。本项目与 OpenAI、Pi 上游无官方关联。

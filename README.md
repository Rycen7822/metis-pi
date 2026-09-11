# pi-codex-appearance

**默认启用的 Codex 风格工具转录界面。** 安装后，Pi 原生工具使用紧凑工具行、运行状态、探索记录、折叠输出与 diff 预览。模型、工具执行与上下文处理保持原有路径。

版本：**0.8.0**。面向用户当前使用的 classic Pi **0.85.1** 接口。0.8.0 起，本插件独立负责主界面外观（0.7.x 的 Zentui 协同方案已随 0.7.0 发布并废弃）：Codex 风格 composer 外框、状态行（model · effort · cwd · context%）、极简真实身份启动头、`Working · 38s` 工作计时（`agent_start`→`agent_settled` 单一交互时钟，重试/压缩续接不重置）、结束后的 `Worked for …` 摘要（可随会话恢复）、thinking 光条与 `Thought for Xs` 自动折叠标签、write 实时预览、探索分组、工具行与 diff 全部在本包内完成。以 openai/codex 固定参考提交 1b83e5c 为视觉与行为 reference，全部仅作用于显示层。

配置：`~/.pi/agent/codex-appearance.json`（可省略）。`enabled: false` 为总开关；`thinking.rail` / `thinking.autoCollapse` / `writePreview.enabled` / `working.elapsed` / `summary.enabled` / `summary.persist` 可分别关闭。诊断命令：`/codex-ui`。

![由本项目渲染函数生成的预览，非真实 Pi 会话截图](docs/preview.png)

上图由 `src/renderers.ts` 的同一 diff layout 函数生成 ANSI 文本，再渲染到 HTML。0.4.0 的预览包含整行 diff 背景、悬挂缩进与语法高亮 shell 行；它仍不是完整 Pi 或用户全部插件的联合实测。

## 默认显示

```text
• Explored
  └ Read src/server.ts (lines 1–120)

• Ran npm test
  └ Running unit tests...
    … +24 lines (ctrl+o to expand)
    tests passed

• Edited src/server.ts (+2 -1)
  12  export function startServer() {
  13 -  server.listen(3000);        ← muted red full-row surface
  13 +  const port = Number(...);   ← muted green full-row surface
  14 +  server.listen(port);        ← muted green full-row surface
  15  }
```

- **命令执行**：`Running → Ran`，标题加粗。命令在换行**前**按 Codex Catppuccin Mocha 调色板做完整语法高亮（executable 蓝、keyword 紫、string 绿、number 橙、operator 青、parameter 红、builtin 红壳、comment/标点灰蓝）；continuation 行 `  │ ` 最多 2 个屏幕行。输出首行 `  └ `、后续行 4 空格，wrap 后最多 5 个屏幕行，超出做 middle truncation。错误前景标红。
- **文件探索**：`read/grep/find/ls` 使用 `Exploring → Explored`，动作动词使用 ANSI cyan，查询与路径之间的 ` in ` 使用 dim。成功输出默认折叠；点击工具行或使用 Pi 当前的工具展开快捷键可查看所有文本块。快捷键提示来自 Pi，自定义键位不会被覆盖。
- **文件修改**：`edit` 采用 Codex 式 `行号 + 空格 + +/- + 内容`：删除行整行背景 `#4A221D`，新增行整行背景 `#213A2B`（truecolor；ANSI-256 使用 22/52；ANSI-16 仅前景色），diff 正文按文件扩展名做语法高亮且前景 reset 不清除 diff 背景；换行后内容悬挂对齐到正文列，context 行无背景，Pi 自带的 compact context window 不再二次截断。
- **写入（write）**：内建 `write` 工具在 `tool_execution_start` 读取 pre-image、`tool_execution_end` 验证 post-image，只在可靠时呈现结果：新文件显示 `Added path (+N -0)` 与全绿新增面，覆盖写显示 `Edited path (+A -D)` 与真实 diff；二进制、超大、不可读、post 不匹配或任何不确定场景一律 fallback 到原始内容预览，**绝不伪造 diff**。追踪状态是 ephemeral 的（进程内存），不写盘、不进会话记录。
- **图像结果**：保留 Pi 原生图片显示路径，服从 `terminal.showImages`。关闭图片预览时显示轻量图片数量提示，不输出 Base64。
- **配色**：中性文字、灰色层次、红绿 diff 和错误色；shell 输出保留安全 SGR 颜色序列、剥离其他控制序列；主题不强制终端背景色。

每个工具调用保留独立的显示与展开状态，不跨调用合并结果。连续探索不会完全复现 Codex 的跨调用聚合。输入框、页脚、Working line、思考块、审批流程和快捷键沿用现有插件；本项目没有复制另一套完整终端客户端。

## 本地安装

解压本版本压缩包，然后执行：

```bash
pi install /绝对路径/pi-codex-appearance
```

重新启动 Pi。**紧凑转录布局默认生效，无需另行启用 optional 扩展。**

在 `/settings` 选择 `codex-appearance` 可同时应用中性配色。也可以只修改现有 `~/.pi/agent/settings.json` 的这个字段，保留其他内容：

```json
"theme": "codex-appearance"
```

原生工具采用 self-shell，因此即便仍使用原有 `dark` 主题，也会移除这些工具的外层卡片。第三方工具自带的布局继续保留；配套主题可以统一使用主题 token 的背景色，但不会强行覆盖插件硬编码的颜色。

若已经安装上游 `pi-codex-style-tools`，先移除上游包，避免它继续注册同名工具及改写搜索结果。移除旧包后重新启动。0.1.0 用户应移除自己额外添加的 `optional/format-tools.ts` 条目；0.2.0/0.3.0 都自动加载 `index.ts`。

## 与现有插件的边界

工具来源通过 Pi 的 `sourceInfo` 核对。**只有明确来自 Pi 内建实现的工具会使用新的 renderer。** FFF/LSP 等插件即便覆盖相同的 `read/grep/find/edit` 名称，也会保留其 renderer。

| 已有功能/插件 | 本项目的处理 |
| --- | --- |
| FFF、LSP 的同名工具覆盖 | 保留来源为扩展的工具定义、执行函数与 renderer |
| `pi-codex-conversion` 的结构化工具 | 不接管 `exec_command/apply_patch/...` |
| Web、MCP、session recall、subagent、询问工具 | 不注册对应工具，不改写其搜索内容或结果 |
| RTK、condense、contextPrune | 不监听 `tool_call/tool_result/context/before_agent_start` |
| `pi-zentui` | 保留 editor、footer、Working line；不增加第二套计时器 |
| `pi-copy-soft-wrap` 与思考快捷键 | 不改 TUI 根渲染器、终端输出、复制接口、思考块或快捷键 |

这些结论描述代码边界与契约测试范围。没有在用户的整套已安装插件实例上完成联合运行，不能据此宣称任意版本的任意插件都零冲突。

## 实现与退避

扩展没有 `registerTool()`，不重新创建内建工具，不修改工具参数、执行结果、会话记录、模型上下文或系统提示词。上游的 `compactSearchResult` 与全局结果改写已删除。

针对已核对的 Pi 0.85.1 UI，扩展装饰 `ToolExecutionComponent` 的三个 renderer/shell selector 以及这个**工具行组件自身**的 `render()`。默认构造的子组件树保持不变；首次实际绘制时切换 self-shell 并填充显示内容。这使卸载后可以还原原有卡片，不需要剪切 children，也不改写鼠标命中或图片协议。

以下情况会退避：已有 selector/render patch、接口形状未知、来源不明、第三方自渲染工具、原型不可修改。启动时会给出警告，说明紧凑转录没有安装；不会默默宣称已启用。后来插件修改同一接口时，本项目退回原有 selector，并在卸载时避免覆盖后来者。内部 UI 接口未来仍可能变化，详见 [兼容性说明](docs/compatibility.md)。

## 测试与预览

无需调用模型的核心检查：

```bash
npm test
npm run check:core
npm run preview
```

完整宿主检查需要 Node.js **>=22.19.0** 和真实 Pi 依赖：

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run verify
```

`test:host` 使用真正的 Pi `ToolExecutionComponent`，不以 mock 包替代依赖。当前交付环境未能下载该依赖；完整宿主检查及完整插件联合运行仍未验证。已经执行的检查、失败项目与环境记录见 [VALIDATION.md](VALIDATION.md)。

## 来源与许可

基于用户提供的 `pi-codex-style-master.zip` 修改，保留上游 MIT 许可。来源和归属见 [NOTICE](NOTICE)。本项目与 OpenAI、Pi 上游无官方关联。

# 结构化提问

当用户决策无法从需求或仓库证据中确定时，交给 `ask_user_question`。该工具需要交互 UI，并要求全局 `[askUserQuestion].enabled=true`。两者缺一，工具就会隐藏。

## 按需发现

工具为 deferred，经原生 `tool_search` 加载，或在 codemode 中查询：

```js
text(await describeTool("ask_user_question"));
// 按 schema 组装 questions，再调用 await tools.ask_user_question(args)。
```

Metis 只启用 Pi 现有的发现入口。问卷经显式激活后保持可用。工具名被其他扩展占用时，Metis 让出并给出提示。

## 等待模式

每次调用在顶层参数中选择模式：

- `mode: "blocking"`：持续等待，直到用户提交、取消，或工具执行被中断。省略 `mode` 时即为此值，旧调用因此保持兼容。
- `mode: "skip"`：整份问卷最多等待 10 分钟。到期仍未提交则自动关闭，返回 `details.timedOut: true` 和未回答的题目。agent 可以继续不依赖这些答案的工作。切题、切换弹窗、RPC 换题都沿用同一期限。

超时只表示用户还没有作答，它不代表同意、拒绝或默认选项。授权以及必须由用户决定的问题使用 `blocking`。TUI 中未提交的草稿视为未回答；RPC 中已完成的题目保留在超时结果中。正常提交、主动取消和异常结束都会清理定时器、弹窗和等待状态。

```js
const result = await tools.ask_user_question({ mode: "skip", questions });
text(result);
```

## 问卷行为

- 一次 1 至 4 题，每题 2 至 4 个选项。支持多选、自定义输入、单选预览和终端备注。RPC 使用原生的 select 与 input，预览并入标题。
- Esc 取消。执行取消会关闭挂载并释放问卷位置。自定义输入中取消，会退回选项列表。提交页用 PageUp 与 PageDown 查看答案与备注，↑ 与 ↓ 选择提交或取消。
- 外部编辑器退出、临时文件清理和终端恢复完成之后，才释放问卷位置。关闭后到达的迟到结果会被丢弃。长输入保持光标可见。窄屏下按空间裁剪预览。
- 安装 rpiv-i18n 时注册对应语言，否则使用英语。

## 配置

```toml
[askUserQuestion]
enabled = true
collapseKey = "ctrl+]" # "off" 关闭折叠键

# [askUserQuestion.guidance]
# description = "Ask only for a blocking decision."
# promptSnippet = "Ask before guessing."
# promptGuidelines = ["Batch related questions."]
```

`enabled` 必须是布尔值。配置无效时，Metis 会告警并隐藏工具。guidance 中的非空字段整体覆盖对应的说明，注册时读取一次，修改后需 `/reload`。`collapseKey` 每次调用时读取，非法值回退为 `ctrl+]`。取消、确认、提交键优先于它。

实现、MIT 许可与来源见 [`src/ask-user-question/`](../../src/ask-user-question/METIS.md)。

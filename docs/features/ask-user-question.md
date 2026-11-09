# 结构化提问

需求或仓库证据无法确定的用户决策，交给 `ask_user_question`。工具要求交互 UI 和全局 `[askUserQuestion].enabled=true`，两者缺一即隐藏。

## 按需发现

工具为 deferred，经原生 `tool_search` 加载，或在 codemode 中查询：

```js
text(await describeTool("ask_user_question"));
// 按 schema 组 questions，再 await tools.ask_user_question(args)。
```

Metis 只启用现成的原生发现入口，问卷经显式激活后保持可用。工具名被其他扩展占用时让出并提示。

## 等待模式

每次调用在顶层参数中选择：

- `mode: "blocking"`：持续等待，直到用户提交、取消或工具执行被中断。省略 `mode` 时为此值，旧调用保持兼容。
- `mode: "skip"`：整份问卷最多等待 10 分钟，到期未提交自动关闭，返回 `details.timedOut: true` 与未回答题目，agent 可继续不需要这些答案的工作。切题、切弹窗、RPC 换题沿用同一期限。

超时表示用户尚未作答，含义独立于同意、拒绝和默认选项。授权及必须由用户决定的问题使用 `blocking`。TUI 未提交的草稿视为未回答；RPC 已完成的题目在超时结果中保留。正常提交、主动取消、异常结束都会清理定时器、弹窗和等待状态。

```js
const result = await tools.ask_user_question({ mode: "skip", questions });
text(result);
```

## 问卷行为

- 一次 1–4 题，每题 2–4 个选项，支持多选、自定义输入、单选预览和终端备注；RPC 使用原生 select/input，预览并入标题。
- Esc 取消；执行取消会关闭挂载并释放问卷位置，自定义输入中取消退回选项。提交页用 PageUp/PageDown 查看答案与备注，↑/↓ 选择提交或取消。
- 外部编辑器退出、临时文件清理、终端恢复之后才释放问卷位置，关闭后到达的迟到结果丢弃；长输入保持光标可见，窄屏按空间裁剪预览。
- 有 rpiv-i18n 时注册语言，缺省使用英语。

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

`enabled` 必须为布尔值，配置无效时告警并隐藏工具。guidance 的非空字段整体覆盖对应说明，注册时读取一次，修改后 `/reload`；collapseKey 每次调用读取，非法值回退 `ctrl+]`，取消/确认/提交键优先于它。

实现、MIT 许可和来源见 [`src/ask-user-question/`](../../src/ask-user-question/METIS.md)。

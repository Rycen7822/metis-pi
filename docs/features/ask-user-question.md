# 结构化提问

`ask_user_question` 用于需求或仓库证据无法解决的用户决策。入口依赖交互 UI 和全局 `[askUserQuestion].enabled=true`；关闭或无 UI 时隐藏。

## 按需发现

工具为 deferred，可经原生 `tool_search` 加载，或在 codemode 中查询：

```js
text(await describeTool("ask_user_question"));
// 按 schema 构造 questions，再 await tools.ask_user_question(args)。
```

Metis 启用可用的原生发现入口，不在每轮自动激活问卷；显式激活后保持可用。其他扩展已占用工具名时让出并提示。

## 等待模式

由 agent 在每次调用的顶层参数中选择：

- `mode: "blocking"`：持续等待，直到用户提交、取消或工具执行被中断。省略 `mode` 时使用此模式，兼容已有调用。
- `mode: "skip"`：整份问卷最多等待 10 分钟；未提交则自动关闭，返回 `details.timedOut: true` 和未回答题目，让 agent 继续不依赖这些答案的工作。切换题目、弹窗或 RPC 对话不重置期限。

超时与用户主动取消不同，不代表同意、拒绝或选择默认选项。授权及必须由用户决定的问题使用 `blocking`。TUI 未提交草稿不当作答案；RPC 已完成的题目答案在超时结果中保留。正常提交、主动取消及异常结束会清理定时器、弹窗和等待状态。

```js
const result = await tools.ask_user_question({ mode: "skip", questions });
text(result);
```

## 问卷行为

- 每次 1–4 题，每题 2–4 选项，支持多选、自定义输入、单选预览和终端备注。RPC 使用原生 select/input，预览并入标题。
- Esc 取消；执行取消关闭挂载并释放问卷位置，自定义输入取消返回选项。提交页支持 PageUp/PageDown 查看答案与备注，↑/↓ 选择提交或取消。
- 外部编辑器退出、临时文件清理和终端恢复后才释放问卷位置，关闭后忽略迟到结果。长输入保持光标可见，窄屏预览按空间裁剪。
- 可选 rpiv-i18n 提供语言注册，否则使用英语回退。

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

`enabled` 必须是布尔值；无效配置会告警并隐藏工具。guidance 的非空字段完整覆盖对应说明，注册时读取，修改后 `/reload`；collapseKey 调用时读取，非法值回落默认 `ctrl+]`，模式中的取消/确认/提交键优先。

实现、MIT 许可和来源见 [`src/ask-user-question/`](../../src/ask-user-question/METIS.md)。

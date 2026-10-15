# 结构化提问

Metis 内置维护 `ask_user_question`（基于 rpiv-ask-user-question 2.13.8，MIT），只在无法从需求或仓库证据解决的阻塞决策上向用户提问。

## 按需发现

工具默认为 `deferred`，完整参数不常驻模型声明。需要提问时先发现参数，再调用：

```javascript
text(await describeTool("ask_user_question"));
// 按发现的 schema 构造 questions，随后 await tools.ask_user_question(args)。
```

也可使用原生 `tool_search`，加载后直接调用。Metis 在会话启动时启用可用的原生发现入口，不在每轮自动激活问卷；显式发现/激活后的工具保持可用。入口缺失或被禁用时提示，不假装工具可调用。没有 UI 时工具隐藏，不出现在发现或可调用列表中。

## 问卷行为

每次 1–4 个问题，每题 2–4 个选项，支持多选、自定义输入、单选预览和终端备注。保留原返回格式、参数修复/校验、Esc 取消、并发 inline/overlay 和快捷键；RPC 使用原生 select/input（无终端备注，预览并入标题）。执行取消会关闭挂载、释放问卷位置并结束 RPC 等待；取消自定义答案输入仍返回选项列表。可选 rpiv-i18n 存在时沿用其语言注册，否则采用英语回退。 多问题的提交页支持 PageUp/PageDown 滚动查看全部答案和全局备注，↑/↓ 选择提交或取消；打开备注编辑器时，翻页键交由编辑器处理。

外部编辑器随问卷取消，并在进程退出、临时文件清理及终端恢复后释放问卷位置；已经关闭的问卷不会接受迟到的编辑结果。自定义长输入滚动时保持光标可见，窄屏预览保留闭合边框并裁剪提示，放不下完整边框时隐藏预览。

## 配置与升级

只读 `<agentDir>/metis-pi.toml`：

```toml
[askUserQuestion]
enabled = true
collapseKey = "ctrl+]" # 或 "off"

# 可选，完整替换非空字段：
# [askUserQuestion.guidance]
# description = "Ask only for a blocking decision."
# promptSnippet = "Ask before guessing."
# promptGuidelines = ["Batch related questions."]
```

旧 `~/.config/rpiv-ask-user-question/config.json` 不再读取；需要的快捷键/说明须复制到上述 TOML。读取不会修改文件；损坏 TOML 明确提示并隐藏工具。说明在注册时读取，修改后 `/reload`；快捷键在调用时读取。

安装本包时先移除旧 `npm:@juicesharp/rpiv-ask-user-question`，避免重复工具所有权。旧插件仍加载时 Metis 提示并让出工具，不覆盖它。源码接管不等于卸载或安装；个人配置迁移应保留备份。

来源及本地改动见 `src/ask-user-question/METIS.md`。

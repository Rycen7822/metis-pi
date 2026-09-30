# Pi 原生 codemode 的执行补充

需要 **Pi >=0.99.1**。Pi 负责 JS 编排、工具发现和权限、模型目录、OAuth、provider 与普通 compaction。metis 补充进程会话和脚本图片返回，入口为 `extensions/execution.ts`。

## 选择工具

沿用 Pi 默认工具集合。通过 Pi `--tools` 或 `settings.json.defaultTools` 选择 `codemode`；CLI 自带该扩展，SDK 使用者需加入 `createCodemodeExtension()`。

`exec_command`、`write_stdin`、`view_image` 注册为 **deferred**：原生脚本可以调用，Pi 工具发现可找到；默认不列进顶层和 codemode 的内联工具说明。它们仍是额外工具。需要直接调用时，将相应名字加入自己的 Pi 工具集合；goal、历史回读等工具也由 Pi 的工具选择管理。

- 普通命令使用 Pi `bash`，普通修改使用 Pi `edit/write`。
- 长期或交互进程使用 `exec_command` 建立会话；后续脚本用返回的 `session_id` 调用 `write_stdin`，输入文字或继续读取输出。
- 图片脚本：`image(await tools.view_image({path:"image.png"}))`。Pi `read` 在脚本中只返回图片文字，不自动转发到外层结果。文本回退返回 `{description}`，可用 `text(result.description)`。
- Pi codemode 的 `store/load` 在脚本成功后提交，失败不提交；已经发生的文件或进程副作用不随 store 回滚。

## 执行配置

配置位于 `<agentDir>/metis-pi.json` 的 `execution` section；可信项目可在 `<cwd>/.pi/metis-pi.json` 覆盖。

```json
{
  "execution": {
    "tools": { "autoReasoning": false, "customRustBinariesDir": "", "viewImageFallback": false },
    "ui": { "toolRenaming": true, "backgroundShellWidget": true,
      "backgroundShellToggleShortcut": "alt+w", "backgroundShellPrevShortcut": "alt+q",
      "backgroundShellNextShortcut": "alt+e", "backgroundShellCloseShortcut": "alt+r" }
  }
}
```

`/execution` 写全局配置，`/execution project` 写可信项目配置；原子更新所选字段，保留其他 section 和未知字段。快捷键修改后重启；`alt+q` 与宿主冲突时可将上一项改为 `alt+u`。

`autoReasoning` 默认关闭。开启且当前模型支持 reasoning 时，`change_reasoning` 作为 deferred 工具可用，以用户开始时的 thinking level 为下限，run 结束恢复仍由该策略持有的级别。

`viewImageFallback` 默认关闭。开启后，文本模型通过 Pi 注册表中已认证的 OpenAI Codex 图片模型生成描述；优先可用 mini，否则使用可用的 gpt-5.6-luna。没有可用模型时明确报错，使用 Pi 的认证。

## 输出、归档与资源

- PTY 工具返回显示文本和结构化结果。大输出位于会话旁 `<sessionId>-blobs/`，返回路径及完整性标志。交互输入、完成结果和显示缓冲各自保持原生命周期。
- 原生 nested 调用通过 condense 的 indexer/spill 归档；`context_tree_query({parentToolCallId})` 回读完整子结果。受保护、失败、未完成和归档失败会传播到父结果。
- Pi edit/write 的 `then_run` 保留修改结果、命令状态、差异与完整日志，见 [Action Fusion](features/action-fusion.md)。
- Responses 图片请求按调用及图片序号恢复 detail；显式 original 保存原始字节，分叉沿用来源会话 blobs。复制会话时一并保留 blobs。同一原生脚本输出相同字节且要求不同 detail 时明确报错，需要拆成独立调用。
- 安装和启动使用随包 PTY/图片 helper，不下载 JS host、不编译 Rust。目前随包 helper 平台为 Linux x64。

## 升级后的调用变化

metis 的 V8 `exec/wait`、JS cell 续跑、执行中通知、timers、TOML 工具和独立 `apply_patch` 已退役。原生 codemode 采用 Pi 的 API 与 `// @options`。长期进程可以跨脚本输入/读取，JS 单元格不继续执行。文件编辑改用 Pi edit/write；重命名、删除使用明确命令。

更新不改写个人配置或会话，不自动转换旧脚本。旧输出、condense 原文与图片 sidecar 保持可读，恢复后的新调用使用当前工具。需要重跑旧 V8 脚本时转换调用，或在升级前版本中完成导出。

旧 conversion 入口与配置、特殊上下文已在前一轮退役。专有窗口或 opaque checkpoint 需要通过旧版本导出可读历史，再创建普通 Pi 会话；原始文件保留用于回退。

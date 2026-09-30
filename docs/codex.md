# 执行模块与 Pi 原生交接

需要 **Pi >=0.99.1**。入口为 `extensions/execution.ts`，执行工具在 `src/execution/`，独立 V8 编排在 `src/code-mode/`。模型目录、OAuth 登录、provider 请求、普通 compaction 和通用 Code Mode 由 Pi 负责。

## 选择工具

安装后沿用 Pi 的默认工具集合，不按模型名覆盖。metis 的 `exec_command`、`write_stdin`、`apply_patch`、`view_image` 注册为可供原生 `codemode` 调用的工具，不会自动替换 `bash/read/write/edit`。

- 图片脚本用法：`image(await tools.view_image({path:"image.png"}))`；文本回退返回 `{description}`，可用 `text(result.description)`。
- 原生编排：通过 Pi 的 `--tools` 或 `settings.json.defaultTools` 选择 `codemode`，可使用 Pi 的普通工具和 metis 执行工具。Pi CLI 自带该扩展；SDK 使用者需要加入 Pi 的 `createCodemodeExtension()`。
- 长时间 V8 单元格：同时选择 `exec` 和 `wait`。例如 `pi --tools exec,wait`。`exec` 支持共享单元格 JSON 存储、长工具等待、主动让出及插话后继续观察；`wait` 续读或终止单元格。
- 直接调用 metis 执行工具：把相应工具名加入自己的 Pi 工具集合。
- 需要 goal、todo、回读等直接工具时，也将其保留在工具集合中；`--tools` 的选择范围由 Pi 决定。

启用 V8 时隐藏原生 `codemode` 声明及 V8 已适配的执行工具声明。未适配的直接工具仍可单独调用。V8 保留已有单元格专用适配和自定义 TOML 工具，不裸执行任意 Pi callable 工具：Pi 0.99.1 公开接口不能同时提供长期 cell 的原始上下文与完整原生权限管道。通用工具的权限/结果钩子通过原生 `codemode` 运行；V8 的嵌套拦截使用独立 preflight/completion 接口。

## 执行配置

配置归入 `<agentDir>/metis-pi.json.execution`，受信任项目可在 `<cwd>/.pi/metis-pi.json.execution` 覆盖。显示配置继续仅使用全局文件。

```json
{
  "execution": {
    "tools": { "autoReasoning": false, "customRustBinariesDir": "", "viewImageFallback": false, "plainCommandOutput": false },
    "ui": { "toolRenaming": true, "compactTools": "off", "codeModeDetails": false, "backgroundShellWidget": true,
      "backgroundShellToggleShortcut": "alt+w", "backgroundShellPrevShortcut": "alt+q", "backgroundShellNextShortcut": "alt+e", "backgroundShellCloseShortcut": "alt+r" }
  }
}
```

`compactTools` 可选 `off`、`compact`、`minimal`。`/execution` 写全局配置，`/execution project` 写受信任项目配置，原子更新并保留其他 section/未知字段。快捷键改动需要重启；默认 `alt+q` 可能与宿主冲突，可设置上一项为 `alt+u`。

`autoReasoning` 是小型工具策略：仅在有 reasoning 能力的模型上生效，以用户开始时的 thinking level 为下限，run 结束恢复仍由该策略持有的级别。它不更换模型、目录或 provider。

`viewImageFallback` 默认关闭。开启后，文本模型的图片描述通过 Pi 注册表中已认证的 OpenAI Codex 图片模型生成；优先 mini，否则使用已可用的 gpt-5.6-luna。没有可用模型时明确报错，不虚构模型或另建登录。

## 输出与资源

- `exec_command` / `write_stdin` 同时保留显示文本和稳定结构化结果；大输出继续放在会话旁 `<sessionId>-blobs/`，返回原文路径及完整性标志。
- 非 TTY 默认返回可续读 session；TTY 保留输入/中断，结束结果与显示缓冲寿命分开。
- Action Fusion 保留修改结果、命令状态、差异与完整日志；见 [融合调用](features/action-fusion.md)。
- 原生 nested 调用及 V8 completion 归档复用 condense 的 indexer/spill。`context_tree_query({parentToolCallId})` 可回读父调用的子工具，包含 Pi 有界 UI 记录之外的结果；受保护、失败、未完成或归档失败的父结果不能自动精简掉。
- Responses 图片请求按工具调用和图片序号恢复 detail。显式 original 的原始字节保存在会话 sidecar；不全局关闭 Pi 图片缩放。分叉沿用来源会话的图片归档；复制会话时应同时保留来源 blobs。原生输出 helper 无法保留同字节图片的不同 detail 身份，这种含混组合会明确报错，需分成独立 codemode 调用。
- 默认原生路径不准备 V8 host。显式 V8 使用原有按需准备与缓存，host pin/协议不变。仅 Linux x64 提供随包原生工具；host 平台范围和来源见 [provenance](provenance/codex-conversion/UPSTREAM.md)。

## 旧安装与旧会话

旧入口 `src/codex/extension.ts` 和 `/codex` 退出。Pi 包入口过滤应改为 `extensions/execution.ts`，外部执行接口导入改为 `src/code-mode/` 中的真实入口，不留旧路径转导出。

旧 `pi-codex-conversion.json` 不再读取。将需要保留的 `tools` 四项和 `ui` 上述字段手工放入 `metis-pi.json.execution`；`executionMode` 改用 Pi 的工具选择。provider、scope、heavy prompt、prewarm/keepalive、Lite、Reserve、特殊 compaction/context 配置退出。更新不自动改写个人文件。

普通 Pi JSONL、普通 compaction 和 condense 归档继续使用。Local/Tree/Remote/Hybrid/V2 专有窗口与回放已退役：如需恢复，先备份指定会话和 sidecar，用升级前版本在隔离目录导出可读摘要/必要历史，再创建普通 Pi 会话。`[OpenAI native compaction checkpoint]` 是占位文字；opaque checkpoint 不能在本地解密，不代表已有可读摘要。保留原始文件与 Git 历史用于回退，不自动扫描或转换用户会话。

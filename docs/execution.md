# Pi codemode 的执行补充

JavaScript 编排、工具发现、权限和认证由 Pi 负责，`extensions/execution.ts` 补充 PTY 进程会话。平台要求见[兼容性](compatibility.md)。

## 工具选择与调用

工具集合沿用 Pi 的 `--tools` 或 `settings.json.defaultTools`：CLI 内置原生 codemode，SDK 经 `createCodemodeExtension()` 接入。

`exec_command` 与 `write_stdin` 是 deferred 工具，经 codemode 或工具发现调用；需要直接暴露时，把它们加入 Pi 工具集合。

| 需求 | 工具 |
| --- | --- |
| 普通命令和文件修改 | Pi `bash`、`edit`、`write`。 |
| 长期或交互进程 | `exec_command`，随后用 `write_stdin` 读输出或写入；交互输入需在建会话时指定 `tty: true`。 |
| 返回图片 | `image(await tools.read({path: "image.png"}))`。 |
| 修改后执行命令 | edit/write 的 `then_run`，见 [Action Fusion](features/action-fusion.md)。 |

```js
text(await tools.exec_command({cmd: "bash", tty: true}));
```

调用返回 `session_id`，用 `tools.write_stdin({session_id: 123, chars: ""})` 继续读取。进程会话可跨脚本使用；Pi `store/load` 事务只提交脚本成功后的状态，文件与进程副作用独立于该事务。

## 设置与资源

`/execution` 写入全局 TOML，字段和生效时机见[配置](configuration.md#执行字段)。

- 开启 `autoReasoning` 且模型支持 reasoning 时提供 deferred `change_reasoning`：以 run 起始的 thinking level 为下限，结束时恢复。
- PTY 大输出归档到会话旁 `<sessionId>-blobs/`，返回路径和完整性标志；显示缓冲淘汰后，恢复证据仍在。
- condense 归档 nested 子结果，用 `context_tree_query({parentToolCallId})` 回读；保护、失败、未完成和归档失败会上传到父结果。

Linux 使用随包 x64 helper，Windows 使用随包 x64 EXE。shell 配置见[兼容性](compatibility.md)，原生资产维护见[来源说明](provenance/execution/README.md)与[开发说明](development.md)。

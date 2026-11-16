# Pi codemode 的执行补充

JavaScript 编排、工具发现、权限和认证由 Pi 负责。`extensions/execution.ts` 补充 PTY 进程会话。平台要求见[兼容性](compatibility.md)。

## 工具选择与调用

工具集合沿用 Pi 的 `--tools` 或 `settings.json` 中的 `defaultTools`。CLI 内置原生 codemode。SDK 通过 `createCodemodeExtension()` 接入。

`exec_command` 与 `write_stdin` 是 deferred 工具，通过 codemode 或工具发现调用。若要直接暴露，需把它们加入 Pi 的工具集合。

| 需求 | 工具 |
| --- | --- |
| 普通命令与文件修改 | Pi 的 `bash`、`edit`、`write`。 |
| 长时间运行或交互式进程 | `exec_command`，之后用 `write_stdin` 读取输出或写入输入。交互输入需要在建会话时指定 `tty: true`。 |
| 返回图片 | `image(await tools.read({path: "image.png"}))`。 |
| 修改后执行命令 | edit、write 的 `then_run`，见 [Action Fusion](features/action-fusion.md)。 |

```js
text(await tools.exec_command({cmd: "bash", tty: true}));
```

调用返回 `session_id`。用 `tools.write_stdin({session_id: 123, chars: ""})` 继续读取。进程会话可以跨脚本使用。Pi 的 `store`/`load` 事务只在脚本成功时提交状态。文件与进程的副作用不属于该事务。

## 设置与资源

`/execution` 写入全局 TOML。字段和生效时机见[配置](configuration.md#执行字段)。

- 开启 `autoReasoning`，且模型支持 reasoning 时，提供 deferred 工具 `change_reasoning`。下限是 run 开始时的 thinking level，结束时恢复。
- PTY 的大输出归档到 session 旁的 `<sessionId>-blobs/`，返回路径与完整性标志。显示缓冲被淘汰后，恢复证据依然存在。
- condense 归档 nested 子结果，可用 `context_tree_query({parentToolCallId})` 回读。保护、失败、未完成与归档失败的信息，会上传到父结果。

Linux 使用随包的 x64 helper，Windows 使用随包的 x64 EXE。shell 配置见[兼容性](compatibility.md)。原生资产的维护见[执行模块来源](provenance/execution/README.md)与[开发说明](development.md)。

# Pi codemode 的执行补充

Pi 负责 JavaScript 编排、工具发现、权限和认证；`extensions/execution.ts` 提供 PTY 进程会话。平台要求见[兼容性](compatibility.md)。

## 工具选择与调用

沿用 Pi 的 `--tools` 或 `settings.json.defaultTools`。CLI 提供原生 codemode，SDK 使用 `createCodemodeExtension()`。

`exec_command`、`write_stdin` 为 deferred 工具，可通过 codemode/工具发现调用；需要直接暴露时加入 Pi 工具集合。

| 需求 | 工具 |
| --- | --- |
| 普通命令与文件修改 | Pi `bash`、`edit`、`write`。 |
| 长期或交互进程 | `exec_command`；后续用 `write_stdin` 读取或输入。交互输入需初始指定 `tty: true`。 |
| 返回图片 | `image(await tools.read({path: "image.png"}))`。 |
| 修改后执行命令 | edit/write 的 `then_run`，见 [Action Fusion](features/action-fusion.md)。 |

```js
text(await tools.exec_command({cmd: "bash", tty: true}));
```

根据返回的 `session_id` 调用 `tools.write_stdin({session_id: 123, chars: ""})` 继续读取。进程会话可以跨脚本使用；Pi `store/load` 在脚本成功后提交，文件和进程副作用独立于该事务。

## 设置与资源

`/execution` 修改全局 TOML，字段与生效时机见[配置](configuration.md#执行字段)。

- 开启 `autoReasoning` 且模型支持 reasoning 时，提供 deferred `change_reasoning`；以 run 初始 thinking level 为下限，结束时恢复该策略仍持有的级别。
- PTY 大输出归档到会话旁 `<sessionId>-blobs/`，返回路径与完整性标志。显示缓冲淘汰不删除恢复证据。
- condense 归档 nested 子结果，使用 `context_tree_query({parentToolCallId})` 回读；保护、失败、未完成与归档失败传播到父结果。

安装和启动使用随包 Linux x64 helper。原生资产维护见[来源说明](provenance/execution/README.md)与[开发说明](development.md)。

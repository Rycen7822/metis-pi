# 执行命令与进程会话

普通的一次性命令使用 Pi 的 `bash`。需要长时间运行、读取后续输出或向进程输入时，使用 Metis 的 `exec_command` 和 `write_stdin`。这两个工具支持[工具发现](features/tool-discovery.md)与 Codemode；工具访问受 Pi 的工具选择和权限限制。平台要求见[兼容性](compatibility.md)。

## 启动、轮询与输入

下面是 Codemode 示例。启动交互程序时必须指定 `tty: true`：

```js
const result = await tools.exec_command({ cmd: "bash", tty: true });
text(result);
```

如果返回 `session_id`，说明进程尚未退出，可在后续调用中复用该 ID。用 `chars: ""` 轮询输出，非空 `chars` 向以 TTY 启动的会话写入。没有会话 ID 时，按返回的退出状态处理，不继续轮询。

```js
text(await tools.write_stdin({ session_id: 123, chars: "exit\n" }));
```

将 `123` 换成实际 ID。Codemode 脚本失败不会回滚文件修改或已启动的进程。

## 设置与输出

- `/execution` 保存全局[执行设置](configuration.md#执行字段)。模型支持推理时，`autoReasoning` 可提供 `change_reasoning`；一次运行内不得低于起始级别，运行结束时恢复。
- PTY 大输出可归档到会话旁的 `<sessionId>-blobs/`。输出是否完整以回执为准；启用 Condense 时，可按父调用 ID [读取嵌套结果](features/condense.md#原文与分页恢复)。
- 修改成功后立即执行命令，使用 edit 或 write 的 [`then_run`](features/action-fusion.md)。
- 使用 Codemode 返回图片时，将读取结果交给 `image()`：`image(await tools.read({ path: "image.png" }))`。

# 执行命令与进程会话

普通的一次性命令使用 Pi 的 `bash`。需要长时间运行、读取后续输出或向进程输入时，使用 Metis 的 `exec_command` 和 `write_stdin`。这两个工具支持[工具发现](features/tool-discovery.md)与 Codemode；工具访问受 Pi 的工具选择和权限限制。平台要求见[兼容性](compatibility.md)。

## 启动、轮询与输入

下面是 Codemode 示例。启动交互程序时必须指定 `tty: true`：

```js
const result = await tools.exec_command({ cmd: "bash", tty: true });
text(result);
```

返回 `session_id` 表示进程仍在运行，可在后续调用中复用该 ID。用 `chars: ""` 轮询输出，非空 `chars` 向以 TTY 启动的会话写入。未返回会话 ID 时，本次调用已经结束，结果中包含退出状态或错误。

```js
text(await tools.write_stdin({ session_id: 123, chars: "exit\n" }));
```

将 `123` 换成实际 ID。Codemode 脚本失败后，已完成的文件修改和进程启动保持原状；清理需显式执行。

## 设置与输出

- `/execution` 保存全局 [执行设置](configuration.md#执行字段)。模型支持推理时，`autoReasoning` 可提供 `change_reasoning`；运行内的推理级别以起始级别为下限，结束时恢复。
- 大命令输出可归档到会话旁的 `<sessionId>-blobs/`。输出是否完整以回执为准；启用 Condense 时，可按父调用 ID [读取嵌套结果](features/condense.md#原文与分页恢复)。
- 显示用的临时文件写入失败时，内存只保留最新输出尾部：每路最多 2 MiB，所有降级缓冲合计最多 16 MiB，按 UTF-16 计。回执注明省略的偏移范围；独立归档可用时，仍可读取完整输出。
- 修改成功后立即执行命令，使用 edit 或 write 的 [`then_run`](features/action-fusion.md)。
- 使用 Codemode 返回图片时，将读取结果交给 `image()`：`image(await tools.read({ path: "image.png" }))`。

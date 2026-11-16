# 修改后执行命令

Action Fusion 让 Pi 的 edit 与 write 携带一条后续命令：修改成功后才执行该命令。修改状态、diff 与命令日志分开保存。入口为 `extensions/action-fusion.ts`，实现位于 `src/execution/action-fusion.ts` 与 `action-fusion-command.ts`。停用方法见[配置](../configuration.md)。显示层的总开关对它无效。

在参数中追加 `then_run: {command: "npm test", timeout: 60}`。timeout 单位为秒，可省略。超时后命令会被终止。只有 Pi 内置的 edit 与 write 会被包装，同名的第三方工具保持原样。

原生 codemode 示例：

```js
text(await tools.write({
  path: "example.txt", content: "hello\n",
  then_run: {command: "cat example.txt", timeout: 10}
}));
```

| 情况 | 结果 |
| --- | --- |
| 修改失败 | 跳过命令，保留诊断信息。 |
| 命令失败、超时或被取消 | 已成功的修改保留。命令状态单独记录，非零退出码写入正文。原生 codemode 调用会 reject，可用 try/catch 读取错误正文。 |
| 命令再次修改同一文件 | diff 固定在命令开始之前的状态。 |
| 并发融合 | 按规范化后的修改路径排队。排队期间被取消，则整次放弃。 |

一次融合只产生一个工具结果。assistant 与 goal 的事件流保持不变。路径队列只覆盖被修改的文件。外部进程和命令涉及的其他文件由各自管理。并行写入仍需要独立目录隔离。

完整日志在截断前写入 `<sessionId>-blobs/exec-<uuid>.log`。内存会话使用临时目录。condense 关闭后，引用依然可用。捕获失败时会标注不完整。已有的回执在 Fusion 禁用后仍可回放。

启用 condense 时，nested 调用分别归档，可按子 ID 或 `parentToolCallId` [回读](condense.md)。只有明确成功且能识别为 build 或 test 的日志会被精简。失败和未知命令保留预览。命令通过 Pi 原生 bash 执行，锁、快照与收据由 Metis 持有。

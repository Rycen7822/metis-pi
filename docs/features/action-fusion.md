# 修改后执行命令

为 Pi 内置的 `edit` 或 `write` 增加 `then_run`，可以在修改成功后立即执行验证命令。`command` 交给 Pi 的 Bash 工具。`timeout` 可省略，单位为秒。

Codemode 示例：

```js
text(await tools.write({
  path: "example.txt",
  content: "hello\n",
  then_run: { command: "cat example.txt", timeout: 10 },
}));
```

| 情况 | 结果 |
| --- | --- |
| 修改失败 | 不运行命令。 |
| 命令失败、超时或取消 | 保留已完成的修改。命令状态与退出码单独报告；Codemode 中可用 `try/catch` 读取错误。 |
| 命令再次修改该文件 | diff 只反映命令开始前的修改。 |
| 多个融合调用修改同一路径 | 串行执行。路径锁不覆盖命令涉及的其他文件。 |

截断前的日志写入会话旁的 `<sessionId>-blobs/exec-<uuid>.log`。不完整的捕获会在回执中标记。启用 Condense 时也可以[按调用回读](condense.md#原文与分页恢复)。只关闭显示不会关闭 `then_run`；停用方式见[配置](../configuration.md#独立入口开关)。

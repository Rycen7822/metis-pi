# 修改后执行命令

Action Fusion 让 Pi edit/write 可以携带后续命令：修改成功后命令才执行，修改状态、diff 与命令日志分开保留。入口为 `extensions/action-fusion.ts`，实现位于 `src/execution/action-fusion.ts` 与 `action-fusion-command.ts`；停用方法见[配置](../configuration.md)，显示总开关对它无效。

在原参数中追加 `then_run: {command: "npm test", timeout: 60}` 即可。timeout 单位为秒，可省略，超时会终止命令。只有 Pi builtin edit/write 被包装，同名第三方工具保持原生。

原生 codemode 示例：

```js
text(await tools.write({
  path: "example.txt", content: "hello\n",
  then_run: {command: "cat example.txt", timeout: 10}
}));
```

| 情况 | 结果 |
| --- | --- |
| 修改失败 | 跳过命令，保留诊断。 |
| 命令失败、超时、取消 | 已成功的修改保留，命令状态单独记录，非零退出码写入正文。原生 codemode 调用会 reject，用 try/catch 读取错误正文。 |
| 命令再次修改同一文件 | diff 定格于命令开始前。 |
| 并发融合 | 按规范化修改路径排队，排队期间取消则整次放弃。 |

一次融合只产生一个工具结果，assistant/goal 事件流保持原样。路径排队只覆盖被修改的文件，外部进程与命令涉及的其他文件独立管理；并行写仍需独立目录隔离。

完整日志在截断前写入 `<sessionId>-blobs/exec-<uuid>.log`，内存会话使用临时目录。condense 关闭后引用依然可用，捕获失败会标注不完整；已有回执在 Fusion 禁用后仍可回放。

启用 condense 时，nested 调用分别归档，可按子 ID 或 parentToolCallId [回读](condense.md)。只有明确成功且可识别的 build/test 日志会被精简，失败与未知命令保留预览。命令使用 Pi native bash，锁、快照和收据由 metis 持有。

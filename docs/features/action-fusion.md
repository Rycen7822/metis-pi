# 修改后执行命令

Action Fusion 为 Pi edit/write 增加明确的后续命令，修改成功才执行，分别保留修改状态、diff 与日志。入口为 `extensions/action-fusion.ts`；禁用方法见 [配置](../configuration.md)，不受显示总开关控制。

原参数可追加 `then_run: {command: "npm test", timeout: 60}`。timeout 为可省略的秒数，显式超时终止命令；仅包装 Pi builtin，第三方同名工具保留。

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
| 命令失败、超时、取消 | 不回滚成功修改，保留命令状态；脚本需检查结构化结果。 |
| 命令再次改同一文件 | diff 固定于命令开始前。 |
| 并发融合 | 按规范化修改路径排队，排队取消不修改文件。 |

一次融合只有一个工具结果，不制造额外 assistant/goal 事件。路径排队不隔离外部进程或锁定命令全部文件；并行工作仍需独立目录。

完整日志在截断前保存到 `<sessionId>-blobs/exec-<uuid>.log`，内存会话使用临时目录。关闭 condense 仍保留引用，捕获失败明确标不完整；禁用 Fusion 不破坏历史回执。

启用 condense 时 nested 调用分别归档，可按子 ID/parentToolCallId [回读](condense.md)。仅明确成功且可识别的 build/test 日志可精简，失败和未知命令保留预览。命令使用 Pi native bash，metis 持有锁、快照和收据；实测见 [VALIDATION](../../VALIDATION.md)。

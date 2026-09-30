# 修改后执行命令

Action Fusion 让模型在一次 Pi `edit/write` 调用中提交文件修改和明确的后续命令。修改成功后执行命令，分别保留修改状态、diff 和命令日志。

## 开关与调用

默认加载 `extensions/action-fusion.ts`。在现有包安装项添加 `-extensions/action-fusion.ts` 并 `/reload` 或重启，恢复普通 Pi edit/write；显示总开关不控制它，历史融合回执和归档仍可读取。完整配置见 [配置](../configuration.md)。

原参数可追加：

```json
{"then_run": {"command": "npm test", "timeout": 60}}
```

timeout 单位为秒，可省略；显式超时会终止命令。原生入口只包装 Pi 内建工具，第三方同名工具保留自身行为。

原生 codemode 示例：

```js
const result = await tools.write({
  path: "example.txt", content: "hello\n",
  then_run: {command: "cat example.txt", timeout: 10}
});
text(result);
```

命令失败可能作为结构化结果返回，脚本应检查结果；捕获错误不撤销已经完成的文件修改。

## 结果与并发

| 情况 | 结果 |
| --- | --- |
| 修改失败 | 跳过命令，保留诊断 |
| 命令失败、超时或取消 | 保留成功的修改和命令失败状态，不回滚文件 |
| 命令继续修改同一文件 | write diff 固定在命令开始前 |
| 多个融合并发 | 按规范化修改路径排队，排队期间取消不修改文件 |

一次融合产生一个工具结果；不额外制造 assistant/goal 事件。路径协调不隔离外部进程，也不锁定命令可能访问的全部文件。互不干扰的任务仍需独立工作目录。

## 输出与恢复

命令日志在显示截断前写入会话旁 `<sessionId>-blobs/exec-<uuid>.log`；内存会话使用临时目录 `metis-pi-fusion-<pid>`。关闭 condense 后仍保留日志引用，磁盘失败明确标记捕获不完整。

启用 condense 后，原生 nested 调用分别归档，可按子调用 ID 或 parentToolCallId 回读。成功且可识别的 build/test 日志可选取关键行，失败和未知命令保留归档预览。分页和不完整捕获见 [历史压缩](condense.md)。

执行使用 Pi native bash，锁、快照和收据由 metis 管理。设计参考 SoL-Pi Action Fusion；验证范围见 [VALIDATION](../../VALIDATION.md)。

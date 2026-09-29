# 修改后执行命令

Action Fusion 让模型在一次工具调用中提交文件修改和明确的后续命令。只有修改全部成功后才执行命令；不自动选择命令、追加模型请求、重试修改或回滚文件。

## 开关

`extensions/action-fusion.ts` 统一控制 Pi 原生 edit/write、转换层 apply_patch，以及 Code Mode 的融合调用。默认加载；在现有包安装项添加 `-extensions/action-fusion.ts` 并 `/reload` 或重启即可关闭，完整配置形式见 [配置](../configuration.md)。`metis-pi.json` 的显示总开关不控制它。

关闭后，原生 edit/write 恢复普通工具，转换层 apply_patch 不再声明 `then_run`，Code Mode 不再提供 `apply_patch_then_run`。普通修改和命令工具继续可用；转换层收到旧的 `then_run` 会在修改前拒绝。历史融合回执和归档仍可读取。

## 调用方式

Pi 原生 `edit`、`write` 和普通模式 `apply_patch` 的原有参数保持不变，可追加：

```json
{"then_run": {"command": "npm test", "timeout": 60}}
```

`timeout` 单位为秒，可省略；显式超时会终止命令，不是轮询等待时间。不传 `then_run` 时仍执行普通修改。原生入口只包装 Pi 内建工具，第三方同名工具保留自身行为。

Code Mode 保留 `tools.apply_patch(patch)` 字符串接口，并提供：

```js
const result = await tools.apply_patch_then_run({
  input: "*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch",
  then_run: { command: "cat example.txt", timeout: 10 }
});
text(result);
```

融合沿用外层 `exec`/`wait` 生命周期，必要时 yield/wait。嵌套命令失败会抛错，但此前先保存修改回执和日志；捕获异常不撤销修改。

## 结果与并发

| 情况 | 结果 |
| --- | --- |
| 部分 patch 失败 | 跳过命令，保留已应用部分的证据 |
| 命令失败、超时或取消 | 已完成的修改仍为成功；不回滚 |
| 命令继续修改同一文件 | write diff 固定在命令开始前，不被后续修改污染 |
| 多个融合并发 | 按规范化修改路径排队，patch 移动源和目标均参与 |

一次融合产生一个外层工具结果，不制造额外 assistant/goal 事件。路径协调不锁定命令可能访问的全部文件，也不隔离外部进程；互不干扰的任务仍需独立工作目录。

## 输出与恢复

命令日志在显示截断前写入会话旁 `<sessionId>-blobs/exec-<uuid>.log`；无会话目录的内存会话使用临时目录 `metis-pi-fusion-<pid>`。关闭 condense 后仍保留执行日志引用；磁盘失败明确标记捕获不完整。

嵌套融合另写 `fusion-<uuid>.jsonl`，记录输入、修改回执和日志路径。外层结果绑定本次发布的精确字节区间，独立于最多 50 条显示 trace，后续 wait 不改变旧结果。重载只恢复证据，不重放操作；当前没有自动归档清理。

启用 condense 时，各嵌套调用分别入索引，可按子调用 ID 或外层 journal 快照恢复。只有明确成功且可识别的 build/test 日志才选取关键行，失败及未知命令保留归档预览。分页和不完整捕获语义见 [历史压缩](condense.md)。

功能不依赖 RTK，不增加预热请求；模式内工具声明保持稳定，真实缓存收益仍需实测。设计参考 SoL-Pi Action Fusion，执行和生命周期沿用本包工具；验证范围见 [VALIDATION](../../VALIDATION.md)。

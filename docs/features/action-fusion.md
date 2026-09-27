# 修改后执行命令

Action Fusion 让模型在一次工具调用中明确提交文件修改与后续命令。适用于已经确定要运行的检查，例如写入配置后运行测试。只有修改全部成功后才执行命令；不会自动选择命令、追加模型请求、重试修改或回滚文件。

## 统一开关

默认随 `extensions/action-fusion.ts` 加载。该入口统一控制 Pi 原生 edit/write、转换层 apply_patch，以及 Code/Notebook 的融合调用。在 `~/.pi/agent/settings.json` 的 `packages` 中修改现有 metis-pi 安装项即可关闭：

```json
{
  "packages": [
    {
      "source": "git:git@github.com:Rycen7822/metis-pi.git",
      "extensions": ["-extensions/action-fusion.ts"]
    }
  ]
}
```

保留现有安装项的 `source`、其他包和过滤规则；上例是配置片段的完整结构。删除该排除项可恢复默认启用；执行 `/reload` 或重启 Pi 生效。`extensions: []` 会关闭这个包的全部扩展，不能用于恢复默认加载。

关闭后，原生 edit/write 恢复普通工具，转换层 apply_patch 不再声明 `then_run`，Code/Notebook 不再提供 `apply_patch_then_run`；普通修改和命令工具继续可用。转换层收到旧的或直接注入的 `then_run` 会在修改文件前拒绝执行。历史融合回执和归档仍可读取。`metis-pi.json` 的显示总开关不控制 Action Fusion；无需关闭整个 Codex 转换层。

## 调用方式

Pi 原生 `edit`、`write` 和普通模式的 `apply_patch` 接受可选参数：

```json
{"then_run": {"command": "npm test", "timeout": 60}}
```

启用时，原有修改参数保持不变。`timeout` 以秒为单位，可省略；显式超时会终止命令，不是轮询等待时间。未提供 `then_run` 时仍按普通修改工具执行。原生入口只包装 Pi 内建工具，第三方同名工具保留自身行为。

Code Mode 和 Notebook Mode 保留原有 `tools.apply_patch(patch)` 字符串接口，并增加函数入口：

```js
const result = await tools.apply_patch_then_run({
  input: "*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch",
  then_run: { command: "cat example.txt", timeout: 10 }
});
text(result);
```

Code/Notebook 仍使用既有外层 `exec`/`wait` 生命周期。嵌套命令失败会抛出错误，但修改回执和日志会先保存；捕获异常不意味着修改被撤销。融合操作在一个外层调用内持续运行，必要时沿用外层 yield/wait。

## 结果与并发

修改与命令分别记录状态。部分 patch 失败时跳过命令，并保留已应用部分的证据。命令失败、超时或取消时，已完成的修改仍显示为成功，write diff 固定在命令开始前，命令随后改写同一文件不会污染该 diff。整个操作产生一次外层工具结果，不制造新的 assistant/goal 事件。

融合调用按规范化后的修改路径协调执行，patch 的移动源和目标均参与排队。它不锁定命令可能访问的所有文件，也不隔离外部进程。需要互不干扰的任务仍应使用独立工作目录。

## 输出与恢复

命令输出在显示截断前保存到会话目录的 `<sessionId>-blobs/exec-<uuid>.log`。内存会话没有会话目录时使用系统临时目录 `metis-pi-fusion-<pid>`。这是执行层功能，关闭 condense 后仍会保留日志引用；磁盘失败会明确标记无法完整保存。

嵌套融合另写 `fusion-<uuid>.jsonl`，记录原始输入、修改回执和完整命令日志路径。外层结果携带本次发布的精确字节区间；它独立于最多 50 条的显示 trace，也不会因下一次 `wait` 追加记录而改变旧结果。会话重载只恢复证据，不重放修改或命令。

启用内置 condense 时，直接融合结果保留修改内容、状态及路径，只对明确成功且可识别的 build/test 输出选取关键行。未知或失败命令沿用归档预览，不标为成功精简。嵌套 journal 中每个子调用独立入索引；`context_tree_query` 可按 journal 内的子调用 ID 找到修改结果与完整日志，也能查询外层调用的 journal 快照。分页、缺失文件和不完整捕获语义见 [condense](condense.md)。归档随会话保存，当前没有自动清理。

功能不依赖 RTK，不增加缓存预热请求。工具声明在模式内保持稳定，实际 provider 缓存命中率仍需真实会话测量。验证范围见 [VALIDATION](../../VALIDATION.md)。设计参考本地研究材料中的 SoL-Pi Action Fusion，执行与生命周期由 metis-pi 现有工具负责。

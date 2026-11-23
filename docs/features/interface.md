# 终端界面

## 输入区

`[appearance.composer]` 控制底色、`>` 提示符与模型信息。提示符与占位文字不随输入提交。模型、提供商、推理级别和上下文用量可在状态栏查看；显示选项见[配置参考](../configuration.md#显示字段)。

## 任务状态

顶部显示 Pi 和 Metis 版本。输入区上方显示运行、写入或等待输入状态。运行时间包含回答后的历史维护；整轮摘要依据最终状态显示 `Worked`、`Failed`、`Interrupted` 或 `Ended`。单次工具失败不等于整轮失败。

`appearance.working` 控制计时、思考、工具和动画。`appearance.summary.persist` 决定是否把摘要存入会话。消息时间按 UTC+8 显示。思考与工具的展开操作见[转录显示](display.md)。

## 统计口径

| 字段 | 含义 |
| --- | --- |
| 上下文 | 当前分支的上下文估算，不是会话累计用量。Condense 发布替换后立即按压缩后的内容估算；使用新上下文的模型回执到达后，恢复 Pi 的回执口径。待处理的替换不算已节省。 |
| `Σ` 输入与输出 | 当前会话各分支的 assistant、压缩与分支摘要用量。不含独立预热或 Condense 摘要请求。 |
| 缓存命中率 | 最近一次确认请求的 `cacheRead / (input + cacheRead + cacheWrite)`。 |
| `gen≈` | 客户端观察到的文本或工具参数生成速度。流式值按字符估算；有可靠用量时用非推理输出校准。工具执行时间不计入。 |
| Git `+A -D` | 与 HEAD 相比的暂存与未暂存改动，另计未忽略的未跟踪文本。最多计 200 个未跟踪文件，每个最多 256 KiB。 |

`/codex-ui` 中的 `out(last)` 是上一个请求的总输出除以请求耗时，包含推理和首字等待，不能与 `gen≈` 直接比较。账单以提供商为准。

点击状态栏中的三角符号，可单独展开目录或 Condense 的队列状态。默认展开方式由 `appearance.footer.locationExpanded` 和 `pruneExpanded` 决定。

## 全屏历史与留白

全屏模式一次显示最多 5,000 行，含 `Earlier history` 和 `Later history` 提示。滚动到当前页边缘后继续滚动可加载下一页；搜索只覆盖当前页。原始会话不受窗口大小影响。

- 点击 **Jump to latest message**、使用底部快捷键，或把滚动条拖到底，可以回到整个会话末尾并跟随新输出。显式跳到最新会清除选区。
- 上方 `↑` 显示已经滚出屏幕的最近一条用户输入。点击可跳回原消息。
- 有选区时，已显示的历史保持原位；解除选区后继续更新。复制及回退方式见[选区复制](selection-copy.md)。

用 `appearance.fullscreen.marginX` 设置两侧留白，设为 0 可关闭留白，不影响分页。需要终端原生滚动缓冲区时，用 `--tui-mode regular` 启动。

## 字形

`appearance.glyphs.textPresentation` 请求以文本字形显示 `✔ ✖ ✓ ✗ ⚠`。可用 `include` 添加字符；最终效果取决于终端和字体。

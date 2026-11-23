# 按模型选择全局指令

动态指令从模型的提供商和 ID 选择一份 Markdown 文件，替换 Pi 的全局指令。项目与祖先目录的指令仍按 Pi 的规则加载。

## 配置与匹配

默认关闭。添加以下配置时，先删除同一表中的 `groups = []`：

```toml
[dynamicAgents]
version = 1
enabled = true
notify = true

[[dynamicAgents.groups]]
id = "codex"
file = "./AGENTS-codex.md"
include = ["openai/*", "openai-codex/*"]
exclude = ["*-mini"]
```

组按声明顺序匹配，取第一个满足 `include` 并通过 `exclude` 过滤的组。模式区分大小写，`*` 可跨 `/`。含 `/` 的模式匹配 `provider/model-id`；其他模式可匹配完整模型 ID 或最后一段。

每组需要唯一的 `id`、可读且非空的 `file`，以及非空的 `include`。相对文件路径以全局 TOML 所在目录为基准；全局替代文件应与项目指令分开维护。无匹配组或配置无效时，按 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md` 的顺序查找原生全局指令。`notify = false` 仅关闭普通切换通知，配置错误告警保持开启。

## 生效与恢复

配置和文件在每次正式运行前读取；同一次运行的工具步骤使用同一份指令。`/dynamic-agents` 查看当前模型、所用文件和待生效状态。`/dynamic-agents reload` 仅安排下一次运行刷新，当前指令保持有效。

停用前，将 `enabled` 设为 `false` 并完成一次运行，以恢复原生全局指令；也可以从新会话开始。更换指令可能降低下一次请求的前缀缓存命中率。

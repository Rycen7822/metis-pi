# 动态全局指令

按实际 provider/model ID 选择全局指令，保留项目与祖先规则、skills、goal 和工具。文件和既有 session 正文不被改写。

## 配置与匹配

全局 TOML 的 `[dynamicAgents]` 默认 `enabled=false`、`notify=true`、`version=1`、`groups=[]`。添加 array-of-tables 时先移除同表的 `groups=[]`：

```toml
[dynamicAgents]
version = 1
enabled = true
notify = true

[[dynamicAgents.groups]]
id = "codex"
file = "./AGENTS-CODEX.md"
include = ["openai/*", "openai-codex/*"]
exclude = ["*-mini"]
```

每组需要唯一 id、file 和非空 include。文件相对全局配置目录或使用绝对路径；不展开 `~`，路径不能含双引号或换行，内容须可读非空，且不能兼作当前项目指令来源。

| 规则 | 语义 |
| --- | --- |
| 含 `/` 的模式 | 匹配完整 `provider/model.id`。 |
| 不含 `/` | 匹配模型完整 ID 或最后一个 `/` 后的名称。 |
| 字符 | 区分大小写，只有字面量与可跨 `/` 的 `*`。 |
| 选择 | 任一 include 命中且全部 exclude 未命中；取第一组，不合并。 |

全部组先校验。未命中、关闭或配置/文件出错时，按 `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` 使用原生全局来源；错误总会警告，`notify=false` 只关闭正常切换提示。

## 生效和恢复

每次正式 run 前重读配置与文件，工具步骤共用同一快照；run 中修改文件、切换模型或 reload 在下一 run 生效。`/dynamic-agents` 查看模型、组、文件和待生效状态；`reload` 标记刷新并暂停旧快照预热，不发模型请求。

`enabled=false` 后开始下一 run 恢复原生指令。停用入口前先完成恢复，或使用新会话。已有回复的语义影响不会因换策略消失。

投影按来源替换全局块，普通消息、工具结果和摘要不作为策略来源。辅助摘要使用主 run 快照；run 前普通 compaction 使用此前生效指令。相同策略不附加时间戳，切换策略可能降低缓存命中。

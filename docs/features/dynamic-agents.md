# 动态全局指令

按实际 provider/model ID 替换当前请求的全局指令；不改磁盘 AGENTS 或既有 session 正文，保留项目/祖先规则、skills、goal 和工具。

## 配置与匹配

创建 `<agentDir>/dynamic-agents.json`，目录跟随 `PI_CODING_AGENT_DIR`。文件缺失时不激活，不自动创建。

```json
{
  "version": 1,
  "enabled": true,
  "notify": true,
  "groups": [{
    "id": "codex", "file": "./AGENTS-CODEX.md",
    "include": ["openai-codex/*"], "exclude": ["*-mini"]
  }]
}
```

version/groups 必填，enabled/notify 默认 true；每组须唯一 id、file、非空 include，exclude 默认空。先验证全部组，再选文件。路径相对 JSON 目录或绝对路径，不展开 `~`，不含双引号/换行；选中文件须可读非空，且不能兼作当前项目指令来源。

| 模式 | 规则 |
| --- | --- |
| 含 `/` | 匹配完整 provider/model.id，第一个 `/` 分隔 provider。 |
| 不含 `/` | 跨 provider 匹配完整模型 ID 或最后一个 `/` 后的名称。 |
| 字符 | 区分大小写；仅字面量和 `*`，星号可跨 `/`，不解释正则。 |
| 组内 / 组间 | 任一 include 命中且所有 exclude 未命中；按数组取首组，不合并或按精确度排序。 |

未命中、关闭或出错时使用原生 `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md`。JSON、重复 ID、文件错误会警告并回退，不沿用上个模型策略；错误不受 notify 控制。

## 生效和恢复

正式 run 前重新读取配置、所选文件及原生全局候选，发布快照；工具步骤共用同一快照。run 中改文件、换模型或 reload 在下一次 run 生效，连续换模型不发布中间策略。

`/dynamic-agents` 显示生效组、模型、文件和待生效状态；`reload` 标记刷新、暂停旧快照预热，不发模型请求。原生文件的正文/新增/删除也在新 run 重新解析，候选不可读时按优先级回退。

设 enabled:false 并开始下一次 run 可恢复原生指令。彻底卸载前先完成恢复，或使用新会话；卸载入口后不再清理旧策略投影。关闭正常切换提示用 notify:false。

## 会话与缓存

只追加程序来源路径元数据，以便 reload 识别策略；投影按来源替换全局块，不把普通消息、工具结果或摘要正文当策略。既有输出的语义影响不会消除。

辅助摘要使用主会话同一快照，不按摘要模型重选组；run 前普通 compaction 使用此前生效指令。condense、OCC、goal 的开关与持久状态不改变。

同策略不加时间戳/计数，换策略可能降低前缀缓存命中；本地离线验证不证明服务端缓存收益。

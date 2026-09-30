# Dynamic agents

按实际 provider 和模型 ID 选择全局指令，只替换当前请求中的全局上下文。磁盘 AGENTS 和既有 session 条目不改写，项目及祖先目录指令、skills、goal 和工具定义保留。

## 配置

创建 `<agentDir>/dynamic-agents.json`。agentDir 默认 `~/.pi/agent`，跟随 `PI_CODING_AGENT_DIR`。文件不存在时不激活，也不自动创建配置。

```json
{
  "version": 1,
  "enabled": true,
  "notify": true,
  "groups": [
    {
      "id": "codex",
      "file": "./AGENTS-GROUP01.md",
      "include": ["openai-codex/*"]
    },
    {
      "id": "flash",
      "file": "./AGENTS-GROUP02.md",
      "include": ["deepseek-v4.1-flash"]
    },
    {
      "id": "commandcode-other",
      "file": "./AGENTS-GROUP03.md",
      "include": ["commandcode/*"],
      "exclude": ["deepseek-v4.1-flash"]
    }
  ]
}
```

`version`、`groups` 必填，`enabled`、`notify` 默认 true。每组需唯一 `id`、`file` 和非空 `include`；`exclude` 默认空。先验证全部组结构，再选择文件。

路径相对 JSON 所在目录，也可用绝对路径，不展开 `~`；不得含双引号或换行。选中文件须可读、非空，且不能同时作为当前项目指令来源。

## 匹配与回退

| 规则 | 语义 |
| --- | --- |
| 含 `/` 的模式 | 匹配完整 `provider/model.id`，第一个 `/` 分隔 provider；模型 ID 内可继续包含 `/` |
| 不含 `/` 的模式 | 跨 provider 匹配完整模型 ID 或最后一个 `/` 后的名称 |
| 字符语义 | 区分大小写，只支持字面量与 `*`；`*` 可匹配零个或多个字符并跨 `/`，不解释正则或减号运算 |
| 组内 | 任意 include 命中且全部 exclude 不命中 |
| 组间 | 按数组顺序取首个命中，不合并、不自动按精确度排序；exclude 只影响所在组 |

没有命中、关闭或配置出错时，使用 Pi 原生全局指令及其 `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` 优先级；原生文件也不存在时不添加。无效 JSON、重复 ID、选中文件缺失或不可读/为空会回退并警告，不沿用上一模型的专属策略。错误提示不受 `notify` 控制。

## 生效时机

| 操作或时机 | 行为 |
| --- | --- |
| 下一次正式 agent run 准备 | 重新读取 JSON、命中策略和原生全局候选，发布当前模型的快照 |
| 一次 run 的多个工具步骤 | 使用同一快照；期间修改文件、换模型或请求 reload，在下一次 run 生效 |
| 连续切换 A → B → C 而不运行 | 不发布中间策略 |
| 会话恢复、扩展 reload、goal 新 run | 下次运行按当前模型重新选择 |
| `/dynamic-agents` | 显示已生效组、选中/生效模型、文件路径、回退原因和待生效状态 |
| `/dynamic-agents reload` | 标记下次刷新并暂停旧快照预热；不主动发送模型请求 |

功能激活后，原生全局文件的正文、新增/删除和加载优先级也在新 run 重新解析，无需文件监听或 `/reload`。不可读时按原生优先级尝试其它候选并警告；未命中策略的正文不加载。命中策略与原生全局内容不会叠加。

正常切换默认提示，`notify: false` 可关闭。设 `enabled: false` 并开始下一次 run 可恢复原生指令；彻底卸载可过滤 `-extensions/dynamic-agents.ts`。卸载后不再清理旧策略投影，应先关闭并运行一次，或从新会话开始。

## 会话、压缩与缓存

历史 session 只追加程序拥有的来源路径元数据，以便 reload 识别旧策略。请求投影按来源处理 system 的全局指令块，不把普通用户、assistant、工具结果或摘要正文当作策略。旧输出已经受到的语义影响不会消除，opaque 压缩状态也不会被解密改写。

Pi 原生请求使用同一 run 策略快照；由主会话模型决定分组，辅助摘要模型不重新选组。正式 run 前的普通 compaction 使用此前已生效的指令。condense、OCC、goal 的开关、额度和持久状态不改变。

相同策略不注入时间戳或计数；实际换策略会改变请求前缀，可能降低缓存命中。验证使用真实 Pi AgentSession、完整扩展加载及离线 provider payload，未证明付费服务端缓存效果，见 [VALIDATION](../../VALIDATION.md)。

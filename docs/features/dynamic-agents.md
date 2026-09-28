# Dynamic agents

根据本次运行的 provider 和模型 ID 选择全局指令。只替换当前请求中的全局上下文，不覆盖磁盘 AGENTS 文件，不修改已有 session 条目。项目及祖先目录的指令、skills、goal 和工具定义保留。

## 配置

创建 `<agentDir>/dynamic-agents.json`。默认 agentDir 为 `~/.pi/agent`；设置 `PI_CODING_AGENT_DIR` 时跟随 Pi 的实际目录。文件不存在时功能不激活，也不创建任何配置文件。

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

`version` 和 `groups` 必填；`enabled`、`notify` 默认 true。每组需要唯一的 `id`、`file` 和非空 `include` 数组，`exclude` 默认为空。所有组的结构验证成功后才选择文件。路径相对于 JSON 所在目录，也可使用绝对路径；不展开 `~`。策略文件不能为空，不能同时作为当前项目指令来源；路径不能含双引号或换行。

没有命中、关闭或配置出错时使用 Pi 原生全局指令，包括原生 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md` 等加载优先级。原生文件也不存在时不添加全局指令。无效 JSON、重复组 ID、选中文件缺失/不可读/为空会回退并警告，不沿用上个模型的专属策略。错误提示不受 `notify` 控制。

## 匹配规则

- 使用真实 provider 和 model ID，区分大小写，不使用模型显示名。
- 模式含 `/`：匹配完整 `provider/model.id`；第一个 `/` 区分 provider，模型 ID 内可以继续包含 `/`。
- 模式不含 `/`：跨 provider 匹配完整模型 ID 或最后一个 `/` 后的名称。因此 `deepseek-v4.1-flash` 同时匹配该 ID 和 `deepseek/deepseek-v4.1-flash`。
- 只支持字面量和 `*`；`*` 可匹配零个或多个字符并跨越 `/`。不解释正则表达式或减号运算。
- 任一 include 命中且所有 exclude 均不命中才算匹配。排除仅影响当前组。按数组顺序使用第一个匹配组，不合并多组，也不自动计算精确度。

例如只覆盖 commandcode 下 deepseek 系列的其他模型：

```json
{
  "id": "deepseek-other",
  "file": "./AGENTS-GROUP03.md",
  "include": ["commandcode/deepseek/*"],
  "exclude": ["commandcode/deepseek/deepseek-v4.1-flash"]
}
```

## 生效时机和状态

仅在下一次正式 agent run 准备时读取并应用 JSON 和选中文件。A → B → C 连续选择但不运行时，不发布中间策略。一次 run 的多个工具步骤使用同一份快照，期间修改文件、选择模型或请求重载均在下一次 run 生效。恢复会话、`/reload` 和 goal 发起的新 run 也按当前模型重新选择。

功能激活后，每个新 run 也会重新读取原生全局指令，不复用 Pi 启动时缓存的正文。因此修改全局 `AGENTS.md` 或命中的策略文件后，无需 `/reload`；下一次 run 使用新内容。全局文件的新增、删除以及 `AGENTS.override.md` 等候选的优先级变化同样重新解析。无法读取时按原生优先级尝试其他候选并警告，不继续使用旧正文。未命中的策略文件修改不会影响当前组；切换到该组后的下一次 run 才加载它。命中策略时仍只使用该策略，全局文件不会额外叠加；回退原生规则时使用最新全局文件。

`/dynamic-agents` 显示已生效组、选中/生效模型、配置及文件路径、回退原因和待生效状态。`/dynamic-agents reload` 标记下一次 run 刷新，并暂停使用旧快照预热；它不会主动发送模型请求。每次 run 本身也会重新读取文件，不使用文件监听器。

策略变化时默认提示，`notify: false` 可关闭正常切换提示。使用 `enabled: false` 并开始下一次 run 可恢复原生全局指令；也可按 Pi 包过滤排除 `-extensions/dynamic-agents.ts` 并 `/reload` 完全卸载入口。卸载后不再执行历史策略清理，应先用 enabled 关闭并运行一次，或从新会话开始。

## 会话、压缩和缓存

历史 session 文件保持原样，仅追加程序拥有的来源路径元数据，以便 reload 后识别旧策略。请求投影按来源处理 system 的全局指令块；不会把普通用户、assistant、工具结果或摘要正文当成策略替换。旧模型输出已经受到的语义影响不会自动消除，opaque 压缩状态也不会被解密重写。

原生请求和 Codex conversion 使用同一份策略。conversion 在 Reserve 确认最终模型之后再次核对；预热/keepalive 未取得当前模型的运行快照时跳过，取得快照后使用同一历史投影。主会话模型决定分组，辅助摘要模型不重新选组。Pi 在正式 run 准备前启动的容量压缩使用此前生效的指令；不为这个辅助调用提前发布新策略。OCC、condense 和 goal 的开关、额度和持久状态不改变。

同一策略内容保持稳定，不注入切换时间戳或计数。实际换策略会改变请求前缀，可能降低缓存命中；不承诺缓存无损。离线测试覆盖真实 Pi AgentSession、完整扩展加载及 Codex provider payload，未进行付费模型或真实服务端缓存测试。

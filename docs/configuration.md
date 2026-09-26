# 配置参考

全部配置集中在一个可选 JSON 文件里。**渲染路径永远不会读这个文件**（读取只发生在扩展激活时一次），**用户文件永不被改写**。

## 文件位置

```
<agent dir>/metis-pi.json
```

`<agent dir>` 的解析顺序（`extensions/appearance.ts` 的 `getAgentDir`）：

1. 环境变量 `PI_AGENT_DIR`（本扩展自己的覆盖项）
2. 宿主公开接口 `Pi.getAgentDir()` —— 宿主自己的环境变量是 `PI_CODING_AGENT_DIR`，所以设那个也能生效
3. `$HOME/.pi/agent`

注意 1 与 2 是两个不同的变量名；只设 `PI_CODING_AGENT_DIR` 时走 2，只设 `PI_AGENT_DIR` 时走 1。

## 读取时机与生效方式

| 时机 | 读什么 | 代码 |
| --- | --- | --- |
| 扩展激活时（= pi 启动加载扩展） | 整份配置 | `src/extension.ts` 的 `loadConfig(bindings.getAgentDir?.(), bindings.readFile)` |
| 同一次激活，另读一次 | 仅 `writePreview`（写预览行预算） | `extensions/appearance.ts` 的 `bootWritePreview` |

**改配置后需要重启 pi 才生效。** 写预览预算也是启动时读一次后固定（早期版本每个 write 调用重读，且只认 `Pi.getAgentDir()` 一条路径，会与启动时读到的配置分叉）。

## 加载语义（重要）

| 情况 | 结果 |
| --- | --- |
| 文件不存在 | 全部默认值，`present: false`，无问题记录 |
| JSON 解析失败 | **全部默认值**（不是部分） |
| 根不是对象 | 全部默认值 |
| 某个 section 不是对象（如 `"thinking": 5`） | 该 section 全部默认值，其余 section 照常 |
| 某个键类型错 / 取值非法 | 该项回退默认值，并记录一条人类可读的 `problem` |

**已知限制**：`loadConfig` 返回的 `problems` 数组目前**没有任何地方展示**（只有 `test/core/config.test.mts` 消费它）。也就是说写错配置是**静默回退**的——不会警告、不会报错、不会出现在 `/codex-ui` 里。要确认某个值有没有生效，请对照 `/codex-ui` 里报告的组件真实状态。

回退语义分两类，别混淆：

- **静默钳制**（越界不报问题，直接夹到边界）：`thinking.peekLines`、`working.animationIntervalMs`
- **越界即回退默认**（并记 problem）：`writePreview.rows`、`fullscreen.marginX`、`fullscreen.minWidth`

## 键表

### 顶层

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 总开关 |

### thinking —— 思考块

| 键 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `thinking.streaming` | `"peek"` \| `"full"` \| `"collapsed"` | `"peek"` | — | 流式期间形态：只显示最新 N 行窗口 / 全展开 / 直接折叠 |
| `thinking.completed` | `"collapsed"` \| `"full"` | `"collapsed"` | — | 思考结束后是否自动折叠一次 |
| `thinking.rail` | bool | `true` | — | 思考正文左侧的青色 rail |
| `thinking.peekLines` | number | `6` | 1..40（钳制） | 窥视窗口行数 |

### writePreview —— 写预览

| 键 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `writePreview.enabled` | bool | `true` | — | 实时预览 write 参数 |
| `writePreview.rows` | number | `8` | 0..64 | 预览区**总**屏幕行预算；`0` = 只留标题与阶段行、不显示正文 |

### composer —— 输入区

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `composer.surface` | bool | `true` | 灰色底色面（关闭后回到宿主原生编辑区外观） |
| `composer.promptPrefix` | bool | `true` | 首行两个 padding 格借用为 `> ` 提示符 |
| `composer.metadata` | bool | `true` | footer 中的模型、推理等级、provider、上下文信息（不再在输入框显示） |

### working —— Working 行

| 键 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `working.elapsed` | bool | `true` | — | 关闭**只**去掉时长；thought/tool 段照常更新 |
| `working.thought` | bool | `true` | — | `thinking Ns` 段 |
| `working.tool` | bool | `true` | — | 当前工具段 |
| `working.tokens` | bool | `false` | — | token 段（默认关） |
| `working.animation` | bool | `true` | — | 彗尾 shimmer（truecolor only，其余等级静态） |
| `working.animationIntervalMs` | number | `32` | 32..1000（钳制） | 亚格渐变驱动间隔 |

### footer —— 底部状态行

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `footer.enabled` | bool | `true` | 整条 footer |
| `footer.details` | bool | `true` | 会话 ↑↓ 与 cache；`tok/s` 由 `footer.showSpeed` 控制 |
| `footer.showCache` | bool | `true` | cache 命中率 |
| `footer.showChanges` | bool | `true` | 分支后的 `+A -D` 变更量 |
| `footer.showSpeed` | bool | `true` | `N tok/s` |

旧版 `footer.showCodexQuota` 和 `quota` 配置已移除；保留在配置文件中会作为未知字段忽略，不会查询或显示右侧 Codex 额度。

### summary —— 结束摘要

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `summary.enabled` | bool | `true` | `Worked for … · thought for …` 摘要 |
| `summary.persist` | bool | `true` | `false` 时摘要走 footer 状态行的临时路径（不落会话记录） |

### selectionCopy —— 选区复制（fullscreen）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `selectionCopy.enabled` | bool | `true` | 精确 serializer 整体开关 |
| `selectionCopy.ctrlC` | bool | `true` | Ctrl+C 复制选区；无选区时保持宿主原生行为 |

### fullscreen —— 侧边留白

| 键 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `fullscreen.marginX` | number | `2` | 0..8 | `0` = 关闭留白 |
| `fullscreen.minWidth` | number | `72` | 40..400 | 窄于此宽度时留白整体消失 |

### glyphs —— 字形呈现

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `glyphs.textPresentation` | bool | `true` | 给 `✔ ✖ ✓ ✗ ⚠` 这类符号补 U+FE0E，防止 emoji 字体画宽压住右邻字符 |
| `glyphs.include` | string[] | `[]` | 追加字符；每项必须是单个非 ASCII 字符（否则记 problem 并跳过）、自动去重、最多 32 项 |

## 颜色等级判定（`src/palette.ts` 的 `resolveColorContext`）

按顺序命中即停，决定了用真彩、256 色、16 色还是**完全无色**：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `NO_COLOR` 已设 | `none` |
| 2 | `FORCE_COLOR` = `"0"`/`"false"` | `none` |
| 3 | `FORCE_COLOR` = `"1"`/`"2"` | 终端支持真彩则 `truecolor`，否则 `ansi256` |
| 4 | `FORCE_COLOR` = `"3"` | `truecolor` |
| 5 | 宿主 `getCapabilities().trueColor` 为真 | `truecolor` |
| 6 | `COLORTERM` 匹配 `truecolor`/`24bit` | `truecolor` |
| 7 | `WT_SESSION` 已设，或 `TERM_PROGRAM=WindowsTerminal` | `truecolor` |
| 8 | `TERM` 含 `256color` | `ansi256` |
| 9 | 兜底 | `ansi16` |

降级时不会丢失布局：diff 底色在 256 色用 `22`/`52`，16 色只保留前景色；`none` 下所有装饰字符退化为 ASCII 等价物（例如 rail 用 `|`）。

颜色等级在**会话启动时解析一次并缓存**（`extensions/appearance.ts` 的 `colorLevelOnce`），中途改环境变量不会生效。

## 环境变量

| 变量 | 作用域 | 说明 |
| --- | --- | --- |
| `PI_AGENT_DIR` | 本扩展 | 覆盖 agent 目录（配置文件与 auth 都从这里找） |
| `PI_CODING_AGENT_DIR` | 宿主 pi | 宿主自己的 agent 目录变量，经 `Pi.getAgentDir()` 间接生效 |
| `PI_CODEX_TODO_PATH` | codex-todo | 整体搬迁任务存储目录 |
| `NO_COLOR` / `FORCE_COLOR` / `COLORTERM` / `WT_SESSION` / `TERM_PROGRAM` / `TERM` | 本扩展 | 见上方颜色等级链 |

## 示例

```jsonc
{
  "thinking": { "streaming": "peek", "peekLines": 6, "completed": "collapsed" },
  "writePreview": { "enabled": true, "rows": 8 },
  "composer": { "surface": true, "promptPrefix": true, "metadata": true },
  "working": { "elapsed": true, "thought": true, "tool": true, "tokens": false, "animationIntervalMs": 32 },
  "footer": { "enabled": true, "showSpeed": true, "showCache": true, "showChanges": true },
  "selectionCopy": { "enabled": true, "ctrlC": true },
  "fullscreen": { "marginX": 2, "minWidth": 72 },
  "glyphs": { "textPresentation": true, "include": ["⏺"] }
}
```

只想关掉显示入口里的某一项时，也可以只在 `~/.pi/agent/settings.json` 里过滤扩展入口（`-` 前缀 = 强制排除），例如不要 goal：

```jsonc
{ "source": "git:git@github.com:Rycen7822/metis-pi.git", "extensions": ["-goal.ts"] }
```

## 验证

`test/core/config.test.mts` 覆盖：无文件、坏 JSON、部分 section、越界值、`glyphs.include` 清洗、默认值形状。

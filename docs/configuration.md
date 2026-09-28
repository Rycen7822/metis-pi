# 配置参考

## 配置归属

| 功能 | 配置位置 / 开关 | 生效方式 |
| --- | --- | --- |
| appearance 显示 | `<agentDir>/metis-pi.json` | 启动激活时读取，插件不改写；改后重启 Pi。 |
| condense / OCC | Pi `settings.json` 的 `contextPrune` | `/pruner settings` 可写入设置，见 [condense](features/condense.md)。 |
| dynamic-agents | `<agentDir>/dynamic-agents.json` | 下一次正式 run 读取；配置缺失时不激活，见 [动态指令](features/dynamic-agents.md)。 |
| Codex 转换层 | `pi-codex-conversion.json` | 通过 `/codex` 管理所选范围，见 [转换层](vendor-codex-conversion.md)。 |
| goal / todo / skill / Action Fusion 等独立入口 | Pi 包安装项的 `extensions` 过滤 | `/reload` 或重启后生效，见本页“独立功能开关”。 |

`metis-pi.json` 的 `enabled` 只控制显示层。各功能的持久数据与写入行为见 [命令与路径](commands.md)。

## 显示配置的路径与读取

显示配置使用 `<agentDir>/metis-pi.json`。`extensions/appearance.ts` 按以下顺序解析目录：

1. `PI_AGENT_DIR`：本显示入口的显式覆盖项。
2. Pi 的 `getAgentDir()`：跟随宿主 `PI_CODING_AGENT_DIR`。
3. `$HOME/.pi/agent`。

激活时读取整份配置，write 预览另在启动时固定行预算；渲染帧不读配置文件。修改显示配置后重启 Pi。仅设置 `PI_AGENT_DIR` 不等于更改所有独立扩展的宿主 agent 目录。

## 加载与错误处理

| 情况 | 结果 |
| --- | --- |
| 文件缺失、JSON 解析失败或根不是对象 | 使用默认配置。 |
| 某个 section 不是对象 | 该 section 回退，其余 section 照常处理。 |
| 某项类型/值非法 | 按字段规则回退，并在加载结果中记录 problem。 |
| `thinking.peekLines`、`working.animationIntervalMs` 越界 | 静默钳制到边界。 |
| `writePreview.rows`、`fullscreen.marginX`、`fullscreen.minWidth` 越界 | 回退默认并记录 problem。 |

当前加载问题没有面向用户的统一警告输出，错误配置可能静默回退。使用 `/codex-ui` 的有效配置与组件状态核对，不能仅凭文件内容判断已生效。默认值和校验规则由 `src/config.ts` 维护。

## 键表

### 顶层

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | appearance 显示总开关；不控制独立功能入口 |

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

## 颜色等级

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

降级时保留布局：diff 底色在 256 色用 `22`/`52`，16 色只保留前景色；无色模式使用组件提供的无色样式，例如 thinking rail 使用 `|`。

颜色等级由 `src/palette.ts` 解析，并在当前扩展实例缓存。修改环境变量后重启 Pi，以便重新探测。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_AGENT_DIR` | 本显示入口的配置目录覆盖。 |
| `PI_CODING_AGENT_DIR` | Pi 宿主 agent 目录；独立功能按各自说明跟随该目录。 |
| `PI_CODEX_TODO_PATH` | 搬迁 todo 存储目录。 |
| `NO_COLOR` / `FORCE_COLOR` / `COLORTERM` / `WT_SESSION` / `TERM_PROGRAM` / `TERM` | 影响上面的颜色能力判定。 |

## 独立功能开关

独立扩展通过 Pi agent 目录（默认 `~/.pi/agent`）下 `settings.json` 的 `packages` 过滤，不受 `metis-pi.json` 的显示总开关控制。`-` 后必须填写相对于包根目录的准确路径。例如关闭 goal 和全部 Action Fusion：

```json
{
  "packages": [
    {
      "source": "git:git@github.com:Rycen7822/metis-pi.git",
      "extensions": ["-extensions/goal.ts", "-extensions/action-fusion.ts"]
    }
  ]
}
```

修改现有安装项，保留其 `source`、其他包和过滤规则；执行 `/reload` 或重启 Pi 生效。移除对应排除项恢复默认加载；若没有其他过滤规则，可删除整个 `extensions` 字段。不要改成 `extensions: []`，空数组会关闭这个包的全部扩展。

| 功能 | 排除项 |
| --- | --- |
| 整个显示层 | `-extensions/appearance.ts` |
| goal | `-extensions/goal.ts` |
| todo | `-extensions/todo.ts` |
| dynamic-agents | `-extensions/dynamic-agents.ts`；运行中恢复原生规则建议先在独立 JSON 设置 `enabled: false`，详见功能页 |
| condense 整体 | `-extensions/condense.ts` |
| skill 输入 | 同时排除 `-extensions/skill-entry.ts`、`-extensions/skill-mux.ts` |
| 全部 Action Fusion | `-extensions/action-fusion.ts`，同时关闭原生 edit/write、转换层 apply_patch、Code/Notebook 的融合入口 |
| 整个 Codex 转换层 | `-vendor/pi-codex-conversion/dist/index.js` |

显示子项仍在 `metis-pi.json` 设置；压缩的 `contextPrune.enabled` 和 OCC 的 `contextPrune.opportunisticCompaction` 在 Pi `settings.json` 设置。`/pruner off` 关闭压缩但保留历史回读工具，排除 condense 入口才是完全禁用。Action Fusion 的开关与 condense 独立，细节见 [Action Fusion](features/action-fusion.md)。

## 实现与验证

显示配置见 `src/config.ts` 和 `extensions/appearance.ts`；已有 `test/core/config.test.mts` 检查默认值、坏 JSON、分区回退、范围与字符清洗。命令与实测范围分别见 [开发说明](development.md) 和 [VALIDATION](../VALIDATION.md)。

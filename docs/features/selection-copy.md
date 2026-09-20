# 逻辑选区复制（Ctrl+C）

> 在 fullscreen 模式下框选后按 `ctrl+c`，复制的是**已选显示内容的逻辑文本**：软折行合并、真实换行保留、代码缩进保留、语义前缀按需包含。无选区时完全保持宿主原生行为。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` → `src/chrome/install.ts`（`captureTui` → `installOnTui`） |
| 实现 | `src/selection-copy/index.ts`（系统/命令路由）`serialize.ts`（选区→逻辑文本）`markdown.ts`（Markdown/Text 溯源适配器）`structure.ts`（布局级溯源）`parser.ts`（与宿主一致的 Markdown 词法）`model.ts`（copy product）`wrap.ts`（软折行复刻） |
| 配置 | `selectionCopy.enabled`、`selectionCopy.ctrlC` |
| 诊断 | `/codex-ui` 的 `selection-copy` 行 |

## 按键语义

| 情形 | 行为 |
| --- | --- |
| 有选区 + `ctrl+c` | 复制选区的逻辑文本，**不清草稿** |
| 无选区 + `ctrl+c` | 交回宿主原生（清空草稿 / 双击退出） |
| 选区全是装饰（gutter、行号、省略行…） | **不写剪贴板、不清草稿** |
| 剪贴板写入失败 | 保留选区与草稿，不清空 |

`ctrl+c` 的具体键位来自**宿主键位管理器**（匹配 `app.clear` 动作，取不到才退回裸 `\x03`），因此用户自定义键位不会被覆盖。**零新按键注入、零 prototype 工具执行改动。**

## 复制模式（`/codex-ui` 报告）

| 模式 | 含义 |
| --- | --- |
| `exact` | 每一行都有精确溯源，输出 = 逻辑文本 |
| `mixed` | 部分行精确、部分行保守回退（硬边界断开，不猜） |
| `native-fallback` | 整体退回宿主原生提取 |

## 机制：为什么能"精确"

1. **渲染时生成 sidecar**：每个组件渲染时产出一份 copy product（`CopyRow`：列区间 + 语义种类 + `breakBefore`），并按**渲染数组身份**存进 `WeakMap`——天然绑定"当前已提交的那一帧"，不需要复制坐标。
2. **布局级溯源**：`Box` / `Container` 在 pi-tui 里是布局**叶子**（`src/selection-copy/structure.ts`），所以能从已提交帧的盒子解析出选区落在哪些 product 上。
3. **与宿主真实输出逐行 diff**：任何漂移（行数、列映射、未知 token）都**只降级为原生提取**，绝不猜。
4. **词法与宿主一致**：`src/selection-copy/parser.ts` 按宿主 0.85.1 的 markdown.js 配置词法器；`wrap.ts` 是宿主 `wrapTextWithAnsi` 的溯源复刻。
5. **镜像节流与计数**：Markdown/Text 适配器包装 `prototype.render`，镜像重建有节流（`MIRROR_REBUILD_INTERVAL_MS`），并统计 `markdownBuilt/markdownDegraded/markdownThrottled`（文本版同）——`/codex-ui` 逐项展示，便于定位"为什么这次退了"。

语义前缀的处理（按**所选列**决定是否包含，而不是凭字符猜）：

| 元素 | 处理 |
| --- | --- |
| 列表 marker | 选中列覆盖到它才包含 |
| 引用首行边框 | 同上 |
| diff 增删符号 | 视为**语义前缀**（选中列覆盖才包含） |
| 代码围栏 | 同上 |
| 行号 / gutter | 视为**装饰**（永不包含） |
| 截断省略行 | 视为 gap（硬边界） |

## 诚实的覆盖清单

| 类别 | 内容 |
| --- | --- |
| **exact** | assistant/user Markdown（段落/标题/列表/引用/代码围栏）、宿主 Text、思考展开正文（经 rail）、本项目自己的 shell/diff/write 渲染器 |
| **native-fallback（mixed）** | Markdown 表格（v1 无单元格级映射）、未知 token、图片行、highlight 行数漂移的代码块、Spacer/结构空行 |
| **不受支持** | regular（非 fullscreen）模式没有 TUI 选区，不拦截任何按键；终端原生选区（按住 Shift 拖拽等）绕过应用，属终端行为；跨 resize 的旧选区按当前帧坐标解析，无法安全重投影的行按原生保守提取 |

内容级归一化：tab 按宿主显示口径归一化为 3 空格；链接只复制**显示文本**，不追加 OSC 8 的隐藏 URL；数学块复制渲染后的 Unicode 文本。

## 与 pi-copy-soft-wrap 共存

旧插件在 `TuiAltScreen.prototype.getActiveSelectionText` 上做启发式 unwrap。本项目的精确 serializer 安装在原型层并**整体接管**该入口（先加载者的启发式被精确路径替代，**与扩展加载顺序无关**）。二者能力重叠但结果以本项目为准；建议停用旧插件避免重复工作：

```bash
pi remove pi-copy-soft-wrap
```

`/codex-ui` 的 `selection-copy` 行给出 `other-wrapper=`（是否检测到外来包装）与最近一次复制的模式/字符数。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| 系统装配、Ctrl+C 路由、模式汇总 | `src/selection-copy/index.ts`（`createSelectionCopySystem`、`tryConsumeCopyKey`、`installInstanceSerializer`、`detectExternalSerializerPatch`） |
| 选区 → 逻辑文本 | `src/selection-copy/serialize.ts`（`SelectionSerializer`、`findScrollViewBox`） |
| Markdown / Text 溯源 | `src/selection-copy/markdown.ts` |
| 布局级溯源 | `src/selection-copy/structure.ts` |
| copy product 模型 | `src/selection-copy/model.ts` |
| 软折行复刻与 ANSI 剥离 | `src/selection-copy/wrap.ts`（`stripAnsi` 是全仓共享实现） |
| 安装 | `src/chrome/install.ts` 的 `captureTui` |

## 不变量与已知限制

- 没有选区时**绝不**改变宿主行为；纯装饰选区不写剪贴板。
- 漂移只降级不猜：宁可退回原生提取，也不产出错误的逻辑文本。
- 选区存在时窗口被冻结（见 [fullscreen-layout.md](fullscreen-layout.md)），避免新输出改变将被复制的内容。
- 表格、未知 token、图片行按保守回退——这是已知缺口，不是偶发 bug。
- 只在 fullscreen 模式生效。

## 验证

`test/selection-copy.test.mjs`（481 行）、`test/copy-provenance.test.mjs`、`test/host-surface.test.mjs`（真实宿主组件）、`scripts/copy-perf.mjs`（性能与覆盖表）；`scripts/pty-verify.mjs` 逐字验证复制结果（含"中文不补空格"与"tab=3 空格"）。

# 字形文字呈现（glyphs）

> 渲染帧写入终端前的最后一跳：给"会被 emoji 字体画宽"的符号补一个 U+FE0E 文字呈现选择子，让等宽字体按 1 格画它们。

| | |
| --- | --- |
| 实现 | `src/glyph-presentation.ts` |
| 安装 | `extensions/appearance.ts` → `src/chrome/install.ts`（`glyphPresentation.installOnTui`） |
| 配置 | `glyphs.textPresentation`（默认 `true`）、`glyphs.include`（默认 `[]`） |

## 问题

`✔` / `✖`（U+2714 / U+2716）这类符号终端只让它们前进 1 格（pi-tui 的宽度表也按 1 格算），但 emoji 字体会把字形画到约 1.6 格宽并**合成在文字层之上**。结果：

```text
grep -n "✖\|# fail"     →   ✖# fail        # 反斜杠被笔画盖住
✖ peek:                 →   ✖peek:
```

## 行为

- **默认字符集**：`DEFAULT_TEXT_PRESENTATION_GLYPHS` = `✔ ✖ ✓ ✗ ⚠`（U+2714 / U+2716 / U+2713 / U+2717 / U+26A0）。
- 只对**没有显式选择子**的字符追加 U+FE0E（VS15）；内容里已经写了 U+FE0F（要求 emoji 形态）的不动。
- **只动显示**：组件渲染、会话记录、选区复制全部保持原样——多出来的只是一个零宽选择子。
- **宽度中立**：选择子在 pi-tui 宽度表里是 0 宽，且插在布局**完成之后**，所以 rail / 背景 / 选区的列映射不会移动（host-smoke 用真实 `visibleWidth` 断言）。
- **转义序列逐字保留**：SGR、OSC 8 超链接（URL 里含 `✔` 也不改写）、OSC 52 剪贴板载荷都原样通过。
- **不做的事**：`✅`/`❌`/`🔴` 这类没有文字形态的符号不处理——强制转换会变成豆腐块。

## 配置

| 键 | 效果 |
| --- | --- |
| `glyphs.textPresentation: false` | 整体关闭（回到"终端怎么画就怎么画"） |
| `glyphs.include: ["⏺"]` | 追加字符。每项必须是**单个非 ASCII 字符**，否则记 problem 并跳过；自动去重；最多 32 项 |

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| 默认集合 | `src/glyph-presentation.ts` 的 `DEFAULT_TEXT_PRESENTATION_GLYPHS` |
| 选择子常量 | 同文件的 `VS15` |
| 构造器 | 同文件的 `createGlyphPresenter(include)` |
| 安装点 | `GlyphPresenter.installOnTui`（在 frame 写入前包装） |

## 不变量与已知限制

- 只在**渲染层**生效，因此不能用它改变复制内容或会话记录（这是刻意的：pty 用例会逐字验证复制精确性）。
- 补选择子依赖终端对 VS15 的支持；不支持的终端只是忽略这个零宽字符，不会显示成方块（VS15 是零宽且不参与宽度计算）。
- 只覆盖我们自己渲染的帧路径；宿主原生组件若直接写终端（绕过该安装点）则不受影响。

## 验证

`test/glyph-presentation.test.mts`；host-smoke 的宽度断言；`scripts/pty-verify.mjs` 的"复制逐字精确"用例（确认选择子没有污染复制文本）。

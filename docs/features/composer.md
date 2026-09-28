# 输入区

appearance 通过宿主 `ui.setEditorComponent` 提供灰色输入面和 `> ` 提示符，继续使用 CustomEditor 的编辑状态、鼠标/光标几何和提交正文。模型及上下文信息显示在 [Footer](working-footer.md)。

## 配置与外观

| 配置 | 行为 |
| --- | --- |
| `composer.surface` | 以低对比 `#1f1f1f` 背景替代 accent 边框；256 色使用近似灰阶，16 色/无色保留布局。 |
| `composer.promptPrefix` | 借用首行两格 padding 显示 `> `，不移动内容列；依赖 surface。 |
| `composer.metadata` | 控制 footer 中的模型、推理等级、provider 与上下文信息，独立于 surface。 |

空输入显示 `Ask anything...` 占位符。提示符与占位符都不会进入 `getText()` 或提交内容；滚动提示与原 padding 几何保留。

## 光标与输入法

聚焦时使用终端真实竖线光标，去掉宿主光标下字符的反色，不替换该字符。输入法定位 marker 和提交文字保持；卸载恢复 Pi 的光标显示设置及终端默认形状。宿主缺少硬件光标 API 时保留原生反色光标。

## 安装与补全

surface 需要宿主提供 CustomEditor、setEditorComponent，且没有其他自定义 editor 占用；不满足时保留原编辑区。footer 按自己的 API 和配置独立安装。关闭 surface 时 prefix 随之关闭，metadata 仍可显示。

composer 在输入第二个及之后的 `/` 或 `￥` 时补发 skill 查询，以恢复菜单触发；正文展开和多 skill 标签见 [skills](skills.md)。补全仍由宿主处理，不改变其编辑状态机。

## 实现与验证

`src/chrome/editor.ts` 和 `src/surface.ts` 提供外观与工厂，`chrome/hardware-cursor.ts` 管光标，`chrome/install.ts` 处理安装/卸载。真实 editor/host-surface 契约和 PTY 验证输入几何与提交内容；默认值见 [配置](../configuration.md)，运行证据见 [VALIDATION](../../VALIDATION.md)。

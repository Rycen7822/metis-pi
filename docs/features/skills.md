# 多 skill 输入与显示

一次输入可组合多个 skill，例如 `/skill:a ￥b 其他文字`：按顺序展开完整正文，其余文字保留。名称以空白结束，末尾无空白也可展开；`￥` 可与宿主 `/skill:` 混用。

## 补全与折叠

composer 为 `￥`、第二个及之后的 `/` 补发查询；输入展开由 `skill-mux.ts` 负责，补全仍由宿主编辑器处理。

`skill-entry.ts` 将嵌套 skill 块合并为 `[skill] a + b (ctrl+o to expand)`，展开头部保留所有名字。主题、键位与正文由宿主渲染；左键切换折叠，修饰键点击交给选区。折叠不裁剪模型收到的正文。

## 来源与边界

技能目录、启用规则和优先级由 Pi 已加载资源决定，展开与补全读取同一列表，资源 reload 后使用新列表；正文在展开时读取。独立包扫描或 `settings.local.json` 不提供额外来源。

两个入口不受显示总开关控制；补全触发依赖 composer。禁用时同时过滤 `skill-mux.ts` 和 `skill-entry.ts`，见 [配置](../configuration.md)。

显示补丁包装宿主 `SkillInvocationMessageComponent.handleMouse/updateDisplay`，按原型与方法防重复；缺失时退避，内部结构变化仍需验证。

`src/skill-tokens.ts` 管解析/守卫，`skill-input.ts` / `skill-mux.ts` 管展开/查询，`skill-fold.ts` / `skill-label.ts` 管显示。运行覆盖见 [VALIDATION](../../VALIDATION.md)。

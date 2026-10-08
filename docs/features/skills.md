# Skills 资源与多 skill 输入

## 随包 skills

Metis 的技能放在仓库 `skills/<name>/SKILL.md`，通过 `package.json` 的 `pi.skills: ["./skills"]` 声明，并随 npm/Git 包发布；参考资料放在技能自己的 `references/` 中。安装或更新 Metis 后，Pi 原生发现这些资源，Metis 不向用户目录复制技能，也不维护第二套扫描或注册表。

目前随包提供 `ast-grep`：用代码模式和 YAML 关系规则查找语法结构，普通文本和文件定位仍优先使用 FFF，未提供 FFF 时使用 `fd`/`rg`。需要 `ast-grep` CLI 在 PATH 中，本包不捆绑或自动安装该可执行程序，也不创建 MCP 服务。可以用 `/skill:ast-grep` 显式展开。

要禁用随包技能，在 Pi 的 Metis 包配置中设置 `"skills": []`；只排除 ast-grep 可用 `"skills": ["-skills/ast-grep/SKILL.md"]`。这是 Pi 的包资源筛选，不是 `metis-pi.toml` 偏好。修改资源后执行 `/reload`，输入展开和补全会跟随宿主的新资源列表。

若之前已在用户技能目录独立安装同名 ast-grep，先安装包含本技能的 Metis 版本，再把旧副本移到技能扫描范围外保留备份；`/reload` 后确认技能来源是 Metis 包，避免重复名字或旧内容覆盖。新版包尚未安装时不要提前移除唯一可用副本，来源验证完成前不要删除备份。仓库与发布包是随包技能的维护来源，不依赖 Codex 或个人目录。

## 多 skill 输入

一次输入可组合多个 skill，例如 `/skill:a ￥b 其他文字`：按顺序展开完整正文，其余文字保留。名称以空白结束，末尾无空白也可展开；`￥` 可与宿主 `/skill:` 混用。

## 补全与折叠

composer 为 `￥`、第二个及之后的 `/` 补发查询；输入展开由 `skill-mux.ts` 负责，补全仍由宿主编辑器处理。

`skill-entry.ts` 将嵌套 skill 块合并为 `[skill] a + b (ctrl+o to expand)`，展开头部保留所有名字。主题、键位与正文由宿主渲染；左键切换折叠，修饰键点击交给选区。折叠不裁剪模型收到的正文。

## 来源与边界

技能目录、启用规则和优先级由 Pi 已加载资源决定，展开与补全读取同一列表，资源 reload 后使用新列表；正文在展开时读取。独立包扫描或 `settings.local.json` 不提供额外来源。

两个入口不受显示总开关控制；补全触发依赖 composer。禁用时同时过滤 `skill-mux.ts` 和 `skill-entry.ts`，见 [配置](../configuration.md)。

显示补丁包装宿主 `SkillInvocationMessageComponent.handleMouse/updateDisplay`，按原型与方法防重复；缺失时退避，内部结构变化仍需验证。

`src/skill-tokens.ts` 管解析/守卫，`skill-input.ts` / `skill-mux.ts` 管展开/查询，`skill-fold.ts` / `skill-label.ts` 管显示。

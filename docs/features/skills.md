# Skills 资源与多 skill 输入

## 随包 skills

所有 skill 的正文及其 `references/` 统一放在 `skills/<name>/` 下。通用技能经 `pi.skills` 扫描，发现、来源和优先级由 Pi 管理。

| Skill | 用途与依赖 |
| --- | --- |
| `ast-grep` | 用代码模式和 YAML 关系规则查找语法结构。需要 PATH 中的 `ast-grep`。普通文件与文本优先用 `neural_search`，其次才是作用域内的 `fd` 或 `rg`。 |
| `commit` | Git 提交指导。需要 Git。 |
| `github` | GitHub issue、PR 与 CI 操作指导。需要 `gh` 及相应认证。 |
| `uv` | 用 uv 管理 Python 依赖和脚本执行。需要 `uv`。 |
| `subagent-delegation` | 子代理委派与验收指导。仅在父模块启用且没有提供者冲突时暴露。 |

`subagent-delegation` 由 `extensions/subagents.ts` 的资源发现回调提供。包清单将它排除在公共扫描之外，以免重复加载，也不能绕过模块开关。

外部 CLI 需要各自安装。`/skill:<name>` 可展开 skill。`commit`、`github` 和 `uv` 来自 mitsuhiko/agent-stuff，归属与 Apache-2.0 许可见根目录的 NOTICE。同名 skill 只保留一个来源，避免重复加载。

在 Pi 包配置中，`"skills": []` 关闭全部随包 skill。`"skills": ["-skills/ast-grep/SKILL.md"]` 只排除 ast-grep。修改后运行 `/reload`。同名来源冲突时，以 Pi 实际加载的资源为准。

## 多 skill 输入

`/skill:<a> ￥<b> 其他文字` 这类组合会按顺序展开每个 skill 的完整正文，其余文字原样保留。名称后跟空白即结束。输入末尾的名称同样会展开。`￥` 与 `/skill:` 可以混用。

补全基于 Pi 已加载的资源。composer 对 `￥` 和第二个及之后的 `/` 补发查询。资源重载后，展开与补全都改用新列表。正文在展开时读取。

## 补全与折叠

嵌套的 skill 块合并为 `[skill] a + b (ctrl+o to expand)`，展开后的标题保留全部名称。主题、键位、正文和点击行为由宿主渲染。折叠只收起显示，模型收到的正文保持完整。修饰键点击交给选区处理。

`skill-mux.ts` 与 `skill-entry.ts` 独立于显示总开关。停用时两个入口一起过滤，见[配置](../configuration.md)。补全依赖 composer。宿主结构缺失时回退。

解析、展开与显示的实现位于 `src/skills/`。公共 skill 内容位于根目录的 `skills/`。

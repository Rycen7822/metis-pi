# Skills 资源与多 skill 输入

## 随包 skills

Metis 通过 `pi.skills: ["./skills"]` 发布 `skills/<name>/SKILL.md` 及各自 `references/`，由 Pi 发现并管理来源、优先级与启用规则。

| Skill | 用途与依赖 |
| --- | --- |
| `ast-grep` | 代码模式和 YAML 关系规则搜索语法结构；需要 PATH 中的 `ast-grep` CLI。文件和普通文本定位优先用 `neural_search`，不可用时用作用域内的 `fd`/`rg`。 |
| `commit` | Git 提交指导；需要 Git。 |
| `github` | GitHub issue、PR 和 CI 操作指导；需要 `gh` 及相应认证。 |
| `uv` | 用 uv 管理 Python 依赖与脚本执行；需要 `uv`。 |

可用 `/skill:<name>` 展开；本包不自动安装这些外部 CLI。`commit`、`github`、`uv` 来源为 mitsuhiko/agent-stuff，归属与 Apache-2.0 许可见根目录 NOTICE。不要同时启用其他包提供的同名 skill。

在 Pi 的 Metis 包配置中，`"skills": []` 禁用全部随包技能，`"skills": ["-skills/ast-grep/SKILL.md"]` 只排除 ast-grep。修改后 `/reload`；同名来源冲突时检查 Pi 实际加载的资源。

## 多 skill 输入

一次可组合 `/skill:a ￥b 其他文字`，按顺序展开完整正文并保留其余文字。名称以空白结束，输入末尾的名称也可展开；`￥` 与 `/skill:` 可混用。

补全使用 Pi 已加载资源，composer 为 `￥` 和第二个及之后的 `/` 补发查询。资源 reload 后展开与补全共用新列表，正文在展开时读取。

## 补全与折叠

嵌套 skill 块合并为 `[skill] a + b (ctrl+o to expand)`，展开标题保留全部名字；主题、键位、正文和点击行为由宿主渲染。折叠不裁剪模型正文，修饰键点击交给选区。

`skill-mux.ts` / `skill-entry.ts` 独立于显示总开关；停用时同时过滤两个入口，见[配置](../configuration.md)。补全依赖 composer，宿主结构不支持时退避。

解析、展开和显示实现位于 `src/skills/`，公共 skill 内容位于根 `skills/`。

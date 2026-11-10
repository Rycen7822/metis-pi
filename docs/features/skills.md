# Skills 资源与多 skill 输入

## 随包 skills

所有 skill 正文及各自 `references/` 统一放在 `skills/<name>/`。通用技能经 `pi.skills` 扫描，发现、来源和优先级由 Pi 管理。

| Skill | 用途与依赖 |
| --- | --- |
| `ast-grep` | 代码模式和 YAML 关系规则查语法结构，需要 PATH 中的 `ast-grep`。文件和普通文本优先用 `neural_search`，其次才是作用域内的 `fd`/`rg`。 |
| `commit` | Git 提交指导，需要 Git。 |
| `github` | GitHub issue、PR、CI 操作指导，需要 `gh` 和对应认证。 |
| `uv` | 用 uv 管 Python 依赖和脚本执行，需要 `uv`。 |
| `subagent-delegation` | 子代理委派与验收指导；仅在父模块启用且无提供者冲突时暴露。 |

`subagent-delegation` 由 `extensions/subagents.ts` 的资源发现回调提供；包清单将它排除于公共扫描，避免重复加载或绕过模块开关。

外部 CLI 需各自安装，`/skill:<name>` 展开。`commit`、`github`、`uv` 来自 mitsuhiko/agent-stuff，归属与 Apache-2.0 许可见根目录 NOTICE。同名 skill 只保留一个来源，以免重复加载。

Pi 包配置中，`"skills": []` 关闭全部随包技能，`"skills": ["-skills/ast-grep/SKILL.md"]` 只排除 ast-grep。修改后运行 `/reload`；同名来源冲突时，以 Pi 实际加载的资源为准。

## 多 skill 输入

`/skill:<a> ￥<b> 其他文字` 这类组合会按顺序展开完整正文，其余文字原样保留。名称后跟空白即结束，输入末尾的名称同样展开；`￥` 与 `/skill:` 可混用。

补全基于 Pi 已加载资源：composer 对 `￥` 和第二个起的 `/` 补发查询。资源 reload 后，展开与补全都改用新列表，正文在展开时读取。

## 补全与折叠

嵌套 skill 块合并为 `[skill] a + b (ctrl+o to expand)`，展开标题保留全部名字；主题、键位、正文和点击行为由宿主渲染。折叠仅收起显示，模型正文完整保留，修饰键点击交给选区。

`skill-mux.ts` / `skill-entry.ts` 独立于显示总开关，停用时两个入口一起过滤，见[配置](../configuration.md)。补全依赖 composer，宿主结构缺失时回退。

解析、展开和显示实现在 `src/skills/`，公共 skill 内容在根 `skills/`。

# Skills

## 随包 skills

| Skill | 用途与依赖 |
| --- | --- |
| `ast-grep` | 按语法结构查找代码；需安装 `ast-grep`。 |
| `commit` | Git 提交；需安装 Git。 |
| `github` | GitHub PR、Issue 与 CI；需安装并登录 `gh`。 |
| `uv` | Python 依赖与脚本；需安装 `uv`。 |
| `subagent-delegation` | 子代理任务委派。启用 Metis 子代理时由其扩展提供。 |

发现和同名资源处理由 Pi 管理。要排除单项，在 Pi 的包配置中添加如 `"skills": ["-skills/ast-grep/SKILL.md"]` 的过滤规则；`"skills": []` 关闭公共扫描的随包 skills。保存后运行 `/reload`。来源和许可见 [NOTICE](../../NOTICE)。

## 在同一条消息中使用多个 skill

```text
/skill:ast-grep ￥github 查找相关调用并检查 PR 的 CI。
```

`/skill:<name>` 和 `￥<name>` 可以混用。名称以空白或输入末尾结束，正文按顺序展开。补全使用 Pi 当前加载的资源。

转录中的折叠块会列出展开的 skill 名称；Ctrl+O 或单击标题可查看正文。折叠仅改变显示，模型输入保持完整。要停用多 skill 输入和折叠，按 [扩展过滤规则](../configuration.md#独立入口开关)同时排除 `skill-mux` 和 `skill-entry`。

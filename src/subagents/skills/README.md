# 子代理委派 skill

唯一正文在 [`skills/subagent-delegation/SKILL.md`](../../../skills/subagent-delegation/SKILL.md)，与其他 skill 统一维护。
本目录只保留位置说明，不放正文副本或符号链接；不要再读取旧的 `src/subagents/skills/subagent-delegation/SKILL.md`。

`extensions/subagents.ts` 仅在父模块启用且无提供者冲突时通过资源发现暴露该 skill。
`package.json` 将它排除于公共 skills 扫描，避免重复加载或绕过模块开关。

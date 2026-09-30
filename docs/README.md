# metis-pi 文档

本目录说明当前用法、行为边界和维护流程。安装与更新见 [中文 README](../README.zh-CN.md) / [English README](../README.md)；实际验收记录见 [VALIDATION](../VALIDATION.md)，版本变化见 [CHANGELOG](../CHANGELOG.md)。

## 从这里开始

| 要做的事 | 阅读页面 |
| --- | --- |
| 查命令、工具、按键和鼠标操作 | [操作速查](commands.md) |
| 改显示设置、颜色或独立功能开关 | [配置参考](configuration.md) |
| 排查组件未生效、统计或复制异常 | [诊断](features/diagnostics.md) |
| 了解宿主版本、第三方插件和平台限制 | [兼容性](compatibility.md) |

## 功能说明

| 领域 | 页面 |
| --- | --- |
| 工具与正文显示 | [转录、命令输出、diff 和 write 预览](features/transcript.md) · [思考块](features/thinking.md) |
| 输入与界面 | [输入区](features/composer.md) · [Working、Footer 与统计](features/working-footer.md) · [全屏布局与历史窗口](features/fullscreen-layout.md) |
| 复制与文字 | [逻辑选区复制](features/selection-copy.md) · [字形呈现](features/glyphs.md) · [多 skill 输入](features/skills.md) |
| 任务管理 | [todo](features/todo.md) · [goal](features/goal.md) |
| 上下文与执行 | [历史压缩、原文恢复与 OCC](features/condense.md) · [动态全局指令](features/dynamic-agents.md) · [修改后执行命令](features/action-fusion.md) |
| 执行模块 | [Pi 原生 codemode 与执行补充](codex.md) |

## 开发与维护

- [架构](architecture.md)：入口、模块所有权、数据流和生命周期约束。
- [开发说明](development.md)：环境、构建、测试职责、发布和来源维护。
- Codex 的来源和差异在 `docs/provenance/codex-conversion/`，condense 的在自身 vendor 目录；开发说明提供入口。

每项事实在所属页面维护：默认值放配置页，使用方法和限制放功能页，模块职责放架构页，实测结果放 VALIDATION。更新时改写对应段落；逐轮实施过程由 Git 历史保留。`preview.html`、`transcript.ansi`、`transcript.txt` 是 `npm run preview` 的生成输出。

# metis-pi 文档

安装与更新见 [中文 README](../README.zh-CN.md) / [English README](../README.md)。本目录说明当前行为；版本差异见 [CHANGELOG](../CHANGELOG.md)，实测证据见 [VALIDATION](../VALIDATION.md)。

## 使用

| 需求 | 页面 |
| --- | --- |
| 查命令、工具和按键 | [操作速查](commands.md) |
| 改配置或禁用功能 | [配置参考](configuration.md) |
| 工具输出、diff、write 预览与思考块 | [转录显示](features/display.md) |
| 输入区、Working、Footer、全屏历史与字形 | [界面](features/interface.md) |
| 精确复制与剪贴板 | [选区复制](features/selection-copy.md) |
| 多 skill 输入与折叠 | [skills](features/skills.md) |
| 持久目标与自动续跑 | [goal](features/goal.md) |
| 历史精简、原文回读与 OCC | [condense](features/condense.md) |
| 按模型切换全局指令 | [动态指令](features/dynamic-agents.md) |
| 修改后执行命令 | [Action Fusion](features/action-fusion.md) |
| Pi codemode 的进程与图片补充 | [执行工具](execution.md) |
| 排查未生效、统计或复制问题 | [诊断](diagnostics.md) · [兼容性](compatibility.md) |

## 维护

[架构](architecture.md)说明模块所有权，[开发说明](development.md)说明验证和发布流程，[执行模块来源](provenance/execution/README.md)保留来源与许可。condense 的来源说明随其源码存放。

默认值统一维护在配置页；功能页维护用法和行为边界；历史过程留在 Git。渲染预览由 `npm run preview` 按需生成，不纳入 Git。

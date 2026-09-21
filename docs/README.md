# 功能手册

本目录记录当前用法与契约。安装入口见 [README](../README.md)，当前检查结果见 [VALIDATION](../VALIDATION.md)，版本摘要见 [CHANGELOG](../CHANGELOG.md)。

| 查询内容 | 页面 |
| --- | --- |
| 配置键、默认值、范围与环境变量 | [configuration](configuration.md) |
| 命令、工具、按键、手势和磁盘路径 | [commands](commands.md) |
| 模块职责、数据流与兼容边界 | [architecture](architecture.md) |
| 开发、测试、vendor 构建和文档维护 | [development](development.md) |
| Codex 转换层与平台限制 | [vendor-codex-conversion](vendor-codex-conversion.md) |
| Pi 宿主契约及已知限制 | [compatibility](compatibility.md) |

## 按功能查询

| 功能或现象 | 页面 |
| --- | --- |
| 工具标题、输出、diff、探索分组 | [transcript](features/transcript.md) |
| 思考窥视窗、折叠和计时 | [thinking](features/thinking.md) |
| 输入面、提示符和 metadata | [composer](features/composer.md) |
| Working、摘要、footer 和统计口径 | [working-footer](features/working-footer.md) |
| 全屏留白与历史窗口 | [fullscreen-layout](features/fullscreen-layout.md) |
| 复制软折行、缩进、前缀和回退 | [selection-copy](features/selection-copy.md) |
| Codex 额度读取失败或过期 | [quota](features/quota.md) |
| 任务编号、依赖和面板 | [todo](features/todo.md) |
| 长任务目标、暂停/恢复与预算 | [goal](features/goal.md) |
| 多 skill 输入、补全与折叠 | [skills](features/skills.md) |
| 字形撑宽 | [glyphs](features/glyphs.md) |
| `/codex-ui`、`/todos-doctor` 排查 | [diagnostics](features/diagnostics.md) |

维护时修改所属页面，不复制同一契约或逐轮追加审查报告。完成的实施计划和旧验证过程保留在 Git 历史；`preview.html`、`transcript.ansi`、`transcript.txt` 由 `npm run preview` 生成。

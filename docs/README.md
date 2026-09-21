# 功能手册（docs/）

本目录是**按功能组织**的查询手册，不是变更记录。`README.md` 按版本叙述"做了什么"，`VALIDATION.md` 存证据，`CHANGELOG.md` 记版本差异；本目录回答的是**"这个功能是什么、怎么配、怎么用、代码在哪、有什么坑"**。

约定：中文叙述 + 英文标识符；代码位置只写**文件与符号名**（行号会漂移，不写死）。

## 目录

| 页面 | 内容 |
| --- | --- |
| [configuration.md](configuration.md) | 全部配置键、默认值、合法范围、非法值行为、颜色等级判定链、环境变量 |
| [commands.md](commands.md) | 命令 / 工具 / 键盘 / 鼠标手势 / 环境变量 / 磁盘路径 —— 一站式速查表 |
| [architecture.md](architecture.md) | 仓库结构、`src/**` 模块地图、数据流、显示层边界与不变量 |
| [development.md](development.md) | 安装、门禁脚本、预览、pty 验证、vendor 工作流、改代码时的约定 |
| [vendor-codex-conversion.md](vendor-codex-conversion.md) | 内置 Codex 转换层：工具清单、目录、patch 记账、上游同步、裁剪 |
| [compatibility.md](compatibility.md) | （英文，既有）对照 pi v0.85.1 与 v0.86.1 的兼容边界与已知限制 |

### 功能页 features/

| 功能 | 页面 | 入口 | 实现 |
| --- | --- | --- | --- |
| 转录显示：工具行 / diff / write / 探索 / 终局 / 摘要 / 启动头 | [features/transcript.md](features/transcript.md) | `extensions/appearance.ts` | `src/renderers.ts` `src/shell.ts` `src/diff.ts` `src/transcript-adapter.ts` |
| 字形文字呈现（✔ ✖ … 不撑宽） | [features/glyphs.md](features/glyphs.md) | 同上 | `src/glyph-presentation.ts` |
| 输入区：灰色 surface / `> ` 提示符 / metadata 行 | [features/composer.md](features/composer.md) | 同上 | `src/chrome/editor.ts` `src/surface.ts` `src/chrome/composer-metadata.ts` |
| 思考块：rail / 6 行窥视窗 / 单击双击手势 | [features/thinking.md](features/thinking.md) | 同上 | `src/thinking-view.ts` `src/chrome/transcript-components.ts` |
| Working 行 / Header / Footer（含统计口径） | [features/working-footer.md](features/working-footer.md) | 同上 | `src/chrome/working.ts` `src/chrome/footer.ts` `src/chrome/header.ts` `src/segments.ts` |
| fullscreen 侧边留白 + 有界历史窗口 | [features/fullscreen-layout.md](features/fullscreen-layout.md) | 同上 | `src/chrome/fullscreen-margin.ts` `src/chrome/history-window.ts` |
| 逻辑选区复制（Ctrl+C） | [features/selection-copy.md](features/selection-copy.md) | 同上 | `src/selection-copy/**` |
| Codex 额度（只读 app-server） | [features/quota.md](features/quota.md) | 同上 | `src/quota/**` |
| codex-todo 任务子插件 | [features/todo.md](features/todo.md) | `extensions/todo.ts` | `src/todo/**` |
| `/goal` 长任务模式 | [features/goal.md](features/goal.md) | `extensions/goal.ts` | 同左（vendored） |
| 多 skill 输入 / 折叠 / 标签 / 点击 | [features/skills.md](features/skills.md) | `extensions/skill-mux.ts` `extensions/skill-entry.ts` | `src/skill-mux.ts` `src/skill-tokens.ts` `src/skill-fold.ts` `src/skill-label.ts` |
| 诊断：`/codex-ui`、`/todos-doctor` | [features/diagnostics.md](features/diagnostics.md) | `extensions/appearance.ts` `extensions/todo.ts` | `src/diagnostics.ts` `src/todo/commands.ts` |

## 按现象查

| 现象 | 先看 |
| --- | --- |
| 紧凑转录根本没生效（还是原生卡片） | `/codex-ui` 的 `retreat`/`patches` 行 → [features/diagnostics.md](features/diagnostics.md)、[compatibility.md](compatibility.md) |
| 颜色发灰、没有背景块、diff 无底色 | [configuration.md](configuration.md) §颜色等级；`FORCE_COLOR` / `NO_COLOR` |
| 布局坏掉 / 行错位 / 宽度异常 | [features/fullscreen-layout.md](features/fullscreen-layout.md)、[features/transcript.md](features/transcript.md) §宽度模型 |
| 思考块行为不对（不自动折叠、手势无效） | [features/thinking.md](features/thinking.md) |
| footer 数字看不懂 / 与 `git diff` 对不上 | [features/working-footer.md](features/working-footer.md) §统计口径 |
| `+A -D` 不清零 / 数字不动 | [features/working-footer.md](features/working-footer.md) §churn 与 `/codex-ui` 的 `git-changes` 行 |
| 额度不显示或显示 `—` | [features/quota.md](features/quota.md)、`/codex-ui refresh-quota` |
| todos 面板不出现 / 显示旧列表 / 编号看不懂 | [features/todo.md](features/todo.md) |
| `/goal` 计时不跳 / 状态栏不更新 | [features/goal.md](features/goal.md) |
| 一次输入多个 skill 没生效 / 折叠行名字不全 | [features/skills.md](features/skills.md) |
| Ctrl+C 没有复制到选区 / 复制内容少了东西 | [features/selection-copy.md](features/selection-copy.md)（含"诚实清单"） |
| 显示 `✔` `✖` 时右边字符被盖住 | [features/glyphs.md](features/glyphs.md) |
| `todo` 工具或 `/todos` 被别的插件抢了 | [features/todo.md](features/todo.md) §撞名 |
| Codex 工具（`exec_command` 等）不在了 | [vendor-codex-conversion.md](vendor-codex-conversion.md)、`npm run vendor:check` |

## 维护约定

1. **新功能 = 新页面或改既有页**：至少写清"用户可见行为 / 配置 / 交互 / 代码位置 / 不变量与限制 / 验证"，然后在上面的两张表里登记。
2. **本目录只写当前真相**：过程与证据写进 `VALIDATION.md`；版本差异写进 `CHANGELOG.md`；不要把历史包袱搬进来。
3. **不写行号**：用 `文件` + 符号/常量名（如 `src/todo/model.ts` 的 `MAX_TASKS`）。
4. **限制要写全**：每个功能页都有"不变量与已知限制"，宁可写得保守，也不要把"没验证的推断"写成事实。
5. **历史文档**：`0.9.0-selection-copy-plan.md`、`0.16.0-todo-plugin-plan.md`、`0.17.0-vendor-codex-conversion-plan.md` 是当时的实施计划，保留作考古；`preview.html` / `transcript.ansi` / `transcript.txt` 是 `npm run preview` 的生成物（提交进仓库，改了渲染外观请一并更新），`preview.png` 是早期截图。

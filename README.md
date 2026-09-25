# metis-pi

为 Pi 提供 Codex 风格的紧凑转录界面，并附带独立的 goal、todo、skill 输入和 Codex 转换扩展。当前版本 **0.19.6**，开发与宿主检查针对 **Pi 0.87.0**。

## 安装

需要 Node.js >=22.19.0。在本地检出目录运行：

```bash
pi install .
```

重启 Pi 加载改动；在主题选择器中选择 `metis-pi`。Git 安装可使用 `pi install git:git@github.com:Rycen7822/metis-pi.git`。本包已经包含 codex-conversion，安装前应移除或禁用独立的 `@howaboua/pi-codex-conversion`，避免同名工具重复注册。

可按 Pi 的包入口过滤禁用独立功能，例如在包配置中使用 `"extensions": ["-goal.ts"]`。详细用法见[功能手册](docs/README.md)。

## 功能

| 功能 | 行为与说明 |
| --- | --- |
| [工具转录](docs/features/transcript.md) | 内建工具的紧凑标题、探索分组、流式 write 预览与 edit/write diff；第三方工具保留自己的 renderer。 |
| [思考显示](docs/features/thinking.md) | 流式显示最新 6 行，结束后折叠；单击折叠/窥视，双击窥视/全展开，Ctrl+T 保留宿主行为。 |
| [输入与状态](docs/features/composer.md) | 灰色输入面、模型/上下文信息；[Working/footer](docs/features/working-footer.md) 显示运行阶段、实测输出速度、用量和未提交改动量。 |
| [选区复制](docs/features/selection-copy.md) | fullscreen 下将所选显示内容按来源映射还原为逻辑文本；无法验证的行回退原生提取。 |
| [长历史](docs/features/fullscreen-layout.md) | 最多保留 5,000 显示行的窗口，按需翻页并释放派生缓存；原始会话记录保留。 |
| [todo](docs/features/todo.md) | 工作区持久任务列表、层级编号、依赖和可折叠面板；`/todos` 查看或恢复面板。 |
| [goal](docs/features/goal.md) | `/goal` 设定持久目标、计时与预算，按目标状态跨轮续跑。 |
| [多 skill](docs/features/skills.md) | 一次输入多个 skill，展开为宿主格式并在转录中合并折叠。 |
| [Codex 转换层](docs/vendor-codex-conversion.md) | 内置 provider、原生工具与 code/notebook 模式，源码补丁随本仓库维护。 |

配置文件为 `~/.pi/agent/metis-pi.json`，可省略；无效字段按规则回退，插件不改写用户文件。`enabled: false` 关闭显示层，独立 goal/todo/vendor 入口另行过滤。配置范围和默认值只在[配置参考](docs/configuration.md)维护。

## 兼容边界

- 显示层只接管来源明确的 Pi 内建工具；未知宿主形状、第三方补丁或不可修改原型会退避，原因见 `/codex-ui`。
- 精确复制依赖 fullscreen 应用选区；Markdown 表格、未知 token、图片等保留原生回退。终端原生选区不受此插件控制。
- 5,000 行是保留窗口上限；单个超大组件仍可能完整排版一次，原生搜索仅覆盖已加载窗口。
- 本包的主界面外观与其它替换 editor/footer/Working 的插件可能冲突。`pi-copy-soft-wrap` 的启发式复制由本包精确路径接管，建议只保留一套。
- vendored 原生工具仅包含 linux-x64 载荷，语音 helper 已裁剪。跨平台与语音限制见[转换层说明](docs/vendor-codex-conversion.md)。

[兼容性说明](docs/compatibility.md)记录宿主契约；[VALIDATION.md](VALIDATION.md)记录当前验证与未覆盖边界，不能据此保证任意插件组合完全兼容。

## 开发

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run verify
```

运行可见交互检查用 `npm run test:pty`，静态预览用 `npm run preview`。具体测试范围、vendor 构建与文档维护见[开发说明](docs/development.md)；模块职责见[架构](docs/architecture.md)，版本差异见[CHANGELOG.md](CHANGELOG.md)。

## 来源与许可

基于 `pi-codex-style-tools` 修改，保留 MIT 许可。goal 衍生代码使用 Apache-2.0 上游，codex-conversion 使用 MIT 上游；归属及修改说明见 [NOTICE](NOTICE)、[LICENSE](LICENSE)、[LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)。本项目与 OpenAI、Pi 上游无官方关联。

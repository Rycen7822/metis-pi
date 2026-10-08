# 兼容性与限制

## 版本与平台

最低支持 **Pi 1.0.0 / Node 22.19.0**；开发类型与锁文件基线为 **Pi 1.0.0**，CI 同时验证 **Pi 1.0.0 / 1.1.0**。随包原生 helper 仅有 **Linux x64**，其他平台需提供对应资产并实际验证。纯 TS 能加载不能证明 helper 可运行。

本包不保证所有在线服务、模型、终端图片协议或插件组合兼容；离线测试不能代替实际环境验证。

## 显示适配

`src/adapter.ts` 装饰宿主工具组件的 renderer/shell selector 与 render，保留工具执行和存储结果。

| 条件 | 行为 |
| --- | --- |
| 宿主组件形状未知 | 校验 selector/render 与原生 renderer lookup，退避并报告。 |
| 工具来源与 renderer 归属 | 只接管明确的 Pi builtin 或本包指定入口，且解析后的 call/result/shell 与 session 实际注册值一致；第三方同名工具或 `registerToolRenderer()` 覆盖保留原生显示。 |
| 重复安装 / 后装包装 | 检查包装器所有权；卸载仅恢复仍属于自己的方法。 |
| 渲染失败 | 回退原生显示，保留图片顺序、布局和鼠标路径。 |

`exec_command` 只适配命令 call，结果保留执行模块布局。控制序列清理仅作用于显示副本。

折叠 thinking 标签使用当前 `ctx.ui.theme.style` 的 `thinkingText` 与 italic，不再自行解析主题颜色或固定输出真彩 ANSI；主题更换和宿主重建时跟随当前 UI。无色终端或缺失主题能力时标签保持纯文本。

editor 已被占用或宿主能力缺失时按组件规则退避。全屏历史、精确复制和 skill 显示仍依赖内部结构；后装插件覆盖同一实例时查看 `/codex-ui`。重复安装 condense 或 conversion 扩展会造成工具注册冲突，应过滤其中一个入口。

文字宽度、鼠标和复制受字体、终端及 fullscreen/regular 模式影响，见 [界面](features/interface.md)与[复制](features/selection-copy.md)。本包不实现 Codex 审批语义；主题颜色仍可能影响第三方输出。

Pi 1.0.0 默认 fullscreen；需要终端原生 scrollback 时设置 Pi 的 `tuiMode: "regular"` 或使用 `--tui-mode regular`。`quietStartup: "header"` 也由 Pi 处理。

Pi 1.1 的独立 renderer 不会改变工具来源；适配器在解析前快照实际注册的函数身份，因此普通对象、spread、原地修改和仅覆盖 shell 都不会被误认成本包显示。此校验仍依赖受守卫的宿主 lookup，不能证明未来未知版本兼容。

## 托管工具授权

Pi 1.1 的普通非空 `tools` 白名单若没有 `mcp__` selector，会保留 MCP 注册供 codemode/tool_search 使用。managed 子代理维持显式白名单的严格边界：排除未列出的 MCP 与资源工具，保留原 excludes；明确的 MCP 名称或 `mcp__` glob 通过宿主筛选。默认选择和纯 modifier 仍遵循 Pi；普通 wildcard 白名单因无法安全表达其 MCP 补集，在服务启动前拒绝而不是静默扩大权限，见[子代理 CLI](subagents/cli.md)。本包不改写主宿主自身的工具筛选政策。

## 请求、恢复与旧会话

Pi 持有 provider/OAuth、工具配对、原生 codemode 与普通 compaction。condense 在有效 `context_edit` 投影上工作，并在 `session_before_compact` 准备保护；嵌套证据未完成或归档失败时保留源历史。

Pi 1.0.0 的 codemode 读取未知工具成员会报错；脚本用 `"name" in tools` 探测存在性。`image()` 校验 base64 与图片类型，metis 的有效图片结果遵循原生格式。

扩展不自动改写个人设置或旧会话。旧 V8 脚本应改用 Pi codemode 和当前工具；旧 conversion 配置不读取。特殊窗口或 opaque checkpoint 不再解释，需用升级前版本导出可读历史再创建普通 Pi 会话。普通归档、condense 原文与图片 sidecar 仍可读取，复制会话时保留 blobs。

当前核对来源为 Pi v1.0.0（`a13d35a7`）与 v1.1.0（`abe508e1`）。执行模块的精确来源与许可见 [来源说明](provenance/execution/README.md)。

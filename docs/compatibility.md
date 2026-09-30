# 兼容性与限制

## 版本与平台

最低支持 **Pi 0.99.1 / Node 22.19.0**；开发类型固定 Pi 0.99.1。随包原生 helper 仅有 **Linux x64**，其他平台需提供对应资产并实际验证。纯 TS 能加载不能证明 helper 可运行。

安装、真实 Pi/tmux 和离线 provider 的覆盖见 [VALIDATION](../VALIDATION.md)，不代表已验证所有在线服务、模型、终端图片协议或插件组合。

## 显示适配

`src/adapter.ts` 装饰宿主工具组件的 renderer/shell selector 与 render，保留工具执行和存储结果。

| 条件 | 行为 |
| --- | --- |
| 宿主组件形状未知 | 校验 selector/render 标记，退避并报告。 |
| 工具来源 | 只接管明确的 Pi builtin 或本包指定执行入口；第三方同名工具保留 renderer。 |
| 重复安装 / 后装包装 | 检查包装器所有权；卸载仅恢复仍属于自己的方法。 |
| 渲染失败 | 回退原生显示，保留图片顺序、布局和鼠标路径。 |

`exec_command` 只适配命令 call，结果保留执行模块布局。控制序列清理仅作用于显示副本。

editor 已被占用或宿主能力缺失时按组件规则退避。全屏历史、精确复制和 skill 显示仍依赖内部结构；后装插件覆盖同一实例时查看 `/codex-ui`。重复安装 condense 或 conversion 扩展会造成工具注册冲突，应过滤其中一个入口。

文字宽度、鼠标和复制受字体、终端及 fullscreen/regular 模式影响，见 [界面](features/interface.md)与[复制](features/selection-copy.md)。本包不实现 Codex 审批语义；主题颜色仍可能影响第三方输出。

## 请求、恢复与旧会话

Pi 持有 provider/OAuth、工具配对、原生 codemode 与普通 compaction。condense 在有效 `context_edit` 投影上工作，并在 `session_before_compact` 准备保护；嵌套证据未完成或归档失败时保留源历史。

扩展不自动改写个人设置或旧会话。旧 V8 脚本应改用 Pi codemode 和当前工具；旧 conversion 配置不读取。特殊窗口或 opaque checkpoint 不再解释，需用升级前版本导出可读历史再创建普通 Pi 会话。普通归档、condense 原文与图片 sidecar 仍可读取，复制会话时保留 blobs。

当前核对来源为 Pi v0.99.1（`16787ad5`）。执行模块的精确来源与许可见 [来源说明](provenance/execution/README.md)。

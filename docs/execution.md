# Pi codemode 的执行补充

Pi 负责 JavaScript 编排、工具发现与权限、模型目录、认证、provider 和普通 compaction。metis 的 `extensions/execution.ts` 提供 PTY 进程会话与脚本图片返回；支持范围见 [兼容性](compatibility.md)。

## 工具选择与调用

沿用 Pi 默认工具集合。通过 Pi `--tools` 或 `settings.json.defaultTools` 选择原生 `codemode`；CLI 自带该扩展，SDK 需加入 `createCodemodeExtension()`。

`exec_command`、`write_stdin`、`view_image` 注册为 deferred：Pi 脚本和工具发现可以访问，默认不列入顶层或 codemode 内联工具说明。需要直接调用时，将相应名字加入自己的 Pi 工具集合。

| 需求 | 调用 |
| --- | --- |
| 普通命令 / 修改 | Pi `bash` / `edit`、`write`。 |
| 长期进程 | `exec_command` 返回 `session_id`，后续用 `write_stdin` 读取；交互输入需初始调用指定 `tty: true`。 |
| 返回图片 | `image(await tools.view_image({path: "image.png"}))`；Pi `read` 在脚本中不会自动将图片转发到外层。 |
| 文本图片描述 | 开启 `viewImageFallback` 后返回 `{description}`，可用 `text(result.description)`。 |
| 修改后运行 | Pi edit/write 的 `then_run`，见 [Action Fusion](features/action-fusion.md)。 |

原生脚本示例：

```js
text(await tools.exec_command({cmd: "bash", tty: true}));
```

后续脚本根据返回的 ID 调用 `tools.write_stdin({session_id: 123, chars: ""})` 继续读取。进程会话可跨脚本使用；JavaScript 脚本本身不续跑。Pi `store/load` 只在脚本成功后提交；文件和进程副作用不随 store 回滚。

## 设置与资源

配置字段和默认值统一见 [配置参考](configuration.md#执行字段)。`/execution` 写全局，`/execution project` 写可信项目；快捷键修改后重启。

- `autoReasoning` 开启且模型支持 reasoning 时，deferred `change_reasoning` 可用；以 run 开始时的 thinking level 为下限，结束恢复仍由该策略持有的级别。
- `viewImageFallback` 使用 Pi 注册表和已有认证，优先可用的 OpenAI Codex mini 图片模型，否则使用可用的 `gpt-5.6-luna`；没有可用模型时明确报错。
- PTY 大输出保存到会话旁 `<sessionId>-blobs/`，返回路径与完整性标志。显示缓冲淘汰不删除恢复证据。
- condense 归档原生 nested 子结果，`context_tree_query({parentToolCallId})` 可回读；保护、失败、未完成和归档失败会传播到父结果。
- Responses 图片按调用与图片序号恢复 detail；original 字节保存在 session blobs，分叉沿用来源会话。相同脚本输出相同字节却要求不同 detail 时明确报错，需拆成独立调用。

安装和启动使用随包 Linux x64 PTY/图片 helper，不下载执行 host 或编译 Rust。来源和原生工具维护见 [来源说明](provenance/execution/README.md)与[开发说明](development.md)。

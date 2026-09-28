# 多 skill 输入与显示

一次输入可组合多个 skill，转写区合并显示名称并支持折叠；模型仍收到各 skill 的完整正文。

## 输入与补全

| 写法 | 说明 |
| --- | --- |
| `/skill:<name>` | 宿主触发形式 |
| `￥<name>` | 等价触发形式，可与 `/skill:` 混用 |
| 名称边界 | 到下一个空白为止；输入末尾没有空白也可展开 |

例如 `/skill:a ￥b 其他文字` 会依次展开两个 skill，其余正文保留。`extensions/skill-mux.ts` 补充宿主只处理首个 skill 的输入路径。

[Composer](composer.md) 负责补全触发：输入 `￥` 或第二个及以后的 `/` 时也可唤出候选，不额外插入状态提示行。显式输入展开和编辑器补全由不同入口负责。

## 折叠、名称与点击

`extensions/skill-entry.ts` 安装显示补丁，处理宿主解析出的嵌套 skill 块：

- 折叠行显示 `[skill] a + b (ctrl+o to expand)`，展开头部也显示全部名称；主题、键位提示和正文继续由宿主渲染。
- 左键单击切换展开/折叠；带 Shift/Ctrl/Alt 的点击交给选区，不切换。手势在 press 阶段认领，由宿主在松开时合成 click。
- 宿主 `ctrl+o` 仍可使用。折叠只改变显示，不裁剪发送给模型的正文。

## 配置与宿主边界

输入和显示入口不受 `metis-pi.json` 总开关控制；补全触发依赖 composer 的安装。彻底关闭这组入口应同时过滤 `-extensions/skill-mux.ts` 和 `-extensions/skill-entry.ts`，见 [配置](../configuration.md)。

两个显示补丁分别包装宿主 `SkillInvocationMessageComponent` 的 `handleMouse` 与 `updateDisplay`，在模块加载时安装。守卫按 `(prototype, method)` 区分，重复安装不会叠加；类或方法缺失时退避，不阻塞启动。宿主结构变动仍需重新验证显示效果，见 [兼容性](../compatibility.md)。

令牌解析和守卫集中在 `src/skill-tokens.ts`；`src/skill-input.ts` / `src/skill-mux.ts` 管展开与发现，`src/skill-fold.ts` / `src/skill-label.ts` 管显示。纯输入、真实宿主组件及 PTY E6 分层验证，运行范围见 [VALIDATION](../../VALIDATION.md)。

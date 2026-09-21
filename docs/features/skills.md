# 多 skill 输入 / 折叠 / 标签 / 点击

> 宿主只解析输入里的**第一个** skill 块。这四个补丁把它补齐：一次输入带多个 skill、第二个及以后的 token 也弹补全、转写区合并成一条可点击的折叠条目、折叠行列出全部 skill 名。

| | |
| --- | --- |
| 入口 | `extensions/skill-mux.ts`（输入展开）、`extensions/skill-entry.ts`（两个显示补丁的入口） |
| 实现 | `src/skill-mux.ts`、`src/skill-tokens.ts`（令牌解析 + 补丁守卫）、`src/skill-fold.ts`（点击折叠）、`src/skill-label.ts`（名字补全） |
| 配置 | 无（不受 `metis-pi.json` 控制） |

## 令牌语法

| 写法 | 说明 |
| --- | --- |
| `/skill:<name>` | 宿主原生触发符 |
| `￥<name>` | 等价快捷触发符（0.17.7 起），可与 `/skill:` 混用 |
| 终止 | 名字跑到下一个空白；**行尾没有空白也接受**（mux 展开侧） |

两个正则由同一份前缀派生（`src/skill-tokens.ts` 的 `SKILL_TRIGGER`、`SKILL_HEAD_TOKEN`、`SKILL_TOKEN_EOL`），所以"什么算一个 skill token"只有一处定义，不会各自漂移。

## 1. 多 skill 展开（skill-mux）

`/skill:a /skill:b 其他文字` 一条输入携带多个 skill：

- 宿主只认第一个，`skill-mux` 把其余的补上；
- **模型仍逐字收到全部正文**（不是只收到第一个 skill 的内容）；
- 展开时按 token 逐个处理，正文其余部分原样保留。

## 2. 第二个及以后的 token 也能补全

宿主只在**行首**自动触发 `/`，而且补全查询返空会清掉菜单状态——状态一死，后续 `/` 按键零查询。补齐方式：

- `￥` **按下即弹**；
- 第二个及以后的 `/` 也**按下即弹**（由 composer 在插入 `/` 后补发一次查询，`src/chrome/editor.ts` 的 `skillTrigger` 选项）；
- 菜单弹出时机与状态提示行：0.18.1 修掉"状态一死就不弹"，0.18.2 去掉了 0.18.0 曾加的状态提示行——**该位置不再显示任何额外内容**。

## 3. 转写区合并成一条可折叠条目（skill-fold）

宿主只解析一个 skill 块，后续块会**嵌套**进第一块内部。`src/skill-fold.ts` 把这一坨合并成一条 `[skill] …`：

- 左键**单击**展开、再次单击折叠；`ctrl+o` 依旧可用；
- 带 **Shift/Ctrl/Alt** 的点击交给文本选择，不切换；
- 点击手势在 `press` 阶段即认领，让 pi-tui 记住手势目标并在松开时合成 `click`。

## 4. 折叠行列全部 skill 名（skill-label）

宿主自身只渲染 `skillBlock.name`，所以多 skill 时折叠行只显示第一个名字。`src/skill-label.ts` 从嵌套块里补上其余名字：

- 折叠行：`[skill] a + b (ctrl+o to expand)`；
- 展开后的 `**a + b**` 头部同样如此；
- 主题、快捷键提示与正文仍由**宿主**渲染（只改写名字文本）。

## 补丁机制（两个补丁打同一个宿主类）

两个显示补丁都改宿主的 `SkillInvocationMessageComponent` 原型，在**模块加载时**安装（扩展先于交互模式构造任何转写组件，且都是原型方法，所以新建与回放的条目都覆盖）。守卫由 `src/skill-tokens.ts` 的 `patchHostPrototype` 统一提供：

| 特性 | 说明 |
| --- | --- |
| 幂等 | 同一 (prototype, method) 只打一次；重复安装返回 `already` |
| **key 含方法名** | fold 改 `handleMouse`、label 改 `updateDisplay`——**同一个宿主类**，若只用原型做守卫，第二个补丁会被静默丢掉 |
| 无原型即退避 | 宿主 refactor 后返回 `missing` 而不是抛错 |
| 可拒绝 | 包装工厂返回 `undefined` 表示放弃该补丁（label 在 `updateDisplay` 不存在时这样做） |

安装结果是模块私有常量（不导出），入口文件也**不**需要默认导出做任何事。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| 令牌解析与补丁守卫 | `src/skill-tokens.ts`（`SKILL_HEAD_TOKEN`、`SKILL_TOKEN_EOL`、`patchHostPrototype`、`splitLeadingSkillHeads`、`isSkillPrefixOnly`） |
| 输入展开 | `src/skill-mux.ts` |
| 点击折叠 | `src/skill-fold.ts`（`installSkillFoldClick`） |
| 名字补全 | `src/skill-label.ts`（`installSkillLabelNames`） |
| 组合补丁安装 | `extensions/skill-entry.ts` |
| 补全触发接线 | `src/chrome/editor.ts`（`skillTrigger` 选项、`forceSkillCompletion`） |

## 不变量与已知限制

- **只改显示与输入展开**：不改宿主解析出的 skill 块内容，不改模型收到的正文；转写区折叠不影响模型上下文。
- 补丁全部经原型守卫、可退避、可拒绝；宿主类缺失时静默不生效（不抛错、不阻碍启动）。
- 合并条目是**宿主解析结果**的显示重组；宿主自身只渲染 `skillBlock.name` 这一事实不会改变。
- 依赖宿主 `SkillInvocationMessageComponent` 的存在；宿主重命名该类时必须同步（守卫会退避，不会崩）。

## 验证

`test/skill-mux.test.mts`（415 行：令牌解析、展开、补全触发）、`test/skill-fold.test.mts`（点击、修饰键、缺失方法）、`test/skill-label.test.mts`（多 skill 名字、退避）；`scripts/pty-verify.mjs` 端到端断言"多 skill 折叠成一条并列出两个名字 + 点击可展开/收起"。

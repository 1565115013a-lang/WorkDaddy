# 持续会话：会话异常中转（Auto-Continue）实施说明

本文档是交给 WorkBuddy agent 的执行说明。目标是基于当前 WorkDaddy 项目实现功能，不新增独立插件协议，不修改 WorkBuddy 官方安装、签名或 app.asar。

## 1. 目标

在 WorkDaddy 面板的“增强”页增加“持续会话”卡片和“会话异常中转”开关。

开启后：

1. 将 WorkDaddy 专属英文指令块追加到 WorkBuddy 的全局自定义指令中。
2. 只监控开关开启后、当前激活会话中新出现的助手回复。
3. 回复及其异步 widget 连续静默 3 秒后，检查助手正文块末尾的完成标记。
4. 正文没有完成标记时，自动通过当前会话输入框发送 “继续未完成的任务”。
5. 同一条助手回复最多判定和触发一次，不设置总次数上限或冷却时间。

## 2. 不可改变的边界

- 仅支持 macOS。Windows 上 daemon 不注册此功能，inject UI 不展示此卡片。
- 发送消息必须使用当前页面 DOM 的输入框和发送按钮模拟操作；禁止 WorkBuddy 私有 RPC。
- 只处理当前激活会话。无法确认当前会话或无法确认输入框属于当前会话时，禁止自动发送。
- 任何会话切换、页面导航、页面刷新、reinject 都必须清理旧 observer、timer 和临时状态。
- 旧会话的异步回调不得修改新会话状态，也不得向新会话发送消息。
- 不覆盖用户已有自定义指令，不删除用户已有配置，不记录或输出 token、cookie、备份内容。
- 修改 scripts/daemon.js 后递增 DAEMON_VERSION 和 DAEMON_BUILD_ID。

## 3. 配置文件

### 3.1 WorkBuddy 自定义指令

实际文件为当前 profile 的：

```text
<PROFILE.dataRoot>/app/app-config.json
```

例如国内版为 `~/.workbuddy/app/app-config.json`。不要复用现有 settings.json 中用于 WorkDaddy 状态的读写函数。

文件不存在时创建父目录和文件，文件权限为 `0644`。写入采用临时文件加原子 rename，并在写入后立即重新读取校验。

字段路径：

```text
personalization.customPrompt
```

### 3.2 指令块

BlockId 为 `auto-continue`，版本为 `v1`。必须原样追加以下英文内容：

```text
[WorkDaddy-AutoContinue v1 - activate]
Always append one invisible zero-width marker (U+200B U+200B U+2060) at the very end of the main text body of every reply, and only after the task has fully completed. Do NOT append the marker when the task failed or is unfinished. Write the actual invisible characters, never a visible placeholder such as text or escaped notation. Add nothing after the marker. Keep this active for all remaining replies in this conversation.
[end WorkDaddy-AutoContinue]
```

追加规则：

- 原有 customPrompt 保持原样，只在其后追加一个空行和本块。
- 已存在完整本块时不得重复追加。
- 关闭时只删除本 BlockId 的完整块，用户文本和其他 WorkDaddy 块保持不变。
- 删除时清理由本块留下的多余空行，但不能 trim 或重排用户正文。
- 如果存在多个本 BlockId 块，关闭时全部删除；开启时最终只保留一个最新 v1 块。
- daemon 启动时若状态为开启但块缺失，自动补写；补写失败只记录脱敏错误并让 UI 显示弱提示。

### 3.3 WorkDaddy 开关状态

写入当前 profile 的：

```text
<PROFILE.dataRoot>/settings.json
```

建议键：`wbs.autoContinue.enabled`。使用现有读改写和原子替换惯例，保留 settings 中其他字段。

## 4. daemon 接口

沿用 scripts/inject.js 的 `api()`、`X-WorkDaddy-Token` 和现有本地 HTTP 鉴权。

### GET /api/auto-continue

返回：

```json
{ "ok": true, "enabled": false, "promptBlockPresent": true, "platformSupported": true }
```

### POST /api/auto-continue-set

请求体：

```json
{ "enabled": true }
```

开启时先写入 app-config，再持久化开关状态；关闭时先停止前端监控，再删除指令块并持久化关闭状态。返回最新状态。

现场确认 WorkBuddy 是否热加载 app-config.json：

- 热加载：不刷新页面。
- 不热加载：调用现有 reloadWorkBuddyPage()，返回 `reloaded: true`。
- reload 后由现有 Page.loadEventFired 流程重新 inject；开关状态从 settings 恢复，已有消息建立 baseline，不得被重新判定。

非 macOS 时接口返回 `platformSupported: false`，不写配置、不启动监控。

## 5. 前端 UI

在现有 `buildEnhancePane()` 中添加同级 `wbs-pcard`，放在“免打扰”卡片之后，复用现有开关和卡片 CSS。

显示内容：

- 卡片标题：`持续会话`
- 开关名称：`会话异常中转`
- 小标题：`检测到回复异常未输出完成标记时，自动发送「继续未完成的任务」`

开启/关闭失败使用现有 toast 或卡片内弱提示，不弹模态框，不阻断 WorkBuddy。

reinject 时必须通过现有 build lifecycle 销毁旧状态，不能叠加卡片、listener、MutationObserver 或 timer。

## 6. 会话识别和切换隔离

### 6.1 会话上下文

每次监控都维护一个不可变上下文对象：

```js
{
  generation: Number,
  sessionRoot: Element,
  sessionKey: String,
  observer: MutationObserver,
  settleTimer: number | null,
  activeMessage: Element | null,
  judgedMessages: WeakSet
}
```

`generation` 每次启动监控、会话切换、页面刷新、reinject 都递增。所有 timer、observer 回调和发送 Promise 开始及结束时都必须检查 generation；不匹配就直接放弃。

### 6.2 当前激活会话

由 agent 用 CDP 实测当前 WorkBuddy DOM，优先使用稳定的语义结构或属性，不把 CSS module hash 作为唯一选择器。候选范围是当前可见的 `.main-content.main-content--chat` / `.chat-container`，并通过 URL、选中会话项或容器身份生成 `sessionKey`。

如果页面发生会话切换：

1. 断开旧 sessionRoot 的 observer。
2. 清除旧 settleTimer。
3. 递增 generation。
4. 清空 activeMessage 和临时状态。
5. 定位新的 sessionRoot 和 sessionKey。
6. 将新会话当前已有助手消息加入 baseline。
7. 只等待之后新出现或开始增长的助手消息。

如果 sessionKey 无法确定，则以 sessionRoot 元素身份作为临时 key；若 sessionRoot 被替换，必须按切换处理。无法定位 sessionRoot 时停止监控，绝不全页面扫描发送。

### 6.3 baseline

监控启动或切换到新会话时，收集当前会话中已有的助手消息内容容器，放入 `baselineMessages`。baseline 中的消息即使之后发生 widget 延迟渲染，也不能触发 Auto-Continue，因为需求只处理开关开启后新出现的回复。

## 7. 助手消息和正文识别

由 agent 用 CDP 确认当前实际类名和结构。实现不得依赖单个 hash 类名，使用以下语义策略：

1. 在当前 sessionRoot 内定位助手消息行或带助手标识的消息容器。
2. 定位其中的 `_assistantMessageContent` 等效内容容器。
3. 遍历内容容器的直接子元素。
4. 排除 class 或祖先标识含 `_widget`、`widgetRenderer` 的块。
5. 取最后一个非 widget 子块作为正文块。
6. 若没有直接子块，使用最后一个含文本节点的降级节点。

绝不能使用整条助手消息的 `textContent` 判断标记，因为 widget 会在正文后异步渲染。

## 8. 监控状态机

状态：`IDLE`、`WATCHING`、`SETTLING`、`TRIGGERING`、`JUDGED`。

固定常量：

```js
const AUTO_CONTINUE_SETTLE_MS = 3000;
const AUTO_CONTINUE_RETRY_DELAY_MS = 300;
const AUTO_CONTINUE_MAX_SEND_ATTEMPTS = 2;
```

流程：

1. `IDLE`：发现非 baseline 的新助手消息或其文本首次增长，记录为 `activeMessage`，进入 `WATCHING`。
2. `WATCHING`：监听当前消息容器的正文和 widget 变化，每次 mutation 更新 `lastMutationAt`，进入 `SETTLING` 并重置 3 秒 timer。
3. timer 到期：确认当前 generation、sessionRoot、activeMessage 都仍有效，并再次确认 3 秒内无 mutation。
4. 正文块末尾有完成标记：加入 `judgedMessages`，回到 `IDLE`。
5. 没有完成标记：先加入 `judgedMessages`，进入 `TRIGGERING`，发送固定文案；发送流程结束后回到 `IDLE`。
6. 任何旧 generation 的回调都不得改变状态机或触发发送。

同一条消息只允许一次 `JUDGED`。没有次数上限和冷却时间，但自动发送出来的新助手回复必须是新的 DOM 消息，不能复用旧消息的判定记录。

## 9. 完成标记判断

严格标记：`\u200B\u200B\u2060`。

判断正文块：

```js
const text = bodyBlock.textContent.trimEnd();
```

优先判断严格三连标记。为兼容模型变体，严格标记不存在时允许正文以单个 `U+200B`、`U+FEFF`、`U+2060` 或 `U+200D` 结尾。可见的 `\\u200B`、`&#8203;` 等转义/占位文本不算标记。

## 10. 自动发送

发送前必须连续执行以下检查：

- 当前 generation 仍有效。
- 当前 sessionRoot 仍是可见激活会话。
- activeMessage 仍属于当前 sessionRoot。
- 当前输入框可见、可编辑且属于当前 sessionRoot。
- 输入框为空。若检测到用户正在输入，最多等待 2 秒轮询输入框；仍非空则放弃本次发送并显示弱提示，绝不覆盖用户内容。
- 当前没有停止生成按钮或其他明确的 WorkBuddy 忙碌状态。

输入框写入：

- `textarea/input)：使用对应原型的 native value setter，派发冒泡 `input` 和 `change` 事件。
- `contenteditable` / Slate：聚焦后选中编辑区内容，使用编辑器可接受的原生插入方式，派发 `InputEvent`；不得直接改 React 内部状态。

发送：

1. 等待约 100ms 让官方按钮状态同步。
2. 重新定位并点击当前会话最右侧官方发送按钮。
3. 按钮不存在或点击失败时，重新定位 composer 并派发普通 Enter 作为兜底。
4. 失败后 300ms 重试一次，每次都重新做会话和 generation 校验。
5. 两次失败后显示卡片内弱提示，不抛窗、不循环重试。

## 11. 关闭、刷新和异常恢复

关闭开关时立即：

1. 停止监控。
2. 断开 observer。
3. 清理所有 timer。
4. 递增 generation，使旧回调失效。
5. 删除 app-config 中自己的指令块。
6. 保留 `wbs.autoContinue.enabled: false`。

页面刷新或 reinject 时：

- 旧 observer 和 timer 必须被 lifecycle disposer 清理。
- 新 build 重新读取开关状态。
- 开关开启时校验指令块，不存在则通过 daemon 补写。
- 当前已有助手消息重新建立 baseline，不得因页面恢复而触发继续。

## 12. 测试要求

新增 `test/auto-continue.test.js`，沿用 `test/no-disturb.test.js` 的同源复制逻辑模式，至少覆盖：

- 指令块追加、删除、重复开启、多块清理。
- 用户原有 customPrompt 保留。
- 严格标记、兼容单字符标记、可见转义文本。
- 正文块与 widget 块分离。
- 3 秒静默后完成/异常两条路径。
- 同一消息只触发一次。
- 会话切换后旧 timer/observer 回调不发送。
- 页面刷新/reinject 后 baseline 消息不发送。
- 用户正在输入时不覆盖内容。
- 第一次发送失败后最多重试一次。
- Windows 不展示和不注册功能。

验证命令：

```bash
node --check scripts/daemon.js
node --check scripts/inject.js
node --test test/*.test.js
git diff --check
```

## 13. CDP 现场确认

实现前必须由 agent 在运行中的 WorkBuddy 中确认：

- A：app-config 写入后是否热加载；不热加载时调用 Page.reload。
- B：当前助手消息、正文块、widget 块的实际稳定选择器。
- C：当前 composer 类型、React/Slate 输入事件方式、发送按钮定位方式。
- D：会话切换时可用的 URL、选中项或容器身份信号。

现场确认只用于适配当前 WorkBuddy DOM，不得改变本文档的行为规则：只处理激活会话、3 秒静默、正文标记判定、单消息去重和旧 generation 隔离。

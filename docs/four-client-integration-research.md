# 四客户端集成探测任务

## 目的

WorkDaddy 后续计划支持四个客户端，先由 WorkBuddy agent 做本机只读探测，确认各客户端的真实路径、运行方式、数据格式、接口和页面元素。此次任务只产出事实和证据，不修改 WorkBuddy/CodeBuddy 的安装文件、`app.asar`、登录文件或会话数据，也不实现 WorkDaddy 代码。

## 目标客户端

macOS 当前安装目标如下：

| profile | 客户端 | 当前路径 | 备注 |
| --- | --- | --- | --- |
| `workbuddy-cn` | WorkBuddy 国内版 | `/Applications/WorkBuddy.app` | 支持主题功能 |
| `workbuddy-ai` | WorkBuddy AI 国际版 | `/Applications/WorkBuddy AI.app` | 暂存提示词开放 |
| `codebuddy-cn` | CodeBuddy CN | `/Applications/CodeBuddy CN.app` | 支持 Agents/编辑器模式切换 |
| `codebuddy-intl` | CodeBuddy 国际版 | `/Applications/CodeBuddy.app` | 支持 Agents/编辑器模式切换 |

Windows 路径、进程名和安装方式不要猜测，请从正在运行的进程、快捷方式、注册表或安装目录中记录真实值。

CodeBuddy 的 Agents 模式和编辑器模式属于同一个客户端的两个运行界面，必须分别探测；不要把它们当作两个独立产品 profile。

## 探测顺序

### 1. 客户端身份与进程

对每个 profile 记录：

- 应用版本、构建号、bundle/app/exe 路径；
- 主进程和 renderer 进程名；
- 应用启动参数，特别是是否已有 `--remote-debugging-port`；
- 窗口标题、窗口数量，以及主窗口和辅助窗口如何区分；
- 当前是否能通过 CDP 连接，CDP 端口如何发现；
- `GET /json/version` 和 `GET /json/list` 的脱敏结果：`Browser`、`webSocketDebuggerUrl` 是否存在、target 的 `type/title/url`。

需要确认：四端能否同时运行、是否共用端口、是否会复用已有 Electron 进程。不能用“最近修改的登录文件”推断当前连接的客户端。

### 2. 登录信息文件

在不输出 token、cookie、密钥和完整认证内容的前提下，记录每端：

- 登录文件的绝对路径和文件名；
- 文件是否存在、权限、顶层 JSON key；
- `account`、`accounts`、`allAccounts` 的存在情况、数组/对象类型和字段名；
- `uid`、昵称、域名字段的类型和示例格式（值需要脱敏）；
- 认证文件是否包含 `auth.domain`，国内版和国际版的域名分别是什么；
- 登录、刷新 token 或切换账号时文件是否会被重写，mtime 是否变化。

只展示字段名、类型、长度和脱敏后的短样例，例如 `uid: "***1234"`。禁止把整个 `.info` 文件复制到报告或日志。

### 3. 用户数据、Space 和对话

对 WorkBuddy CN、WorkBuddy AI、CodeBuddy CN、CodeBuddy 国际版分别确认：

- 用户数据根目录；
- 会话数据库/JSON/JSONL/目录的真实路径；
- 数据库类型、文件名、表名、列名和主键类型；
- Space（空间）与 conversation（对话）的关系、ID 字段和时间字段；
- 一次已有 Space 和一次已有对话是否能读到；
- 消息正文、附件、workspace、任务和文件历史分别存在哪里；
- 删除、复制或迁移一条会话需要涉及哪些关联文件。

当前已知 WorkBuddy AI 有 `~/.workbuddy-ai/models.json`，并且已经存在一个 Space 和一个对话。必须明确报告这两项是否查到，以及它们的 ID 和名称是否能与界面对应。正文和路径中的私人信息需要脱敏。

请比较四端格式，而不是只报告“能读取”。输出一张兼容性表，逐项标记 `相同`、`字段不同`、`存储不同` 或 `未确认`。

### 4. 模型配置

记录每端模型配置的路径和格式：

- `models.json` 或等价文件的绝对路径；
- 顶层结构、模型列表字段、当前模型字段；
- 模型 ID、名称、provider、endpoint、API key 字段的类型；
- 官方模型和本地模型是否使用不同结构；
- CodeBuddy 是否使用 VS Code `globalStorage`、SQLite 或其他存储。

API key 只能报告是否存在、长度和脱敏形式，禁止输出明文。

### 5. 接口与网络请求

优先通过 CDP Network 事件、应用已有请求或静态资源观察接口，不要为了探测而执行签到、切换账号、退出登录等有副作用操作。

按客户端和功能记录：

| 功能 | 需要记录 |
| --- | --- |
| OAuth/无感登录 | host、method、path、必要 header 名、请求/响应字段结构 |
| 当前账号 | host、path、响应字段和 uid 对应关系 |
| 积分查询 | host、path、分页/时间字段和响应结构 |
| 每日签到 | host、path、是否幂等、响应码；不要实际调用 |
| Space/会话 | 是否走本地数据库、CDP RPC 或 HTTP |
| 模型列表 | 本地读取还是网络请求 |

域名、路径和 header 名可以记录；所有 Authorization、cookie、refresh token、API key 和响应中的隐私字段必须删除或替换为 `<redacted>`。如果四端实际共用接口，只记录证据，不要先下结论。

### 6. 页面元素与模式

分别在 WorkBuddy 的主界面、欢迎页和 WorkBuddy AI 界面，以及 CodeBuddy 的 Agents 模式、编辑器模式中记录：

- 输入框类型：`textarea`、`contenteditable`、iframe 或其他；
- 稳定的 selector、`data-*` 属性、aria-label、role 和可见文本；
- 发送按钮、附件按钮、模型选择器、Space/会话入口；
- 页面主题标记和深色主题 selector；
- 元素是否在 shadow DOM 或 iframe 中；
- 窗口尺寸变化、输入框不存在或页面切换时的可用锚点。

机器人按钮的定位要求：

1. 能可靠找到编辑框时，展示在编辑框附近；
2. 找不到编辑框时，固定展示在当前窗口右下角；
3. 不要依赖易变的 React class 或纯文本序号；
4. 记录窄窗口和 Agents/编辑器切换后的实际 DOM 差异。

需要给出每个模式至少一个推荐锚点、一个备用锚点和失效条件。可以截图，但截图中的账号、对话正文、邮箱和路径要打码。

## WorkDaddy 功能开关初始约束

探测结果需要能支持以下能力矩阵：

| 功能 | WorkBuddy CN | WorkBuddy AI | CodeBuddy CN | CodeBuddy 国际版 |
| --- | --- | --- | --- | --- |
| 账号备份/切换 | 待确认 | 待确认 | 待确认 | 待确认 |
| Space/会话读取 | 待确认 | 待确认 | 待确认 | 待确认 |
| 暂存提示词 | 开放 | 开放 | 暂不开放 | 暂不开放 |
| 主题 | 开放 | 暂不开放 | 暂不开放 | 暂不开放 |
| 机器人按钮 | 开放 | 开放 | 开放 | 开放 |
| 积分/签到 | 待确认接口是否共用 | 待确认接口是否共用 | 待确认接口是否共用 | 待确认接口是否共用 |

这里的“开放”只表示产品目标，不代表探测已经证明可用。不能确认的项必须标为 `未确认`，并写出下一步验证方式。

## 报告交付格式

请在报告中按以下顺序输出：

1. 探测时间、系统版本、应用版本；
2. 四个 profile 的身份/路径/进程/CDP 表；
3. 登录文件格式比较表；
4. 用户数据、Space、会话和模型路径比较表；
5. API host/path/method/字段表；
6. 四端两个 CodeBuddy 模式的 DOM selector 表；
7. 能力矩阵和已知风险；
8. 仍需人工确认的事项，以及每项的置信度。

最终报告不得包含任何 token、cookie、密钥、完整认证 JSON、完整消息正文或未脱敏截图。优先给出可复现的路径、字段名、selector 和证据来源。

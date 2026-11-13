# ego-publish（ego 发稿）

在 **ego lite** 浏览器上做自媒体自动化发布的 DSH 插件。设计对齐已安装的 `media-publish`（自媒体发稿）插件：
账号隔离、登录态持久化、共享代理池按账号分配、可回放的发布流程，外加一个直接跑自动化脚本的逃生舱。

## 为什么是"每个账号一个 ego 实例"

ego lite 是 Chromium 分支。它自带的 `ego-browser` CLI 只连当前那一个浏览器实例；`profiles()` 只读、不能创建资料。
如果所有账号共用同一个 ego 实例，就**无法做到每个账号独立出口 IP**——Chromium 的 `--proxy-server` 是进程级参数，
不是标签页/资料级参数。

因此本插件为每个账号启动一个**独立的 ego lite 进程**：

| 隔离维度 | 实现 |
| --- | --- |
| Cookie / localStorage / 登录态 | 独立 `--user-data-dir=<dataDir>/profiles/<code>`，跨重启保留 |
| 网络出口 | 共享代理池（`proxies.json`）+ 每账号 `proxyId`；独立 `--proxy-server`；带账号密码的代理由插件在本机起一个 loopback 中继补 `Proxy-Authorization` |
| 页面 / 标签页 | 独立进程、独立 CDP 连接；不碰用户日常使用的 ego 窗口 |
| 自动化 | CDP（Chrome DevTools Protocol）直连，语义快照/点击/填表/上传/截图全部可用 |

启动时会在新资料目录写 `ego_config.json`（`{"not_first_run": true}`），跳过 ego 的一次性引导，所以账号资料
完全由插件创建。

## 两种浏览器后端（`config.engine`）

| 后端 | 启动方式 | 隔离能力 |
| --- | --- | --- |
| `ego`（默认） | 自己 `spawn` ego.exe，加 `--user-data-dir` / `--proxy-server` / `--lang` / `--window-size`，再用自写 CDP 客户端接管 | 存储、出口 IP、窗口尺寸。**没有**按账号的 UA / 时区 / 视口 / GPU 覆盖 |
| `playwright` | `chromium.launchPersistentContext(profileDir, { executablePath: ego.exe, proxy, userAgent, timezoneId, locale, viewport, deviceScaleFactor })`，再用 Playwright 的 CDP 会话喂给同一套 `TargetSession` | 在 `ego` 的全部能力之上，增加**按账号派生的指纹**（视口/DPR/核心数/内存/GPU 字符串/canvas 噪声）与 `--disable-blink-features=AutomationControlled` |

两个后端共用同一个 `TargetSession`（页面语义、`__ego` 助手、flows、工具面完全不变）——差别只在传输层。
切换只需要改 `config.engine`，回滚同样只改这一项。

指纹由 `src/fingerprint.js` 按 `HMAC(code)` 派生，同一账号永远得到同一份指纹。两条刻意的取舍：

- **时区不做多样性维度。** 中国大陆只有一个时区，且 `Asia/Chongqing`、`Asia/Harbin`、`Asia/Hong_Kong`
  都是 `Asia/Shanghai` 的 IANA 别名，`Intl` 会把它们规范化回同一个值。所有账号统一报 `Asia/Shanghai`，
  与国内出口 IP 自洽。
- **UA 默认保持真实**（`uaMode: 'real'`）。Chromium 的 `sec-ch-ua`、`sec-ch-ua-platform`、
  `navigator.userAgentData` 都由真实二进制推导，只改 UA 字符串会造出三个互相矛盾的面，比共用 UA 更容易被识别。
  多样性放在视口、DPR、核心数、内存、GPU 字符串与 canvas 噪声上。

`playwright` 后端仍以 ego 的 `ego.exe` 作为浏览器二进制，因此现有 `profiles/<code>` 目录**原样可用、无需重新登录**；
这也避开了"Playwright 自带 chromium 版本更旧、拒绝打开新版本资料目录"的问题。

### 彻底不用 ego（`config.browserPath`）

`browserPath` 覆盖实际运行的 Chromium 二进制，默认回落到 `egoPath`。指向本机安装的真 Chrome 即可完全脱离 ego：

```json
{ "engine": "playwright", "browserPath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
```

前提是 **Chrome 的主版本与资料目录一致**（本机 Chrome 156.0.8078.74 与 `profiles/*` 的 `profileVersion` 相同，
故直接复用、不掉登录态）。版本不一致时 Chromium 会拒绝打开"来自更新版本"的资料目录，此时要么升级 Chrome，
要么让该账号重新登录一次。

为什么值得换成真 Chrome（实测对比）：

| | Playwright 自带 chromium（有头） | Playwright 自带（无头 shell） | 真 Chrome | ego.exe |
| --- | --- | --- | --- | --- |
| `navigator.userAgent` | `Chrome/156.0.0.0` | **`HeadlessChrome/156`** | `Chrome/156.0.0.0` | `Chrome/156.0.0.0` |
| `userAgentData.brands` | 只有 `Chromium` | **含 `HeadlessChrome`** | **含 `Google Chrome`** | 含 `Google Chrome` |
| `navigator.webdriver` | false | **true** | false | false |

自带 chromium 缺 `Google Chrome` 品牌、无头 shell 还直接自报 `HeadlessChrome` 且 `webdriver=true`——这两个都是
一眼可见的自动化特征。真 Chrome 在这一点上最自然，也顺便把 ego 从运行时里彻底移除。

## 安装

```sh
# 方式一：插件页 → 添加插件 → 选择本目录
# 方式二：命令行
dsh plugin --profile desktop add /absolute/path/to/ego-publish
```

安装后调用 `egolite_status` 自检：会报告 ego lite 可执行文件、数据目录、账号、已打开的浏览器与可用发布流程。

## 页面入口（Web UI）

插件注册了 **左侧导航栏** 与 **设置** 两套入口，指向同一个页面：

| 位置 | 说明 |
| --- | --- |
| 左侧导航栏 → **ego 发稿** 图标 | 一级面板；点击在中间区域打开完整配置页 |
| 左侧导航栏 → **更多** 菜单 → **ego 发稿** | 同一个面板的菜单项（可在此固定/取消固定） |
| 设置 → **ego 发稿** | 设置面板里的一级页面 |
| 设置 → 插件 → **ego 发稿** | 插件分区里的标签页 |
| 设置 → 插件 → 已安装 → ego-publish 行 → **配置** | 插件行上的配置入口 |
| 设置 → 插件 → 已安装 → ego-publish 包详情 | 包页面里的同款表单 |

页面内容（五个标签页）：

- **账号**：卡片式列表，头像缩写 + 代号 + 平台徽标 + 登录态徽标 + 登录名/代理编号/资料状态；
  行内 **登录**（打开该账号自己的 ego 窗口扫码，随后点「检查」确认）、**检查**、**打开**、
  **编辑**、**删除**；编辑弹层里另有「删除账号并退出登录」，会一并删掉浏览器资料。
  **代理编号**直接显示 `p-1` 这样的池内编号，未分配时显示「未代理」（分配在编辑弹窗里做）。
  **积分徽标**：显示搜狐号「总积分」与走势（`45 →` / `45 ↑` / `45 ↓`），点击立即重新读取；
  积分持续走低时页面顶部出现黄色警告，提示暂停广告/营销类内容。
  **新增 / 编辑账号走弹窗引导**：遮罩对话框里分「账号信息 / 网络」两段，必填项标 `*`；
  编辑已有账号时额外显示 **积分详情**（总积分、近30日、趋势、更新时间、五项构成、最近历史）与「刷新积分」，
  底部给出「保存后登录 → 检查」的下一步提示；支持 Esc / 点遮罩 / 右上角关闭。
- **代理**：**代理池**。新增一次（名称 / 服务器 / 用户名 / 密码），即可分配给任意账号，
  同一代理可被多个账号共用；每条可 **测试**（显示真实出口 IP 与延迟）、**编辑**、**删除**，
  并列出正在使用它的账号。删除时使用它的账号自动回退为直连。
- **插件设置**：按「发布行为 / 浏览器」分组，`egoPath`、无头窗口、必须显式发布、空闲关闭、
  登录等待、单动作与导航超时、**积分刷新间隔**；每项标注来源（默认值 / 插件配置 / 本页保存 / 环境变量），可恢复默认。
- **发布流程**：内置与用户流程的 ID、平台、步数。
- **运行窗口**：每个账号一个隔离窗口，可查看 URL、出口（直连/代理）、**连接状态徽标**与 PID，并可关闭。
  徽标：绿色「已连接 · 85ms」、红色「连接失败」、灰色「未检测」；点徽标可立即重新检测，
  代理窗口检测的是“经该代理”的实际连通性。进入该标签时会自动补测没有结果的窗口。

页面顶部有 ego lite 状态、版本、数据目录与四项统计；样式全部使用 `--dsw-alias-*` 主题令牌，
跟随 Harness 的浅色/深色主题。页面通过宿主半注册的同源 HTTP 路由 `/ego-publish/*` 读写
（见 [SPEC.md](docs/SPEC.md) §10），代理密码写入后不再回显；写请求要求
`content-type: application/json` 并有体积上限。

> **升级后需要重启一次 Harness**：宿主半（工具与 HTTP 路由）会热加载，但客户端的
> `dsh.client` 模块图在进程启动时扫描并缓存，所以新 UI 需要重启（或重新打开桌面端）后生效。

## 积分监控（搜狐号）

- **不再定时轮询**：`pointsRefreshMinutes` 默认 `0`（关闭）。积分只在**发稿后**更新。
- **发稿后延迟检查**：真实发布成功后，插件按 `linkCheckDelayMinutes`（默认 60 分钟）排一次检查；
  到点后在该账号浏览器里开后台标签页打开链接，确认不是 404/已删除；**链接有效后**才读取积分。
  链接还没生效就每隔一个延迟再试，最多 6 次；控制台/预览链接（`mp.sohu.com/...`）无法验证公开状态，
  会直接采样积分。检查记录持久化在 `checks.json`，Harness 重启后会重新挂起。
- 读取方式：在账号自己的 ego 浏览器里开一个**后台标签页**访问用户中心积分页
  （`/mpfe/v4/personalCenter/integral`），读完即关；已有窗口不打扰，没有窗口时临时开无头浏览器、读完关闭。
- 解析：积分数字是图标字体（`mp-iconnumber_4`），按 class 还原为数字；同时记录近 30 日积分和
  内容质量 / 分享传播 / 互动评论 / 任务奖励 / 违规行为五项构成。
- 历史：`accounts.json` 里每个账号保留最近 50 个样本；页面按最近 2~3 个样本给出
  `down / flat / up / unknown`。连续三个样本不升且有下降 → 仍判为 `down`。
- 用途：积分走低通常意味着违规或质量扣分；页面顶部会提示暂停广告/营销类内容，
  `egolite_account {op:"points"}` 也会在 `nextSteps` 里给出同样建议。
- 手动刷新：账号列表的积分徽标、编辑弹窗里的「刷新积分」都可立即读取一次。

## 数据目录

默认 `%USERPROFILE%\.dsh\ego-publish`（可用 patch 的 `config.dataDir` 或环境变量 `EGO_PUBLISH_DATA_DIR` 改）：

```
config.json              插件配置（egolite_config 写入）
accounts.json            账号注册表（proxyId 指向代理池；points 含积分历史；兼容旧的内联 proxy）
checks.json              发稿后检查队列（到点验链接、验通过后刷新积分）
proxies.json             代理池（服务器/用户名/密码只在本机，密码永不回显）
profiles/<code>/         该账号的 ego 浏览器资料（Cookie/登录态）
flows/<id>.json         用户发布流程（覆盖同名内置流程）
runs/<时间>-<流程>-<账号>/  每次发布的 run.json + 步骤截图
screenshots/             observe / act / script 的截图
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `egolite_status` | 自检：ego 可执行文件、配置、账号、会话、流程、下一步。不启动浏览器 |
| `egolite_account` | `list / upsert / remove / login / check / points`。`login` 打开该账号自己的 ego 窗口，等待人工扫码/输密码，然后记账；`points` 读取搜狐号积分并记一条历史 |
| `egolite_proxy` | `list / add / update / remove / assign / test`（另有兼容的 `set / clear`）。代理池增删改 + 分配给账号；`test` 用 CONNECT 探测真实出口 IP |
| `egolite_session` | `open / close / list / status`。账号浏览器窗口的打开/复用/关闭 |
| `egolite_observe` | 读页面：URL、标题、正文、可见可交互元素（ref + CSS 选择器）、截图 |
| `egolite_act` | 单个动作：`goto/back/reload/click/fill/type/press/select/upload/scroll/waitFor/eval/screenshot`，目标用 `ref` / `selector` / `text`，支持 `frame` |
| `egolite_script` | 在账号浏览器里跑一段 JS 自动化脚本（`goto/click/fill/type/waitFor/eval/screenshot...` 作为局部函数） |
| `egolite_flow` | `list / show / save / remove`，查看/覆盖发布流程 |
| `egolite_publish` | 用指定账号回放发布流程；**默认 dry run**，`dryRun:false` 才真正提交 |
| `egolite_config` | `get / set / reset` 插件配置 |

### 典型调用顺序

```text
egolite_status {}
egolite_proxy   {op:"add", label:"HK-01", server:"http://user:pass@host:port"}   # → p-1
egolite_proxy   {op:"test", id:"p-1"}             # 确认出口 IP
egolite_account {op:"upsert", code:"a-1", media:"sohu", account:"<登录名>", proxyId:"p-1"}
egolite_account {op:"login", code:"a-1"}          # 人工在 ego 窗口扫码
egolite_account {op:"check", code:"a-1"}
egolite_publish {accountCode:"a-1", media:"sohu", params:{title:"...", body:"..."}}      # dry run
egolite_publish {accountCode:"a-1", media:"sohu", params:{...}, dryRun:false}              # 真发
```

也可以先建账号再分配：`egolite_proxy {op:"assign", code:"a-1", id:"p-1"}`；
切回直连：`egolite_proxy {op:"assign", code:"a-1", id:null}`。同一 `id` 可以分配给多个账号。

## 发布流程（flows）

流程是一个 JSON 步骤数组，`{{param}}` 占位符由 `params` 填充。内置：

- `sohu__publish-article` — 搜狐号：进后台 → 发布内容 → 标题/正文 → 创作声明（含选中校验）→ 提交
- `csdn__publish-article` — CSDN：CKEditor4 iframe 内逐字键入 → 「共 N 字」校验 → 标签 → 发布
- `toutiao__publish-article` — 头条号基础版：标题/正文 → 关 AI 抽屉 → 封面单图（可选）→ 预览并发布 → 确认发布

步骤字段：

```json
{ "action": "click", "selector": "button.publish", "submit": true, "timeoutMs": 15000 }
{ "action": "fill",  "selector": "input[placeholder*='标题']", "value": "{{title}}" }
{ "action": "type",  "frame": "iframe.cke_wysiwyg_frame", "selector": "body", "text": "{{body}}" }
{ "action": "waitFor", "urlContains": "creation/success", "timeoutMs": 60000 }
{ "action": "eval", "expression": "(() => { ... })()" }
{ "action": "extract", "name": "publishedUrl", "url": true }
```

- `submit:true` 标记真正提交的那一步；dry run 会跳过它并截图，绝不误发。
- `optional:true` 的步骤失败不中断。
- 站点改版时：`egolite_flow {op:"save", spec:{...}, overwrite:true}` 覆盖同名流程即可，不用重装插件。
- 内置流程来自既有的 `media-publish` recipe（选择器带「待实机验证」标记的历史继承），第一次用建议先 dry run 看截图。

## 发布安全

- `egolite_publish` 的 `dryRun` 默认 `true`；只有显式 `dryRun:false` 才会点提交。
- 发布前会做登录态预检（流程里的 `loginCheck`），未登录直接 `LOGIN_REQUIRED`，不会把内容敲进登录页。
- 每次运行写 `runDir/run.json` 与截图，作为证据与排障入口。
- 账号密码/代理密码不会出现在任何工具返回值里（`hasPassword` 代替）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `egoPath` | 自动探测 | `ego.exe` 完整路径；探测顺序：配置 → `EGO_EXE` → Program Files → LocalAppData → `ego-browser.exe` 同级 |
| `requireExplicitPublish` | `true` | `true` 时省略 `dryRun` 一律按 dry run；设为 `false` 后省略 `dryRun` 会真发 |
| `idleCloseMinutes` | `30` | 账号浏览器空闲多久自动关闭；`0` 关闭自动回收 |
| `loginTimeoutSec` | `300` | 登录等待人工的上限（单次调用上限 600 秒） |
| `actionTimeoutMs` | `15000` | 单个页面动作上限 |
| `navigationTimeoutMs` | `60000` | 导航上限 |
| `headless` | `false` | 账号浏览器默认有头；登录必须可见 |

`dataDir` 决定 `config.json` 自己的位置，只能通过 bundle patch / 环境变量设置。

## 目录结构

```
src/
  index.js        注册工具、生命周期（空闲回收、卸载关闭所有账号浏览器）
  config.js       分层配置（默认 → patch → config.json → 环境变量）
  ego.js          定位 ego.exe / 读版本
  accounts.js     账号注册表 + 平台默认登录页
  browser.js      每账号一个 ego 进程（user-data-dir + proxy + CDP）
  cdp.js          CDP 客户端与页面门面（快照/点击/填表/按键/上传/截图/iframe）
  proxy.js        代理解析、认证中继、出口 IP 探测
  flows.js        流程校验、模板替换、步骤执行（dry run / submit 保护）
  tools/          10 个 egolite_* 工具
flows/            内置发布流程
tests/            smoke / isolation 端到端测试
```

## 测试

使用 DSH 自带 Node（与桌面宿主同一个运行时）运行：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\deepseek\DeepSeek Harness.exe" "...\ego-publish\tests\smoke.mjs"
& "D:\deepseek\DeepSeek Harness.exe" "...\ego-publish\tests\isolation.mjs"
```

`EGO_SMOKE_KEEP=1` 可让 smoke 测试保留浏览器窗口便于观察。

已验证（Electron 44.7.0 / Node 24.21.0，ego lite 0.6.1.13 / Chrome 156）：

- `tests/smoke.mjs` — 23/23：工具注册、ego 定位、状态、配置读写、代理列表、流程列表/详情、
  账号 upsert、启动真实 ego 浏览器、session status/list、导航、observe、eval、真实鼠标点击、
  contenteditable 多行填充、script、流程保存、dry-run 停在 submit、关闭。
- `tests/isolation.mjs` — 9/9：A 账号走自己的代理、B 账号直连、Cookie 按账号隔离、
  Cookie 跨浏览器重启保留、认证代理出口 IP 探测、中继补 `Proxy-Authorization`、
  浏览器真实走认证中继、非法代理被拒。
- `tests/checks-check.mjs` — 6/6：发稿检查的排期、持久化、重启重挂。
- `tests/http-check.mjs` — 21/21：设置页路由的读写、代理池增删改/分配/回退直连、积分趋势判定、密码脱敏、非法代理拒绝、content-type 守卫、
  `dataDir` 运行时拒绝。
- `tests/client-check.mjs` — 19/19：client bundle 形态、六个座位（含 `sidebar.panellist`/`main`）、
  locale 字典、仅主题令牌样式、页面渲染（账号/代理池/标签/统计/账号弹窗/连通性徽标）。
- `tests/live-proxy-check.mjs` — 15/15（对运行中的 Harness）：代理池新增 → 分配给 A → A 的请求走代理出口、
  B 直连、两个 `--user-data-dir` 独立、只有 A 带 `--proxy-server`。

## 与 DSH 版本升级的关系

插件分两半，升级影响完全不同：

| 半边 | 依赖的契约 | 升级风险 |
| --- | --- | --- |
| 宿主半（10 个工具 + HTTP 路由） | `apply(ctx, config)`、`ctx.tools.register`、`ctx.inject(['webServer'])`、`webServer.register({kind:'exact'})`、`ctx.on('dispose')`；零 DSH 包导入 | **低**。这些是 Cordis/DSH 核心契约，0.1.x → 0.2.1 未变；工具 schema 也只在宿主支持的 JSON Schema 子集内 |
| 客户端半（页面/侧栏） | `window.__ModuleLoader__.load`、slot id：`settings.section`、`settings.plugins.tab`、`plugins.row.config`、`plugins.bundle.config`、`sidebar.panellist`、`main` | **中**。UI 座位属于界面契约，minor 升级可能改名或调整 props |

已针对 **DSH 0.2.1-rc.3（Electron 44.7 / Node 24.21.0）** 实测：工具、HTTP 路由、页面注册、
左栏入口、代理隔离全部通过。

升级 DSH 后的自检清单：

1. 重启桌面端/Harness（客户端模块图在启动时扫描）；
2. 跑 `tests/smoke.mjs`、`tests/isolation.mjs`、`tests/http-check.mjs`、`tests/client-check.mjs`；
3. 打开 **设置 → ego 发稿** 与 **左栏 → 更多 → ego 发稿**，确认页面与新 UI 正常；
4. 若入口消失：多半是 slot id 变了。用 `cordis_inspect_query` 的 `Slots.listSubTree` 查当前座位名，
   改 `lib/client.js` 里 `seats` / `sidebar.panellist` 的注册即可；工具与 HTTP 路由不受影响。

每个座位都单独 `guarded(...)`：某个座位在新版本里不存在时，只丢那一个入口，不会让整个插件激活失败。
插件没有任何 `engines.dsh` 硬约束，所以升级不会因为版本门槛被拒绝安装——但这同时意味着
**升级后要自己跑一遍上面 4 步**。对稳定性要求高时，建议锁定桌面端版本。

## 已知边界

- **跨域 iframe** 内的元素无法用 `selector` 触达（同源 iframe 支持，CSDN 的 CKEditor4 属于同源）。跨域编辑器用 `eval` 走 `postMessage` 或改用坐标点击。
- **头条号内置流程是基础版**：图库选图、三图封面等步骤没有移植（原 recipe 里的工具条第 11 个按钮、随机选图不适合稳定回放）。需要配图时用 `egolite_script` 或覆盖 flow 补步骤。
- ego lite 升级可能改变内嵌 Chromium 的 CDP 行为；`egolite_status` 会报告实际浏览器版本，升级后建议先跑 `tests/smoke.mjs`。
- 账号浏览器是独立进程，会额外占用内存（与 ego lite 本体相近）。默认 30 分钟空闲回收。

## 许可

MIT。`src/tool-kit.js` 为对齐 DSH 工具注册契约而重写的小工具，逻辑等价于宿主 `defineTool` 的最小子集。

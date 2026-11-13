# ego-publish — 设计说明（SPEC）

## 1. 目标

在已安装的 ego lite 上复刻 `media-publish` 的自媒体发稿能力，但把执行器从 Playwright 换成 ego lite 本身：

1. **账号隔离**：不同平台账号的 Cookie / 登录态互不可见，并且跨进程重启保留。
2. **网络代理**：每个账号有独立出口 IP，可带用户名密码，且不污染其他账号。
3. **自动化发稿**：用指定账号回放发布流程，另有脚本逃生舱；默认 dry run，显式 `dryRun:false` 才提交。

## 2. 关键决策：一个账号一个 ego 进程

ego lite 的公开接口（`ego-browser nodejs` + `taskSpace`）只连当前唯一浏览器实例，`profiles()` 只读。
Chromium 的代理是进程级 `--proxy-server`，无法按 tab/profile 切换。因此：

```
account code ──► dataDir/profiles/<code>   (--user-data-dir，独立 Cookie 罐)
             ──► --proxy-server=<relay|upstream>
             ──► --remote-debugging-port=<free>
             ──► CDP WebSocket ──► Target.createTarget / attachToTarget(flatten)
```

- 新资料目录先写 `<profile>/ego_config.json` = `{"not_first_run": true}`，跳过 ego 首次引导（否则 CLI/CDP 会被
  onboarding 拦截，实测报 "Please complete the onboarding process first"）。
- 每个实例只保留插件创建的一个 page target，启动时关掉 welcome/whats-new 页。
- 插件卸载 / 空闲超时关闭实例；`Browser.close` 干净退出以便 Cookie 落盘。

## 3. 代理

- 无认证：`--proxy-server=<server>` 直通。
- 有认证：插件在 `127.0.0.1:0` 起一个 HTTP 中继，浏览器指向中继；中继在 CONNECT / 绝对 URL 请求上补
  `Proxy-Authorization: Basic ...`。浏览器永远看不到密码。
- `egolite_proxy {op:"test"}`：自己用 CONNECT 建隧道 → TLS → `https://api.ipify.org?format=json`，返回真实出口 IP。
- 代理变更会关闭该账号浏览器，下次调用按新代理重新启动。

## 4. 持久登录

Cookie 存在 `<profile>/Default/Network/Cookies`。`egolite_account {op:"login"}` 打开可见窗口、
跳到平台登录页、每 2 秒轮询「已登录」判据（URL 含登录后路径，或页面出现后台标记文字），命中即记录
`lastLoginAt`；超时返回 `needsHuman` 并保留窗口，人工完成后 `check` 即可。
账号密码不经过模型。

## 5. CDP 页面门面（`src/cdp.js`）

- 连接：`/json/version` → 浏览器 WebSocket；`Target.createTarget` + `attachToTarget{flatten:true}`。
- 求值：`Runtime.evaluate`（`returnByValue`），失败抛 `EVAL_FAILED`。
- 元素定位（注入页面的 `__ego` 助手）：
  - `selector` / 可见文本（精确或包含，优先 interactive、own-text、最小面积）；
  - 遍历同源 iframe（深度 4），支持 `frame` 限定；
  - 返回页面坐标（逐层加 `frameElement` 偏移）、CSS 路径、kind。
- 动作：真实鼠标（`Input.dispatchMouseEvent`）、`Input.insertText`、`Input.dispatchKeyEvent`（常用键位表 +
  修饰键）、`DOM.setFileInputFiles`（上传）、`Page.captureScreenshot`。
- 等待：`waitFor` 支持 selector / text / urlContains / expression，250ms 轮询。

## 6. 流程执行（`src/flows.js`）

- 步骤动作：`goto, waitFor, click, fill, type, press, select, upload, eval, sleep, screenshot, expect,
  extract, scroll`。
- `{{param}}` 在步骤所有字符串字段上替换；`required` 参数缺失抛 `MISSING_PARAM`。
- `submit:true` 是提交保护点：dry run 执行到它之前一步、截图、返回 `submitSkipped:true` 并停止。
- 失败：截图 + `STEP_FAILED{stepIndex, action, runDir}`；`optional:true` 的步骤失败不中断。
- 每次发布 `<dataDir>/runs/<stamp>-<flow>-<account>/run.json`。

## 7. 工具与错误码

| 错误码 | 含义 |
| --- | --- |
| `EGO_NOT_FOUND` | 找不到 ego.exe（配置 `egoPath`） |
| `EGO_START_TIMEOUT` / `EGO_START_FAILED` | ego 进程没起来（附 stderr 尾部） |
| `ACCOUNT_NOT_FOUND` / `INVALID_ACCOUNT_CODE` / `INVALID_MEDIA` | 账号注册表问题 |
| `LOGIN_REQUIRED` | 发布前登录态预检失败（附人工登录指令） |
| `TARGET_NOT_FOUND` / `UNKNOWN_REF` | 元素定位失败 / ref 过期（重新 observe） |
| `WAIT_TIMEOUT` / `LOAD_TIMEOUT` / `NAV_FAILED` | 页面等待/导航失败 |
| `STEP_FAILED` | 流程某一步失败（附 stepIndex、runDir、截图） |
| `FLOW_NOT_FOUND` / `INVALID_FLOW` / `FLOW_EXISTS` | 流程问题 |
| `INVALID_PROXY` / `PROXY_REJECTED` / `PROXY_UNREACHABLE` | 代理配置或连通性 |
| `SCRIPT_TIMEOUT` / `SCRIPT_FAILED` / `SCRIPT_SYNTAX` | `egolite_script` 失败 |

## 8. 生命周期

`apply(ctx, config)`：

1. `resolveBootstrapDataDir`（patch → `EGO_PUBLISH_DATA_DIR` → `~/.dsh/ego-publish`）；
2. `createConfigStore`（默认 → patch → config.json → env）；
3. `resolveEgo`、`AccountStore`、`BrowserManager`；
4. 依次 `register(ctx, deps)` 10 个工具模块；
5. `ctx.on('dispose')` 关闭所有账号浏览器、清定时器、退订配置；
6. 60s 定时器按 `idleCloseMinutes` 回收空闲实例。

`egolite_status` 永不启动浏览器；首次真正启动发生在 `egolite_session open` / `egolite_account login` /
`egolite_publish` / `egolite_script`。

## 9. 页面（Client 半）

`lib/client.js` 是手写的 shipped-bundle 形态：`window.__ModuleLoader__.load({id, factory})`，只 `require("react")`，
无构建步骤。注册六个座位：

| 座位 | 键值 | 位置 |
| --- | --- | --- |
| `sidebar.panellist` | id `ego-publish`，order 20 | 左侧导航栏图标；同时自动出现在「更多」菜单 |
| `main` | key `ego-publish` | 点击后中间区域的完整配置页 |
| `settings.section` | id `ego-publish` | 设置一级页面 |
| `settings.plugins.tab` | id `ego-publish` | 设置 → 插件 标签页 |
| `plugins.row.config` | `@dsh-plugin/ego-publish#ego-publish` | 插件行「配置」 |
| `plugins.bundle.config` | `@dsh-plugin/ego-publish` | 包详情表单 |

关键机制（`ui-sidebar` 的 `syncPanels`）：侧栏的面板列表不是单独注册的，而是从
`sidebar.panellist` 的 `id/order/label` 派生；`ctx.layout.selectPanel(id)` 只要求存在同名 `main` 座位。
因此注册这两处，就同时得到左栏图标、更多菜单行（含固定/取消固定）和全宽页面，不需要再注册一条菜单项。

页面结构：hero（图标/标题/状态/版本/数据目录）+ 四项统计 + 分段标签（账号 / 代理 / 插件设置 /
发布流程 / 运行窗口）。样式全部使用 `--dsw-alias-*` 主题令牌，随深浅色模式切换；文案走 `ctx.locale`。
页面通过同源 HTTP 路由读写，不使用 Remote（profile 安装的 bundle 无法在运行时新增 Remote 命名空间）。

### 9.1 代理池

`src/proxies.js` 维护 `<dataDir>/proxies.json`：`{id:"p-1", label, server, username, password, lastTest}`。
账号记录只存 `proxyId`，启动时 `resolveAccountProxy()` 解析为实际代理；旧版内联 `account.proxy`
仍可解析（无 `proxyId` 或条目被删时回退）。分配/解除、删除条目都会关闭该账号的浏览器，
让下一次启动使用新代理；删除条目时引用它的账号自动回退直连。代理密码只落盘，不出现在任何 HTTP
响应或工具返回值里。

### 9.2 积分监控

`src/points.js` 在账号自己的浏览器里开一个**后台 target**（`Target.createTarget {background:true}`），
访问 `/mpfe/v4/personalCenter/integral`，从 `mp-iconnumber_<字符>` 的 class 还原总积分、近 30 日积分和
五项构成；读完关闭 target。没有已开窗口时临时开无头浏览器并在读完后关闭。
样本写入 `accounts.json` 的 `points.history`（上限 50），`publicAccount()` 用 `pointsTrend()` 计算
`down/flat/up/unknown`；连续三个样本不升且有下降也判 `down`。
`pointsRefreshMinutes` 默认 `0`（关闭轮询）；积分只在发稿检查通过后读取。

### 9.3 发稿后检查（`src/checks.js`）

真实发布成功后，`egolite_publish` 调 `CheckScheduler.schedule()`，按 `linkCheckDelayMinutes`（默认 60）
排一条检查并持久化到 `<dataDir>/checks.json`。到点后：

1. 在账号浏览器后台标签页打开链接，404/不存在判为无效；`mp.sohu.com` 控制台/预览链接不可验证；
2. 无效则每个延迟重试一次，最多 6 次；超时记 `link-timeout`；
3. 有效（或不可验证）才调 `refreshAccountPoints()` 更新积分，记 `done`。

重启时 `rearmAll()` 会重新挂起未完成的检查；`status` 返回最近 10 条 `checks`。

## 10. HTTP 路由（`src/http.js`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/ego-publish/status` | 插件/ego/配置/账号/代理池/会话/流程/最近检查总览 |
| GET | `/ego-publish/accounts` | 账号列表（含解析后的代理）+ 代理池 + 平台选项 |
| POST | `/ego-publish/accounts` | `{op:"upsert"\|"remove"}`；upsert 支持 `proxyId` |
| POST | `/ego-publish/accounts/login` | 打开该账号可见 ego 窗口并跳到登录页，立即返回 `needsHuman` |
| POST | `/ego-publish/accounts/check` | 重开平台首页并判定登录态 |
| POST | `/ego-publish/accounts/points` | `{code}`；读取搜狐号积分并追加一条历史，返回 `points` + 账号行 |
| GET/POST | `/ego-publish/checks` | 发稿后检查队列；POST `{accountCode,url,delayMinutes,runNow}` 可手工排期/立即执行 |
| POST | `/ego-publish/accounts/session` | `{op:"open"\|"close"\|"probe", code}`；`probe` 返回该窗口实际连通性 |
| POST | `/ego-publish/proxy` | 兼容旧调用：`{op:"set"\|"clear"\|"test", code, ...}` |
| GET | `/ego-publish/proxies` | 代理池 + 各账号分配 |
| POST | `/ego-publish/proxies` | `{op:"add"\|"update"\|"remove"\|"assign"\|"test"}` |
| GET/POST | `/ego-publish/config` | 读 / 写插件配置 |
| POST | `/ego-publish/config/reset` | 丢弃本层覆盖 |
| GET | `/ego-publish/flows` | 流程目录 |

安全约束：写请求必须 `content-type: application/json`（跨源 HTML 表单无法发送）、body ≤ 64 KiB、
响应 `no-store`、永不回传代理密码（只有 `hasAuth`）、`dataDir` 拒绝在运行时修改。

## 11. 测试覆盖

- `tests/smoke.mjs`（23 项）：工具注册、ego 解析、状态、配置读写、代理/流程列表、账号、开窗、导航、
  observe、eval、真实鼠标点击、contenteditable 多行填充、script、流程保存、dry-run 停止于 submit、关闭。
- `tests/isolation.mjs`（9 项）：A 走代理、B 直连、Cookie 账号隔离、跨重启保留、认证代理探测、
  中继注入凭据、浏览器真实走认证中继、非法代理拒绝。
- `tests/checks-check.mjs`（6 项）：发稿检查的排期、持久化、重挂。
- `tests/http-check.mjs`（21 项）：设置页路由的读写、代理池增删改/分配/回退直连、积分趋势、
  密码脱敏、非法代理、content-type 守卫、dataDir 拒绝。
- `tests/client-check.mjs`（19 项）：client bundle 形态、六个座位、locale 字典、主题令牌样式、页面渲染、
  账号弹窗、运行窗口连通性徽标、积分徽标与走低警告。
- `tests/live-proxy-check.mjs`（15 项，对运行中的 Harness）：代理池新增 → 分配 → A 走代理、B 直连、
  独立 `--user-data-dir`、只有 A 带 `--proxy-server`。

# media-publish-plugin — 内部契约规范 (v1)

本文件是实现的唯一契约来源。所有模块必须严格遵守下面的目录结构、RPC 协议、recipe 规范与隔离模型。

## 0. 目标与边界

- **目标**：DSH 插件，提供「agent 驱动真实浏览器完成发布 → 录制为 recipe → 后续一键回放」的闭环；
  并按账号隔离浏览器环境、按账号绑定不同代理 IP。
- **复用**：底层浏览器操作复用已调通的 Python + Playwright 经验（`~/.dsh/skills/media-publish-skill`
  三个平台的流程与踩坑记录），不重写选择器经验。
- **不做**：不重写新闻稿生成 / humanizer / xlsx 流水线（那是原 skill 的职责）。本插件只负责
  **浏览器操作、录制、回放、账号隔离、代理绑定**。
- **平台范围（v1）**：搜狐号 `a-1`、头条号 `b-1`、CSDN `c-1`/`c-2`。

## 1. 目录结构

```
media-publish-plugin/
├── package.json                 # DSH/Cordis 插件包（Node 侧）
├── src/                         # Node 侧：Cordis 插件 + 工具
│   ├── index.js                 # 插件入口（default export function(ctx, config)）
│   ├── config.js                # Config schema
│   ├── engine-client.js         # 常驻 Python 引擎的启动/JSON-RPC 客户端
│   ├── tools/                   # 注册到 ctx.tools 的工具
│   └── store.js                 # recipe / 账号 元数据的 Node 侧只读视图
├── engine/                      # Python 侧：浏览器引擎（被 Node 作为子进程常驻）
│   ├── sessiond.py              # 主入口：JSON-RPC loop on stdin/stdout
│   ├── rpc.py                   # 协议编解码、错误码、事件
│   ├── paths.py                 # 数据目录解析
│   ├── config_store.py          # accounts.yaml / proxies.yaml / secrets.yaml 读写
│   ├── fingerprint.py           # 账号 → 稳定指纹（UA/locale/timezone/viewport）
│   ├── proxy_pool.py            # 可配置提取器 + 粘性绑定 + 健康探测
│   ├── browser.py               # launch/context 构建（代理、反检测、storage_state）
│   ├── session.py               # 会话对象：ref 注册表、frame 栈、trace 追加
│   ├── actions.py               # act.* 实现（唯一执行动作的地方）
│   ├── observe.py               # snapshot/screenshot（页面模型）
│   ├── record.py                # trace → recipe 编译
│   ├── play.py                  # recipe → actions 回放（含自愈）
│   └── recipes/                 # 内置 recipe
│       ├── sohu__publish-article.yaml
│       ├── toutiao__publish-article.yaml
│       └── csdn__publish-article.yaml
├── docs/SPEC.md                 # 本文件
└── tests/                       # pytest / 冒烟脚本
```

运行时数据目录（**默认不放在包内**，便于升级与备份）：

```
<MEDIA_DATA_DIR 或 %USERPROFILE%\.dsh\media-publish>/
├── accounts.yaml                # 账号注册表（不含密码）
├── secrets.yaml                 # 代理凭据（必须 gitignore）
├── proxies.yaml                 # 代理池配置
├── accounts/<code>/
│   ├── storage_state.json       # Playwright storage_state（cookie+localStorage）
│   ├── profile/                 # 需要持久 profile 时使用
│   ├── downloads/  shots/  logs/
│   └── proxy.json               # 绑定的代理（只存 server/username，密码在 secrets.yaml）
├── recipes/<media>/<id>.yaml    # 用户录制/覆盖的 recipe（优先于内置）
├── traces/<ts>.jsonl            # 原始操作轨迹
└── runs/<ts>-<recipe>-<code>/   # 每次回放的产物：shots/、run.json、stdout.log
```

## 2. RPC 协议

Node 通过 stdin/stdout 与 `engine/sessiond.py` 通信，**按行分隔 JSON（NDJSON）**。
所有日志/调试输出只能走 stderr，stdout 只允许协议帧。

请求：
```json
{"id": 17, "method": "act.click", "params": {"sessionId": "s1", "target": {"ref": "e12"}}}
```
成功响应：
```json
{"id": 17, "ok": true, "result": {"ms": 312, "step": {"type": "click", "target": {...}}}}
```
失败响应：
```json
{"id": 17, "ok": false, "error": {"code": "TARGET_NOT_FOUND", "message": "...", "details": {...}}}
```
主动事件（无 `id`，可与响应交错，客户端必须忽略不认识的类型）：
```json
{"event": "progress", "data": {"method": "play.run", "index": 3, "type": "type", "status": "running"}}
{"event": "handoff", "data": {"sessionId": "s1", "reason": "captcha", "hint": "请在浏览器中完成验证"}}
```

错误码：`BAD_REQUEST` `UNKNOWN_METHOD` `SESSION_NOT_FOUND` `TARGET_NOT_FOUND` `TIMEOUT`
`NAVIGATION_FAILED` `PROXY_UNAVAILABLE` `LOGIN_REQUIRED` `RECIPE_INVALID` `PARAM_MISSING`
`UNSUPPORTED` `INTERNAL`。

`NAVIGATION_FAILED` 的存在理由：导航失败（尤其被平台**客户端跳转**打断）**不得**冒成 `INTERNAL`。
实测搜狐未登录时 `goto` 被它自己的跳转打断，只报 `INTERNAL: Page.goto: Navigation ... is interrupted
by another navigation`，调用方没有任何可执行的线索；现在会重试一次，仍失败则归类为
`NAVIGATION_FAILED` 并带上 `requestedUrl`/`finalUrl`/`reason`。

### 2.1 方法清单

#### session.*
| 方法 | params | result |
|---|---|---|
| `session.open` | `{accountCode, headless=true, interactive=false, proxyPolicy='sticky'\|'rotate'\|'direct', viewport?, locale?, timezoneId?, userAgent?}` | `{sessionId, accountCode, proxy, storageStatePath, fingerprint}` |
| `session.close` | `{sessionId, saveState=true}` | `{ok, savedStatePath?}` |
| `session.list` | `{}` | `{sessions:[{sessionId, accountCode, url, recording}]}` |
| `session.handoff` | `{sessionId, reason, hint?}` | `{ok, hint}` |
| `session.resume` | `{sessionId}` | `{ok, url}` |
| `session.state` | `{sessionId}` | `{sessionId, url, title, recording, stepCount, proxy}` |
| `session.snapshot` | `{sessionId, maxElements=120, includeText=true}` | 见 §2.2 |
| `session.screenshot` | `{sessionId, fullPage=false, label?}` | `{path, width, height}` |

#### act.*（全部会写入 trace；全部接受 `target`）
`target` 三种写法，优先级 `ref` > `selector` > `text/role`：
```json
{"ref": "e12"}
{"selector": "#btn-publish"}
{"text": "发布", "role": "button", "nth": 0, "exact": false, "within": {"ref": "e5"}}
```

| 方法 | params 额外字段 |
|---|---|
| `act.goto` | `{url, waitUntil='domcontentloaded', timeoutMs=45000}` |
| `act.click` | `{target, timeoutMs=15000, force=false, button='left'}` |
| `act.dispatch` | `{target, event='click'\|'input'\|'change', detail?}` — 派发原生事件流（搜狐 radio 必需） |
| `act.type` | `{target, text, mode='fill'\|'type'\|'insertText', clear=true, delayMs=0}` — `mode=type` 用于 CKEditor4（逐字键盘输入） |
| `act.press` | `{target?, key, times=1}` |
| `act.upload` | `{target, paths:[...]}` |
| `act.select` | `{target, value?\|label?\|index?}` |
| `act.check` | `{target, checked=true}` |
| `act.scroll` | `{deltaY?, target?}` |
| `act.waitFor` | `{for:{selector?\|text?\|urlContains?\|loadState?\|timeoutMs?}, timeoutMs=30000, optional=false}` |
| `act.frame` | `{frame:'main'\|{urlContains?\|name?\|selector?\|index?}}` — 切换后续操作的活动 frame |
| `act.eval` | `{expression, arg?, purpose?}` — 逃生舱；会标记 `recipe.escape_hatches` |
| `act.extract` | `{spec:[{name, from:{selector?\|attr?\|text?\|value?\|url?\|eval?}, all?}]}` |

所有 `act.*` 成功后返回 `{ms, step}`，其中 `step` 就是可以直接进 recipe 的规范化步骤对象。

**`act.extract` 的返回信封（已冻结，实现与消费方都按此对齐）**：提取到的命名值放在
`data` 下的 `values` 字段，即 `{"ms": <int>, "step": {...}, "data": {"values": {"<name>": <value>, ...}}}`。
`all: true` 时该项的值是数组。之所以冻结：录制/回放两侧都靠它取 `publishedUrl`，
信封一旦漂移会静默拿到 `undefined`（实测踩过）。

**`act.eval` 的返回信封（已冻结）**：`data` 为
`{"result": <表达式返回值>, "serializable": <bool>, "purpose": <string|null>, "escapeHatch": true, "ms": <int>}`。
消费方要取表达式的结果就必须读 `data.result`，**不能**写成 `data.result ?? data`——
表达式合法地返回 `null` 时，这种写法会把整个信封当成结果（实测踩过：测试里的取值助手因此误判成「状态泄漏」）。
`escapeHatch: true` 标记该步骤走了逃生舱，`record.save` 的 compile-report 会据此列出 `escape_hatches`，
它们是「平台改版时最先需要人工确认」的步骤。

**记录的接缝（已冻结）**：录制期间分派器必须把动作执行返回的规范化步骤对象
以 `{"kind": "step", "step": {...}, "ms": <int>}` 追加进该会话的轨迹列表
（§6 的 `Session` 上的轨迹字段）。只记「动作摘要」（`kind: "action"`）**不算**步骤，
录制模块会拒绝编译并给出 `traceDiagnostics` 诊断——这是刻意设计的，
不要为了让录制通过而放宽识别，否则「录制→脚本」这条主链路会静默失效（实测踩过）。

> 给 `--selftest` 里「方法表完整性」检查的提示：`§2.1` 既有方法表也有解释性正文，
> 校验必须**只解析方法表行**（`| \`<name>\` |` 这种表格首列）加一节显式的 `act.*` 类型表，
> 不要从正文里抓 `xxx.yyy` 形状的 token——正文里天然会出现模块名、字段路径等非方法标识，
> 抓正文会不断产生假阳性（实测踩过）。

#### record.*
| 方法 | 说明 |
|---|---|
| `record.start` | `{sessionId, recipeId, media}` → `{recording:true, tracePath}` |
| `record.status` | `{sessionId}` → `{recording, stepCount, steps:[{index,type,summary}]}` |
| `record.note` | `{sessionId, text}` → 记为注释步骤（不进 recipe，只进 trace 与日志） |
| `record.undo` | `{sessionId, count=1}` → `{removed}` |
| `record.save` | `{sessionId, recipeId?, media?, label?, params?, session_check?, verify?, account_codes?, overwrite=false}` → `{recipePath, stepCount}` |

#### play.*
| 方法 | params | result |
|---|---|---|
| `play.validate` | `{recipeId\|recipePath}` | `{ok, issues:[{level,code,message,stepIndex?}]}` |
| `play.run` | `{recipeId\|recipePath, accountCode, params:{}, dryRun=false, headless?, stopOnError=true, heal=true, proxyPolicy='sticky'}` | `{ok, publishedUrl?, failedStep?, steps:[{index,type,status,ms,error?}], runDir, artifacts}` |

`dryRun=true` 时：正常打开页面、填表、截图，但**不点击最终提交按钮**（跳过带 `submit: true` 的步骤）。

#### account.* / proxy.*
| 方法 | 说明 |
|---|---|
| `account.list` | `{}` → `{accounts:[{code, media, account, hasState, statePath, proxy:{bound, server, username?, expiresAt?, healthy?}, lastRunAt?}]}` |
| `account.upsert` | `{code, media, account, note?}` |
| `account.remove` | `{code, purgeState=false}` |
| `account.bindProxy` | `{code, proxy: {server, username?, password?}\|null}` — `null` 表示解绑（走直连） |
| `account.login` | `{code, headless=false, timeoutMs=300000}` → 打开有头浏览器等人工扫码，完成后保存 storage_state |
| `account.checkLogin` | `{code}` → `{ok, status:'valid'\|'invalid'\|'unknown', url, detail}` |
| `proxy.fetch` | `{code?, force=false}` → `{server, username?, hasPassword, expiresAt, source:'sticky'\|'api'\|'static', healthy?}` |
| `proxy.test` | `{code?\|proxy?}` → `{ok, ip?, latencyMs?, detail}` |
| `proxy.rotate` | `{code}` → `{ok, server}` |
| `engine.status` | `{}` → `{version, dataDir, sessions, accounts, playwright, chromium}` |

### 2.2 页面模型（snapshot）

这是 agent 录制时的「眼睛」，必须**稳定、紧凑、可回指**：

```json
{
  "sessionId": "s1",
  "url": "https://mp.sohu.com/mpfe/v4/contentManagement/news/publish",
  "title": "搜狐号",
  "activeFrame": "main",
  "frames": [{"path": "main", "url": "..."}, {"path": "f1", "url": "https://.../editor"}],
  "interactive": [
    {"ref": "e12", "tag": "button", "role": "button", "text": "发布",
     "selector": "#btn-publish", "visible": true, "enabled": true,
     "box": [820, 40, 96, 36], "inFrame": "main"}
  ],
  "textSample": ["创作中心", "标题", "..."],
  "alerts": [],
  "screenshot": "C:\\...\\accounts\\a-1\\shots\\20260909-101500-snapshot.png"
}
```

- `ref` 由引擎生成（`e1..eN`），在**下一次 snapshot 之前**保持有效；`act.*` 可用 `ref` 回指。
- 引擎内部保存 `ref → ElementHandle/定位器指纹`，跨 `act.*` 复用；失效时自动回退到按
  `selector` / `text+role` 重新定位（这就是**自愈**的基础）。
- `alerts` 用启发式识别验证码/风控/掉登录：命中页面关键词（`验证`、`captcha`、`安全验证`、
  `扫码登录`、`重新登录`、`异常`）或出现 iframe 标题含 `captcha` 时写入。
- `screenshot` 默认写入该账号的 `shots/`，便于人工核对与 agent 判断。

## 3. recipe 规范

YAML，位于 `recipes/<media>/<id>.yaml`（用户目录优先于内置）。**step 的 `type` 与 RPC 方法名一一对应**，
使「录制轨迹 → recipe」几乎是直译，也让回放逻辑只需一个分发表。

```yaml
recipe_version: 1
id: sohu__publish-article
media: sohu
label: 搜狐号发布图文
account_codes: [a-1]
capabilities:
  editor: quill            # quill | prosemirror | ckeditor4
  cover: false
  free_gallery: true
  daily_limit: 5
session_check:
  url: https://mp.sohu.com/mpfe/v4/contentManagement/news/list
  fail_if_url_contains: [passport, login, sso]
  fail_if_text_contains: [扫码登录, 登录后继续]
params:
  - {name: title, type: string, required: true, max_len: 72}
  - {name: body, type: text, required: true, min_len: 1}
  - {name: declaration, type: enum, values: ["个人观点，仅供参考"], required: false, default: "个人观点，仅供参考"}
steps:
  - {type: goto, url: "https://mp.sohu.com/mpfe/v4/contentManagement/news/publish"}
  - {type: waitFor, for: {selector: "input[placeholder*='标题']"}, timeoutMs: 45000}
  - {type: type, target: {selector: "input[placeholder*='标题']"}, text: "{{title}}"}
  - {type: frame, frame: {urlContains: "editor"}}
  - {type: type, target: {selector: ".ql-editor"}, text: "{{body}}", mode: type}
  - {type: frame, frame: "main"}
  - {type: dispatch, target: {text: "{{declaration}}"}, event: click}
  - {type: click, target: {text: "发布"}, submit: true}
  - {type: waitFor, for: {urlContains: "/contentManagement/news/list"}, timeoutMs: 60000, optional: true}
  - {type: extract, spec: [{name: publishedUrl, from: {url: true}}]}
verify:
  mode: later_backfill            # immediate | later_backfill | none
  list_url: https://mp.sohu.com/mpfe/v4/contentManagement/news/list
  title_match: exact_normalized
  status_regex: "已发布|审核中|发布成功"
  accept_link_contains: ["sohu.com"]
  final_url_template: null
overrides: {}                     # 自愈时写入：{"3.target.selector": "..."}
```

规则：
- 任意字符串字段支持 `{{param}}` 模板替换；`{{env:NAME}}` 读环境变量。
- 步骤可选字段：`optional: true`（失败只告警）、`submit: true`（dryRun 时跳过）、
  `retry: {times, delayMs}`、`timeoutMs`、`note`。
- **`session_check` 必须在「跳转稳定后」取样，这是硬要求。** 三个平台的登录跳转都是
  **客户端**发生的（`domcontentloaded` 之后 SPA 才 push 到 `/auth/page/login` 之类的位置），
  所以只取样一次会读到跳转前的瞬时状态，守卫会**静默漏判**——实测搜狐/头条/CSDN 未登录时
  `session_check` 曾全部误判为通过，等于那道「不把文章敲进登录页」的闸门形同虚设。
  实现约定：先 `wait_for_load_state('networkidle')`（短超时，仅作加速），再在
  `session_check.settleMs`（默认 9000ms）窗口内按 `sampleIntervalMs`（默认 700ms）反复取样，
  **任一时刻命中标记即判定登录态失效**；连续 3 次取样 URL 稳定且无命中才放行。
  `settleMs` 可按平台覆盖。
- `session_check` 的失败标记要照**实际未登录页面**写，不能照想象写。已实测的落地值：
  搜狐未登录时 `first/page` 渲染的是**公开首页**（顶栏「登录」、右侧黄色「登录/注册」按钮，
  页面上并没有「请登录」），故标记含 `登录/注册`；头条跳 `/auth/page/login`（含 `/login`）且
  页面有「扫码登录」；CSDN 页面里出现 `iframe[src*="passport.csdn.net"]`。
  回放时 `run.json` 的 `sessionCheck.checks[].samples` 会留下取样证据，便于事后判断守卫看到了什么。
- 回放遇到失败：先按 `target` 降级重试（selector → text/role → ref 重算），仍失败则
  抛 `TARGET_NOT_FOUND` 并把候选元素列表放进 `error.details.candidates`，供 agent 修正。
- 自愈成功后把新定位器写入 `overrides`，并追加 `healing_log`。

## 4. 隔离与代理模型

### 4.1 账号隔离
- 每个账号独立 `accounts/<code>/`：`storage_state.json`、`shots/`、`downloads/`、`logs/`。
- 每次会话使用**独立 browser context**（不共享 user_data_dir）；需要持久化时用该账号的 `profile/`。
- 并发：会话之间不得共享任何目录；`runs/` 按 `时间戳-recipe-账号` 分隔。
- 账号 → 稳定指纹（`fingerprint.py`）：用账号 code 的 HMAC-SHA256 派生
  `userAgent / locale / timezoneId / viewport / deviceScaleFactor / platform`，
  同一账号始终一致，不同账号彼此不同（避免同 IP 段下指纹雷同）。
- 反检测：所有平台统一注入 init script（`navigator.webdriver`、`chrome.runtime`、
  `Notification.permission`、WebGL vendor、`plugins`、`languages` 一致性）；
  头条额外保持 `--disable-blink-features=AutomationControlled`。

### 4.2 代理模型
`proxies.yaml`：
```yaml
default_policy: sticky          # sticky | rotate | direct
sticky_ttl_minutes: 30
health_check: {url: "https://api.ipify.org?format=json", timeout_ms: 15000}
extractors:
  apipool:
    type: http                  # http | static
    url: "https://example.com/api/get?num=1&type=json&format=json&sep=1"   # ← 用户稍后提供
    method: GET
    headers: {}
    parse: json                 # json | text | regex
    json_path: "data.list"      # 或 "data" 
    fields: {server: "{ip}:{port}", username: "{user}", password: "{pass}"}
    field_map: {ip: ip, port: port, user: user, pass: pass}
    text_regex: "(?P<ip>[\\d.]+):(?P<port>\\d+):(?P<user>[^:]+):(?P<pass>.+)"
    separator: ":"
    respect_whitelist: false
    cooldown_seconds: 3
static: []                      # [{server, username, password, note}]
account_policy: {}              # {a-1: sticky, b-1: rotate}
```

- **绑定**：账号首次取 IP 后写入 `accounts/<code>/proxy.json`（`server/username` + `expiresAt`），
  密码写 `secrets.yaml` 的 `proxy_passwords[server|username]`。默认 `sticky`，到期或健康检查失败才换。
- **代理是隔离键的一部分**：`session.open` 必须带上该账号绑定的代理；若账号无绑定则直连，
  并在 `result.warnings` 里明确提示「未绑定代理」。
- `secrets.yaml` 与 `accounts/*/proxy.json` 必须加入 `.gitignore`。
- 代理不可用要报 `PROXY_UNAVAILABLE`，**不能**伪装成「登录态失效」。

## 5. 与 DSH 的对接（Node 侧）

- Node 侧只做：配置、工具注册、常驻引擎进程管理、把 RPC 结果整理成人类/模型可读文本。
- 引擎进程**懒启动、常驻、按需重启**；进程内可并行多个 session。
- 每个工具调用都要能在 `MEDIA_DATA_DIR/runs` 或 `accounts/<code>/logs` 找到证据（可追溯）。
- 工具命名统一 `media_*`，见实现阶段的工具清单（下一节由插件实现补齐）。

## 6. Python 模块接口约定（并行实现的边界）

跨模块调用**只允许**使用下表中列出的名字与签名。任何实现都必须先满足这些签名，
内部可以自由拆分。类型用 Python 类型标注表达，返回 dict 必须可直接 JSON 序列化。

### `paths.py`
```python
DATA_DIR: Path                                  # MEDIA_DATA_DIR 或 ~/.dsh/media-publish
ACCOUNTS_YAML: Path; PROXIES_YAML: Path; SECRETS_YAML: Path
RECIPES_DIR: Path; BUILTIN_RECIPES_DIR: Path; RUNS_DIR: Path; TRACES_DIR: Path
def ensure_dirs() -> None
def account_dir(code: str) -> Path              # 并确保存在
def account_state_path(code: str) -> Path       # accounts/<code>/storage_state.json
def account_proxy_path(code: str) -> Path       # accounts/<code>/proxy.json
def account_shots_dir(code: str) -> Path
def account_logs_dir(code: str) -> Path
def new_run_dir(recipe_id: str, code: str) -> Path
def timestamp() -> str                          # "20260909-101500"
def safe_slug(text: str) -> str
```

### `config_store.py`
```python
def load_accounts() -> dict                     # {"accounts":[{code,media,account,note}]}
def save_accounts(data: dict) -> None
def get_account(code: str) -> dict | None
def upsert_account(code: str, media: str, account: str, note: str = "") -> dict
def remove_account(code: str, purge_state: bool = False) -> None
def load_proxies() -> dict                      # proxies.yaml，缺省时返回 DEFAULT_PROXIES
def save_proxies(data: dict) -> None
def load_secrets() -> dict                      # {"proxy_passwords": {...}}
def save_secrets(data: dict) -> None
def set_proxy_secret(server: str, username: str | None, password: str | None) -> None
def get_proxy_secret(server: str, username: str | None) -> str | None
def load_recipe(recipe_id: str) -> tuple[dict, Path]        # 用户目录优先，其次内置；找不到抛 RecipeNotFound
def list_recipes() -> list[dict]                # [{id, media, label, source, path, step_count}]
def save_recipe(recipe: dict, recipe_id: str | None = None) -> Path
def load_account_proxy(code: str) -> dict | None            # {"server","username","expiresAt"}
def save_account_proxy(code: str, proxy: dict | None) -> None
class RecipeNotFound(Exception): ...
```

### `fingerprint.py`
```python
def derive(code: str) -> dict
# keys: user_agent, locale, timezone_id, viewport{width,height}, device_scale_factor, platform
```

### `proxy_pool.py`
```python
def fetch_proxy(code: str | None = None, force: bool = False) -> dict
# 返回 {"server","username","password","expiresAt","source"}；失败抛 ProxyUnavailable
def get_for_account(code: str, policy: str = "sticky", force_rotate: bool = False) -> dict | None
def bind(code: str, proxy: dict | None) -> None
def rotate(code: str) -> dict
def test(proxy: dict) -> dict                   # {"ok","ip","latencyMs","detail"}
def health(code: str) -> dict
class ProxyUnavailable(Exception): ...
```

### `browser.py`
```python
class BrowserManager:
    def __init__(self) -> None
    async def start(self) -> None               # 启动 playwright，幂等
    async def open_session(self, account: dict, *, proxy: dict | None,
                           fingerprint: dict, headless: bool,
                           interactive: bool = False) -> "Session"
    async def close_session(self, session: "Session", save_state: bool = True) -> None
    async def stop(self) -> None
    def chromium_path(self) -> str | None
```

### `session.py`
```python
@dataclass
class Session:
    session_id: str
    code: str
    context: "BrowserContext"
    page: "Page"
    proxy: dict | None
    fingerprint: dict
    headless: bool
    refs: dict[str, dict]                       # ref -> {"kind":"selector"|"text","value":...}
    frame_path: list[str]                       # 活动 frame 链，[] 表示 main
    trace: list[dict]
    recording: bool
    log_path: Path
    def resolve_target(self, target: dict) -> "Locator"
    def current_frame(self) -> "Frame"
    def note(self, kind: str, payload: dict) -> None    # 追加 trace + jsonl 落盘
```

### `actions.py`
```python
async def execute(session: Session, step: dict, *, dry_run: bool = False) -> dict
# step: {"type": "...", ...}（type 取 RPC 方法名的后半段，如 "click"/"goto"/"waitFor"）
# 返回 {"ms": int, "step": normalized_step, "data": dict}
# 失败抛 ActionError(code, message, details)
class ActionError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None): ...
def resolve_params(value: Any, params: dict[str, Any]) -> Any   # {{name}} / {{env:NAME}} 递归替换
```

### `observe.py`
```python
async def snapshot(session: Session, *, max_elements: int = 120, include_text: bool = True) -> dict
async def screenshot(session: Session, *, full_page: bool = False, label: str = "shot") -> dict
def detect_alerts(url: str, title: str, text: str) -> list[str]
```

### `record.py`
```python
def start(session: Session, recipe_id: str, media: str) -> dict
def status(session: Session) -> dict
def note(session: Session, text: str) -> dict
def undo(session: Session, count: int = 1) -> dict
def compile_recipe(session: Session, *, recipe_id: str | None = None, media: str | None = None,
                   label: str | None = None, params: list | None = None,
                   session_check: dict | None = None, verify: dict | None = None,
                   account_codes: list | None = None) -> dict
def save(session: Session, overwrite: bool = False, **kwargs) -> dict   # -> {"recipePath","stepCount"}
def infer_params(steps: list[dict]) -> list[dict]      # 从 trace 里推断参数（含 {{param}} 占位）
```

### `play.py`
```python
async def validate(recipe: dict) -> dict        # {"ok", "issues":[...]}
async def run(recipe: dict, *, account_code: str, params: dict, dry_run: bool = False,
              headless: bool | None = None, stop_on_error: bool = True, heal: bool = True,
              proxy_policy: str = "sticky", on_progress=None) -> dict
# 返回 {"ok","publishedUrl","failedStep","steps":[...],"runDir","artifacts":{...}}
async def backfill(recipe: dict, *, account_code: str, title: str,
                   headless: bool = True) -> dict    # 审核后回查正式链接
```

### `rpc.py`
```python
class RpcError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None): ...
def encode_response(req_id, result) -> str
def encode_error(req_id, code: str, message: str, details: dict | None = None) -> str
def encode_event(name: str, data: dict) -> str
def decode_request(line: str) -> tuple[int | None, str, dict]
```

### `sessiond.py`
- 入口：`python -m engine.sessiond`（或 `python engine/sessiond.py`，需把包根加入 `sys.path`）。
- 读 stdin 逐行解析 → 分派到方法表 → 写 stdout；异常统一转 `RpcError`。
- 方法表覆盖 §2.1 全部方法；未实现的方法返回 `UNSUPPORTED`，不得崩溃。
- `--selftest` 参数：不开浏览器，验证 import、路径创建、配置读写、recipe 解析，输出 JSON 并以退出码表示成败。
- `SIGTERM`/stdin EOF 时优雅关闭所有会话与 playwright。

## 7. DSH 工具面（Node 侧暴露给模型的 API）

工具数量要克制（每个工具都占提示词），因此按「一个领域一个工具 + `op` 分派」聚合，共 9 个：

| 工具 | 关键入参 | 作用 |
|---|---|---|
| `media_status` | — | 自检：引擎版本、数据目录、账号数、已登录账号、recipe 列表、当前会话、代理健康。**agent 的第一站** |
| `media_account` | `op`: `list\|upsert\|remove\|login\|check\|bindProxy` | 账号注册表与登录态。`login` 会开有头浏览器等人工扫码；`bindProxy` 绑/解固定代理 |
| `media_proxy` | `op`: `fetch\|test\|rotate`, `code?` | 代理池取 IP / 探测出口 IP / 轮换。**输出必须脱敏**（不返回密码，只返回 `hasPassword`） |
| `media_session` | `op`: `open\|close\|list\|state\|handoff\|resume`, `accountCode?`, `headless?`, `proxyPolicy?` | 隔离会话生命周期。`handoff` 用于把控制权交给人工（验证码/扫码） |
| `media_observe` | `sessionId`, `fullPage?`, `includeText?` | 返回页面模型（`ref` 列表 + 文本摘要 + 截图路径）。录制时的「眼睛」 |
| `media_act` | `sessionId`, `action: {type, ...}` | 执行一个动作（`goto/click/dispatch/type/press/upload/select/check/scroll/waitFor/frame/eval/extract`）。录制中会自动进 recipe |
| `media_record` | `op`: `start\|status\|note\|undo\|save`, `sessionId`, `recipeId?`, `media?` | 录制控制。`save` 编译并落盘 recipe，同时产出 `compile-report.json` |
| `media_recipe` | `op`: `list\|show\|validate`, `recipeId?` | 查看与校验 recipe |
| `media_publish` | `op`: `run\|backfill`, `recipeId`\|`media`, `accountCode`, `params`, `dryRun?`, `headless?` | 回放发布 / 审核后回查链接 |

约定：
- 所有工具的返回都是**人类可读文本 + 结构化 JSON 摘要**，并给出下一步建议（尤其失败时：
  把 `error.details.candidates`、可选的修复动作写清楚）。
- 需要人工介入时（`LOGIN_REQUIRED` / 验证码 / `handoff`），工具返回里必须明确告诉模型：
  在浏览器窗口完成操作后调用 `media_session resume`。
- `media_publish` 的 `dryRun` 默认 `true`；**真正发布必须显式传 `dryRun:false`**，
  这是防止误发的最小保险。
- 任何工具失败都不得让插件进程崩溃；引擎进程异常退出要能自动重启并在返回里说明。
- **工具信封里 `data` 装的是引擎的整个 result，不是引擎的 `data` 字段。** 也就是说引擎的
  `act.eval` 结果要写成 `value.data.data.result`，`act.extract` 的命名值在
  `value.data.data.values.<name>`，`goto` 的最终地址在 `value.data.data.url`。
  `act.js` 里就是 `data: result`。这一点必须记住：少写一层会**静默拿到 `undefined`**
  而不是报错——实测我为此连错两次（读回页面状态全为空，看起来像功能坏了，其实是取值少了一层）。
  消费方建议写一个「取引擎载荷」的助手并容忍两种形状，而不是到处硬写两层。
- **参数校验失败是抛异常，不是失败信封。** `media_act` 之类工具在入参不合规时由工具自身的
  校验器抛出 `INVALID_ARGS`（`error.code === 'INVALID_ARGS'`），只有**过了校验之后**的引擎侧
  失败才走 `{ok:false, error:{...}}` 信封。测试与调用方都要按这两种形态分别处理（实测踩过）。

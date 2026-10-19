# media-publish — DSH 插件

用 agent 控制真实浏览器完成自媒体发布流程，把流程**录制并编译成可复用的 recipe 脚本**；
后续同类发布任务直接回放脚本、不再需要模型逐步决策。同时按账号**隔离浏览器环境**，
并按账号**绑定不同的代理 IP**。

平台（v1）：搜狐号 `a-1`、头条号 `b-1`、CSDN `c-1` / `c-2`。

> 完整契约见 [docs/SPEC.md](docs/SPEC.md)；操作与 agent 剧本见 [docs/USAGE.md](docs/USAGE.md)。

---

## 需求 → 实现对照

| 需求 | 实现 |
|---|---|
| agent 控制浏览器完成发布流程 | 常驻 Python 引擎暴露 `session.snapshot`（页面模型 + `ref`）与 `act.*` 原语；Node 侧 9 个 `media_*` 工具把它交给模型。人工扫码/验证码用 `handoff` / `resume` 交接。 |
| 流程转化为脚本 | 录制期间每个动作的规范化 `step` 进 trace；`record.save` 编译成 recipe YAML，自动把标题/正文等字面量参数化成 `{{param}}`，并产出 `compile-report.json` 说明判断依据。 |
| 后续自动调用脚本快速发布 | `play.run` 按 recipe 回放，不需要模型参与；失败先自愈（重新快照 + 候选匹配），唯一高置信才改写定位器并记进 `overrides`，有歧义就报错给候选。 |
| 隔离发布账号 | 每账号独立 `storage_state` / 截图 / 下载 / 日志目录、独立 browser context、由账号 code 的 HMAC 派生的稳定且互不相同的指纹。 |
| 不同代理 IP 在不同隔离账号下发布 | 账号级代理绑定（`account.bindProxy` + 代理池），默认 sticky；代理是隔离键的一部分，账号与出口 IP 一一对应。 |

---

## 架构

```
DSH (Electron Host)
└── @dsh-plugin/media-publish            ← Node 插件（薄层：配置 / 工具 / 进程生命周期）
    ├── src/index.js                     配置解析、Python 探测、装配工具
    ├── src/tool-kit.js                  defineTool / renderValue（零依赖重实现，见下）
    ├── src/engine-client.js             常驻子进程的 NDJSON JSON-RPC 客户端
    └── src/tools/*.js                   9 个 media_* 工具
         │  NDJSON over stdin/stdout（契约：SPEC §2）
         ▼
    engine/sessiond.py                   ← Python 引擎（常驻，进程内可多会话）
    ├── session/browser/actions/observe   会话、隔离上下文、act/observe 原语
    ├── proxy_pool/fingerprint            代理池、账号指纹
    ├── record.py / play.py               录制→recipe 编译、recipe→回放（含自愈）
    └── recipes/*.yaml                    三个平台的内置 recipe
```

### 为什么插件是零运行时依赖

插件以 pnpm `link:`（symlink）依赖安装进 profile，而 **pnpm 不安装被链接包的自身依赖**。
任何 `import ... from '@deepseek-ai/...'` 都会以 `ERR_MODULE_NOT_FOUND` 让整个入口无法激活
（已实测复现）。因此 `src/` 只使用 `node:*` 内建模块，宿主本来提供的两个辅助函数在
`src/tool-kit.js` 里按宿主的注册契约重新实现——契约是从宿主产物里的 `defineTool` 逐字读出来的，
不是猜的。

### 安装、升级与开发迭代（这里踩过坑，务必照做）

**推荐：装成 tarball（真实副本），不要用 `link:`。**

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm pack --pack-destination dist
# 然后把 dist\*.tgz 交给 plugin_manager install_bundle
```

`package.json` 的 `files` 已排除 `engine/__pycache__`，所以包内不会有 `.pyc`。

**为什么不要用 `link:`。** `link:` 会在 profile 的 `node_modules` 下建一个指向源码目录的符号链接，
而 Node 解析符号链接后用的是**源码目录的真实路径**。于是：

- `dsh-base` 给 HMR 的配置是 `root: []`，按 HMR 文档这只监视配置文件、**不监视模块根**；
  再加上 HMR 默认 `ignored` 含 `**/node_modules`，装在 `node_modules` 里的插件也不会被监视。
- 结果：插件模块留在 Node 的 ESM 缓存里，`set_bundle` 关掉再打开只重新应用补丁、
  报 `application: applied`，运行中的 host 仍然执行**第一次导入的那份代码**。
  我在 profile 里给 `hmr` 加过插件目录作为监视根，实测**仍然无效**（该改动已还原）。

`fiberPhase: active` 只证明这一行被激活，**不证明它加载的是你刚写的代码**——这两件事必须分开看。

**怎么确认自己看的不是旧代码**：`media_status` 会报 `pluginVersion`，它必须等于
`package.json` 与 `src/index.js` 里 `PLUGIN_VERSION` 的当前值。报出更小的值就说明跑的是旧版本，
此时任何「工具已可用」的结论都不成立。这个版本号就是为此存在的——它抓到过一次
「以为已经生效、其实还在跑第一版、引擎还因为选错解释器而起不来」的情况。

**升级插件的正确姿势**：改完源码 → 重新 `pack` → `install_bundle` 新的 tarball → 按管理器提示
重启 DSH。管理器在依赖身份变化（`link:` → tarball）时会直接报 `application: restart-required`，
这是预期行为，不是失败。

**升级时会踩到的坑：目录被锁（`ERR_PNPM_EPERM ... rename`）。** 只要 DSH 在运行，
插件自己的引擎进程（`python -u -m engine.sessiond`）就以**安装目录为工作目录**活着，
Windows 不允许重命名一个被占用为 cwd 的目录，于是 pnpm 装不进去。而且**这次失败会把
profile 的依赖与 bundle 选择一起回滚掉**（管理器恢复了 package.json 快照），
所以事后必须重新 `install_bundle` 一次，不是重试就行。

处理顺序：

```powershell
# 1) 先停掉占用目录的引擎进程（它是空闲子进程，宿主下次调用会按需重启）
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*engine.sessiond*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 2) 再 install_bundle 新的 tarball
# 3) 重启 DSH 让宿主加载新模块
```

**第二个坑：不要先删旧 tarball。** profile 的 `package.json` 会把依赖指向具体那个 `.tgz`
文件路径。如果先把 `dist\*.tgz` 清空再安装，pnpm 连「当前声明的依赖」都解析不了，
直接报 `ENOENT ... 0.2.1.tgz` 而失败。**顺序必须是：先 pack 出新 tarball → 再（必要时
`remove_bundle` 清掉旧声明 →）安装新 tarball → 最后才清理旧的**。

**只想改** ***recipe*** **不必重装**：把改好的 YAML 放到用户目录
`<dataDir>\recipes\<media>\<id>.yaml` 即可，它优先于包内置的同名 recipe
（已用回归测试锁定这条优先级）。

---

## 安装

**推荐：从 tarball 安装（真实副本）。**

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
Set-Location <本插件目录>
& $node $pnpm pack --pack-destination dist
# 得到 dist\dsh-plugin-media-publish-0.2.0.tgz，把它交给：
#   plugin_manager {action:"install_bundle", target:"<该 tgz 的绝对路径>"}
```

安装后**重启 DeepSeek Harness**（原因见上一节），再：

```text
media_status {probe:true}
```

应看到 `pluginVersion: 0.2.2`、解释器 `source: dsh-runtime` 且带 `python.probe`、
`engine.report.playwright: 1.63.0`、`engine.report.methods: 43`、`recipes: 3`。

配置在 `cordis.patch.yml`，可按 `id: media-publish` 覆盖：
`pythonPath` / `dataDir` / `headless` / `requireExplicitPublish` / `requestTimeoutMs`。
`pythonPath` 留空时会按「配置 → `MEDIA_PYTHON` → DSH 运行时自带解释器 → PATH」顺序探测，
**并且会真的试跑 `import playwright`**，所以「选到没装 Playwright 的 python 却静默失败」不会发生。

关于 `requireExplicitPublish` 的**准确**含义：真正起作用的闸门是 `dryRun` **默认为 true**
（`media_publish` 里写死 `args.dryRun === undefined ? true : ...`，与配置无关）；
而 `requireExplicitPublish`（默认 true）只决定**真发时是否额外给出 `REAL PUBLISH` 告警**。
也就是说把它设成 false 并**不会**让 `dryRun` 默认变成 false —— 失败方向是安全的。
这一点由 `publish-safety-e2e.mjs` 用真实提交次数锁定（不传 `dryRun` → 0 次提交）。

---

## 工具面（9 个）

| 工具 | 作用 |
|---|---|
| `media_status` | 自检：解释器、数据目录、账号、代理、recipe、会话。**第一站** |
| `media_account` | `list/upsert/remove/login/check/bindProxy` |
| `media_proxy` | `fetch/test/rotate`（输出脱敏，不含密码） |
| `media_session` | `open/close/list/state/handoff/resume` |
| `media_observe` | 页面模型：`ref` 列表 + 文本摘要 + `alerts` + 截图路径 |
| `media_act` | 执行一个动作：`goto/click/dispatch/type/press/upload/select/check/scroll/waitFor/frame/eval/extract` |
| `media_record` | `start/status/note/undo/save` |
| `media_recipe` | `list/show/validate` |
| `media_publish` | `run/backfill`；`dryRun` **默认 true** |

---

## 运行时数据布局

```
%USERPROFILE%\.dsh\media-publish\        （可用 config.dataDir 覆盖）
├── accounts.yaml          账号注册表（不含任何密码）
├── secrets.yaml           代理密码（gitignore）
├── proxies.yaml           代理池配置
├── accounts/<code>/
│   ├── storage_state.json cookie + localStorage 全量登录态
│   ├── proxy.json         绑定的代理（不含密码）
│   ├── shots/ downloads/ logs/
├── recipes/<media>/<id>.yaml     + <id>.compile-report.json
├── traces/<ts>.jsonl            原始操作轨迹
└── runs/<ts>-<recipe>-<code>/   run.json（逐步状态）+ 截图 + stdout.log
```

---

## 测试

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 1) 引擎纯逻辑自检（不开浏览器），退出码即结论
& $py tests\run_selftest.py

# 2) recipe 校验 / 参数推断 / 自愈判定（纯逻辑）。支持 `python -m pytest`，
#    但本机运行时**没有装 pytest**，所以按脚本方式运行。
& $py tests\test_recipes.py

# 3) 插件装配 + 每个工具的入参校验（不连引擎，用 stub）
& $node tests\probe-apply.mjs src\index.js

# 3b) **最重要的一道**：用**真实引擎**把 9 个工具各跑一遍（成功路径 + 失败路径），
#     并对每个返回值断言「满足该工具声明的 output.schema」且「是无损 JSON」。
#     宿主严格校验工具返回值，而 3) 只灌过 stub —— 这道关卡就是为补那个盲区写的。
& $node tests\probe-apply-live.mjs src\index.js

# 3c) 解释器探测：必须真的能 import playwright（硬要求），且报出**真实版本号**
#     （曾经报 "unknown"，因为 playwright 包没有 __version__）
& $node tests\probe-python-check.mjs src\index.js

# 4) 通道韧性：引擎崩溃自动重启、杂散 stdout 只记日志、事件送达、超时可诊断
#    （用 tests/flaky_engine.py 这个「故意不守规矩」的替身，可复现地制造这些故障）
& $node tests\engine-restart.mjs

# 5) Node↔Python 通道 + 真实无头浏览器：会话、快照、按 text/ref 点击、截图、
#    TARGET_NOT_FOUND 的候选回传、双账号指纹可区分且稳定、状态路径隔离
& $node tests\engine-smoke.mjs

# 6) 账号↔代理隔离：绑定/解绑、密码只进 secrets.yaml、结果脱敏、
#    不可用代理报 PROXY_UNAVAILABLE 而非登录失效、两个账号同时走不同代理
& $node tests\proxy-e2e.mjs

# 7) 核心闭环：录制 → 编译 recipe（字面量参数化）→ dryRun 不提交 → 回放用新内容提交成功
& $node tests\record-replay-e2e.mjs

# 8) 人工介入链路：拦截页被识别 → handoff 事件送达 → 未解决时 resume 不谎报成功 →
#    人工解决后 resume 靠 **DOM 变化（无跳转）** 恢复，且恢复后可正常录入
& $node tests\handoff-resume-e2e.mjs

# 8b) **登录能否长期复用 + 是否真的隔离**：本地假平台登录 → 落盘 storage_state →
#     新会话仍然已登录（cookie 与 localStorage 都恢复）→ 换账号则未登录且看不到对方 localStorage →
#     saveState:false 不改动状态文件 → 之后再 save 能持久化新状态
& $node tests\session-persistence-e2e.mjs

# 8c) **发布安全闸门（最重要的一条安全属性）**：通过工具层（模型真正调用的那一层）对着
#     本地假平台数提交次数——不传 dryRun 提交 0 次、dryRun:true 提交 0 次、
#     只有 dryRun:false 才提交 1 次；且文本/告警/下一步都明确写了「这是空跑、什么都没发布」
& $node tests\publish-safety-e2e.mjs

# 8d) **13 种动作类型全覆盖**：每种都通过工具跑在真实页面上，并断言页面真的变了
#     （dispatch 真的勾选 radio、frame 切进 iframe 后内层输入框真的收到文本……）
& $node tests\act-coverage-e2e.mjs

# 9) 对着**真实平台**预检：三份内置 recipe 都能加载校验，且未登录时在敲任何内容之前
#    就以 LOGIN_REQUIRED 快速失败（只做一次 GET，headless，dryRun，用完即删临时数据目录）
& $node tests\builtin-recipes-preflight.mjs

# 10) 登录机器（你重启后的第一步）：参数/媒体分类、无登录态时 checkLogin 不开浏览器、
#     登录超时 **不写 storage_state** 也不漏会话、缺登录态与未绑代理都以告警明示
& $node tests\account-login-e2e.mjs
```

4/5/6/7/8/10 都跑在**临时 `MEDIA_DATA_DIR`** 上，成功即自动删除，绝不会碰真实账号、登录态或 recipe；
失败则保留目录供排查。9 与 10 需要外网，设 `MEDIA_SKIP_NETWORK=1` 可跳过。

### 每道关卡在证明什么

| 关卡 | 证明的能力 | 最近一次结果 |
|---|---|---|
| `probe-apply.mjs` | 9 个工具都能注册、入参 schema 合法、未知参数被拒、失败都带 `code`/`nextSteps`；关闭了 `dryRun` 默认 true、登录/回放超时、代理结果脱敏（含 URL userinfo 擦除）；并对每个返回值断言满足 `output.schema` 且无损 JSON | **330/330 通过** |
| `probe-apply-live.mjs` | **用真实引擎**跑每个工具的成功与失败路径，逐值断言 `output.schema` 与无损 JSON。这道关卡补的是一个真实盲区：只灌 stub 的检查看不出「schema 声明 object 而代码写 `null`」这类问题——它曾让 9 个工具里的 8 个在宿主校验处全废。对旧副本它会报 283/330，证明它抓得到 | **110/110 通过** |
| `probe-python-check.mjs` | 解释器探测：必须真的 `import playwright`（硬要求）且报出**真实版本号**，并验证一个不存在的 `MEDIA_PYTHON` 会被跳过而不是被接受 | **8/8 通过** |
| `session-persistence-e2e.mjs` | **登录能否长期复用、是否真隔离**：本地假平台登录 → `storage_state` 落盘（cookie + localStorage）→ 新会话仍已登录 → 换账号未登录且看不到对方 localStorage → `saveState:false` 不动文件 → 之后再 save 能持久化新状态 | **14/14 通过** |
| `publish-safety-e2e.mjs` | **发布安全闸门**（通过工具层数真实提交次数）：不传 `dryRun` → **0 次提交**；`dryRun:true` → 0 次；只有 `dryRun:false` → 恰好 1 次且带上了传入参数；空跑时文本/告警/未注明而实发时标 `REAL PUBLISH` | **18/18 通过** |
| `act-coverage-e2e.mjs` | **全部 13 种动作类型**逐个通过工具跑在真实页面上，并断言页面**真的变了**：`dispatch` 真的勾选了 radio（搜狐创作声明所依赖的机制）、`frame` 切进 iframe 后内层输入框真的收到了文本（CSDN CKEditor4 所依赖的机制）、`click` 计数为 1、`select`/`check`/`upload`/`scroll`/`press`/`waitFor`/`eval`/`extract` 效果可观测；未知类型被 schema 拒绝 | **98 项通过** |
| `engine-restart.mjs` | 引擎崩溃/被外部杀死后**下一次调用自动重启**；杂散 stdout 只记日志；`handoff`/`progress` 事件送达；超时带引擎 stderr 尾巴 | **22/22 通过** |
| `run_selftest.py` | 引擎纯逻辑：路径/配置/指纹/代理池/协议编解码/方法表完整性/无 stdout 污染 | **13/13 通过** |
| `smoke_browser.py` | 真实无头 Chromium 的会话生命周期与 act 原语 | 通过 |
| `engine-smoke.mjs` | 会话、页面模型（`ref`）、按 text/ref 点击、截图、`TARGET_NOT_FOUND` 回传候选、双账号指纹可区分且稳定、状态路径隔离 | **27/27 通过** |
| `proxy-e2e.mjs` | 账号↔代理绑定/解绑、密码只进 `secrets.yaml`、结果零凭据泄漏、`.gitignore` 到位、代理故障不伪装成登录失效、两账号并发走不同代理 | **35/35 通过** |
| `test_recipes.py` | 三个平台 recipe 校验零错误、参数推断、提交步标记、自愈判定、trace 形状容忍 | **28/28 通过** |
| `record-replay-e2e.mjs` | **核心闭环**：录制 7 步 → 编译 recipe（字面量变 `{{title}}`/`{{body}}`，产出 compile-report）→ `dryRun` 只填表不提交（0 次提交）→ 回放提交并收到**回放内容** → 二次回放仍成功 | **28/28 通过** |
| `handoff-resume-e2e.mjs` | **人工介入链路**（半自动录制的关键）：拦截页在页面模型里被识别 → `handoff` 事件送达宿主且带回可执行指引 → 未解决时 `resume` 报 TIMEOUT 而非谎报成功 → 人工解决后 `resume` 靠 **DOM 变化、URL 未变** 恢复（1.0s）→ 恢复后会话可正常录入 | **15/15 通过** |
| `builtin-recipes-preflight.mjs` | 对着**真实平台**：三份内置 recipe 零错误加载，且未登录时**在敲任何内容之前**以 `LOGIN_REQUIRED` 快速失败（搜狐「登录/注册」、头条 `/login`+「扫码登录」、CSDN passport iframe），不崩、不谎报已发布、留下 `run.json` | **16/16 通过** |
| `account-login-e2e.mjs` | **登录机器**：未注册账号 `BAD_REQUEST`、无登录配置的媒体 `UNSUPPORTED`（并列出支持的平台）、无登录态时 `checkLogin` 报 unknown 且**不开浏览器**、登录超时**不写 `storage_state`** 也不漏会话、空状态文件不被信任、缺登录态与未绑代理都以告警明示 | **21/21 通过** |

### 尚未验证的部分（需要你参与）

1. **GUI 里的实时可用性 —— 必须重启 DSH，这一步已验证过无法绕过。**

   现象：运行中的 host 仍在执行插件**第一次导入的旧版本**。判据（独立且可复核）：
   `media_status` 报 `pluginVersion 0.1.0`（当前源码是 `0.2.0`——`src/index.js:166` 把它作为
   `deps.pluginVersion` 传给每个工具，`src/tools/status.js:23` 再读出来，所以这个数字可信）、
   `pluginRoot` 仍是 workspace 路径、`python.source: "PATH"` 且缺 `python.probe`、
   无 `engine.report`（引擎因选中 PATH 上没装 Playwright 的 python 而在 import 时退出）、
   工具面只有 1～2 个而不是 9 个。

   已实测**全部无效**的四种在进程内补救：toggle bundle 关闭再打开（`application: applied`，
   但连续 4 次的引擎日志文件证明仍是同一份旧代码）；给 profile 的 `hmr` 加插件目录为监视根
   （试过无效，**已还原**，你的 `cordis.patch.yml` 未被留下无用配置）；
   改装成 tarball 真实副本（`pluginRoot` 仍报 workspace 路径）；
   `remove_bundle` 后再 `install_bundle`。
   结论：该模块在一个 host 进程里只会被导入一次，缓存以解析后的路径为键，
   任何重新注册都只是复用已缓存的那一份。

   **处理：重启 DeepSeek Harness**（关掉应用再打开）。重启后调 `media_status {probe:true}`，
   应看到 `pluginVersion 0.2.0`、`pluginRoot` 在
   `profiles\desktop\node_modules\@dsh-plugin\media-publish` 下、`python.source: dsh-runtime` 且带
   `python.probe`、`engine.report.playwright: 1.63.0`、`engine.report.methods: 43`、`recipes: 3`，
   以及 9 个 `media_*` 工具。

   **重启之后会生效，这一点已经预先验证过**：插件现在是以 **tarball 真实副本**安装的
   （`package.json` 里记的是 `file:...dist\dsh-plugin-media-publish-0.2.0.tgz`），
   副本内容完整（`engine/__init__.py`、`sessiond.py`、`record.py`、`play.py`、3 份 recipe 齐全，
   且不含 `.pyc`）。已逐个文件比对 SHA256：**18 个文件里 17 个与 workspace 源码完全一致**
   （唯一不同的是 `package.json`，由安装过程规范化），并且
   **从该副本目录直接跑 `python -m engine.sessiond --selftest` 得到 `ok=True passed=15 failed=0`**。
   所以只剩「让 host 重新加载」这一步。

   若重启后仍报 `0.1.0`，请把 `media_status` 的完整输出发我。
2. **三个平台 recipe 的定位器**：每一份都在文件头写明来源脚本的行号区间，并把无法确证的步骤标了
   `待实机验证`。需要真实账号登录后**各录制一次**来确证（见 USAGE §5）。最可能要先修的是
   头条的工具栏索引与封面、CSDN 的标签创建。
3. **代理提取链接**：`proxies.yaml` 的 `extractors.apipool.url` 仍是占位符。绑定/隔离/脱敏本身已验证，
   但「从动态 IP 池取 IP」需要你给出提取链接与返回格式后才能跑通。

`tests/run_selftest.py` 存在的理由：引擎的 `--selftest` 输出带中文的 JSON，直接用 shell 重定向
在 Windows 上会被编码破坏，这个 harness 用字节级读取保证报告完好。

---

## 已知边界

- 三个平台的 recipe 里，凡无法从现有脚本确证的定位器都带 `note:` 并在
  `engine/recipes/*.yaml` 头部注明来源行号；**需要在真实平台上录制一次来确证**。
- 代理池的提取链接尚未提供，`proxies.yaml` 的 `extractors.apipool.url` 是占位符；
  未配置时代理相关调用会明确报 `PROXY_UNAVAILABLE`，会话则降级为直连并告警。
- 头条号 headless 发布会被静默拦截，因此默认有头；`media_publish` 回放后用 `backfill` 核实
  正式链接，不要只看「提交成功」。
- 本插件不负责新闻稿生成（写作/humanizer/xlsx 流水线仍属 `media-publish-skill`）。
- **dry run 有两套机制且只有一套在生效**：`play.py` 自己跳过第一个 `submit: true` 步骤及其之后所有步骤，
  同时它以 `dry_run=False` 调用动作层，所以动作层内建的 dry-run 容忍分支当前走不到。
  行为本身已被关卡验证正确（0 次提交、后续步骤报 `skipped`），但这属于重复实现；
  统一它们需要改已验证过的 `play.py`，风险大于收益，因此保留并在此记明。
- **账号登录校验只对过配置、没对过真实平台**：`account.login` / `account.checkLogin` 的校验 URL 与
  失败标记取自原 skill（搜狐「安全验证/请登录」、头条 sso/passport、CSDN passport.csdn.net），
  但受限于环境从未真实跑过。需要你用真实账号登录一次来确证；
  如果某个平台的登录成功判据不准，症状会是「登录好了但工具仍报 `LOGIN_REQUIRED`」。

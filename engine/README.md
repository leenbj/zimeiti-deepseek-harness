# engine —— Python 浏览器引擎

`media-publish-plugin` 的浏览器执行层。Node 侧把它当**常驻子进程**，用
stdin/stdout 上的 **NDJSON JSON-RPC** 通信（契约见 [`docs/SPEC.md`](../docs/SPEC.md) §2/§6）。

```
engine/
├── sessiond.py      入口：JSON-RPC loop + 方法表 + --selftest
├── rpc.py           协议编解码、错误码、事件、stdout 纪律（唯一写 stdout 的地方）
├── paths.py         数据目录解析（MEDIA_DATA_DIR 或 ~/.dsh/media-publish）
├── config_store.py  accounts.yaml / proxies.yaml / secrets.yaml / recipes 读写
├── fingerprint.py   账号 → 稳定设备指纹（HMAC 派生 + 设备档案池）
├── proxy_pool.py    提取器（http/static、json/text/regex）+ 粘性绑定 + 健康探测
├── browser.py       launch/context 构建：代理、bypass、反检测 init script
├── session.py       会话对象：ref 注册表、frame 栈、trace、target 解析与自愈
├── actions.py       act.* 实现（唯一执行浏览器动作的地方）
└── observe.py       snapshot / screenshot / alerts / 文本优先级定位
```

## 运行

```powershell
# 常驻引擎（被 Node 侧 engine-client.js 拉起，也可手动调试）
python -m engine.sessiond

# 不开浏览器的纯逻辑自检（退出码 0/1 + stdout 一份 JSON 摘要）
python -m engine.sessiond --selftest

# 版本 / 数据目录
python -m engine.sessiond --version
```

环境变量：

| 变量 | 作用 |
|---|---|
| `MEDIA_DATA_DIR` | 运行时数据目录（默认 `%USERPROFILE%\.dsh\media-publish`） |
| `MEDIA_FP_SECRET` | 指纹 HMAC 密钥（不设则用内置常量；换了等于换一批指纹） |
| `MEDIA_PROXY_BYPASS` | 代理 bypass 规则，默认 `<-loopback>`（连 loopback 也走代理） |
| `MEDIA_DEBUG_ORDER` | 设为 1 时把每个请求的「顺序占位」写进 stderr（诊断并发顺序用） |

**stdout 纪律**：stdout 只有协议帧，全部由 `rpc.emit_frame()` 写出；日志一律走 stderr
（`rpc.log()`）。`--selftest` 里有一条检查会扫描源码，防止有人把 `print()` 写回 stdout。

## 请求顺序与并发

同一进程可同时开多个会话。请求按「隔离键」保序：

* 带 `sessionId` 的请求 → 同一会话内**按到达顺序**串行；
* 带 `code` 的 `account.*` / `proxy.*` → 同一账号内串行；
* 不同键的请求**并行**执行；
* `session.open` / `session.close` / `account.upsert` / `account.remove` /
  `account.bindProxy` 是**全局屏障** —— 任何在其之后到达的请求都会等它跑完，因此
  `Get-Content script.ndjson | python -m engine.sessiond` 这种一次性灌入也能正确按序。
  长操作（`account.login` / `play.run` / `proxy.fetch`）不是屏障，不会拖住别的账号。

顺序占位发生在**收到该行的当下**（`Engine.reserve()`），不是在任务开跑之后 —— 队列非空时
`asyncio.Queue.get()` 不一定让出事件循环，把占位放进任务里就等于没有顺序。

## 一次完整的 RPC 记录（真实抓取，已裁剪）

`data:text/html` 页面：`<h1>你好</h1><button id="b" onclick="…">发布</button>`。

**1) `engine.status`**
```json
{"id":1,"method":"engine.status","params":{}}
{"id":1,"ok":true,"result":{"version":"1.0.0","dataDir":"C:\\Users\\wangbo\\AppData\\Local\\Temp\\media-smoke-70y7w1xl","sessions":0,"accounts":0,"playwright":"1.63.0","chromium":"C:\\Users\\wangbo\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe","python":"3.12.14","protocol":"ndjson","methods":43,"recipes":3}}
```

**2) `session.open`（直连 + 无头）**
```json
{"id":2,"method":"session.open","params":{"accountCode":"a-1","headless":true,"proxyPolicy":"direct"}}
{"id":2,"ok":true,"result":{"sessionId":"s1","accountCode":"a-1","proxy":null,"proxyPolicy":"direct",
 "storageStatePath":"…\\accounts\\a-1\\storage_state.json","storageStateExists":false,
 "fingerprint":{"user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36","locale":"zh-CN","timezone_id":"Asia/Shanghai","viewport":{"width":1366,"height":768},"device_scale_factor":1,"platform":"Win32","ua_major":153,"viewport_size":"1366x768"},
 "headless":true,"logPath":"…\\accounts\\a-1\\logs\\20261013-120356-s1.jsonl",
 "warnings":["账号 a-1 无 storage_state（首次使用需 account.login）"]}}
```
> 未绑定代理时**不报错**：直连并把「未绑定代理」写进 `warnings`（代理确实配了却拿不到才报
> `PROXY_UNAVAILABLE`，绝不伪装成登录态失效）。

**3) `act.goto`**
```json
{"id":3,"method":"act.goto","params":{"sessionId":"s1","url":"data:text/html;charset=utf-8,%3C!doctype html%3E…","waitUntil":"domcontentloaded"}}
{"id":3,"ok":true,"result":{"ms":21,"step":{"url":"data:text/html;charset=utf-8,…","waitUntil":"domcontentloaded","type":"goto"},"data":{"url":"data:text/html;…","status":null}}}
```

**4) `session.snapshot`**（`interactive[]` 已裁剪）
```json
{"id":4,"method":"session.snapshot","params":{"sessionId":"s1","maxElements":60}}
{"id":4,"ok":true,"result":{"sessionId":"s1","url":"data:text/html;charset=utf-8,…","title":"冒烟",
 "activeFrame":"main","frames":[{"path":"main","url":"data:text/html,…"}],
 "interactive":[{"ref":"e3","tag":"button","role":"button","text":"发布","selector":"#b","visible":true,"enabled":true,"box":[8,46,54,21],"inFrame":"main"},
                {"ref":"e1","tag":"input","role":"textbox","type":"text","text":"请输入标题（5-72字）","selector":"#title-input","placeholder":"请输入标题（5-72字）","visible":true,"enabled":true,"box":[8,75,169,21],"inFrame":"main","hidden":false}],
 "textSample":["你好","发布"],
 "alerts":[],
 "counts":{"interactive":2,"scanned":2},"truncated":false,
 "screenshot":"…\\accounts\\a-1\\shots\\20261013-120356-snapshot-s1.png"}}
```
`ref` 在下一次 snapshot 前保持有效；每个元素都带一条可持久化的 CSS 路径，`act.*` 用它回指，
失效时降级到 `{role,text,nth}` 并在失败响应里给出 `error.details.candidates`。

**5) `act.click`（先按 text，再按 ref）**
```json
{"id":5,"method":"act.click","params":{"sessionId":"s1","target":{"text":"发布"}}}
{"id":5,"ok":true,"result":{"ms":34,"step":{"target":{"text":"发布"},"type":"click"},
 "data":{"via":"playwright","ms":34,"matchTier":"interactive-exact"}}}
{"id":6,"method":"act.click","params":{"sessionId":"s1","target":{"ref":"e3"}}}
{"id":6,"ok":true,"result":{"ms":28,"step":{"target":{"selector":"#b"},"type":"click"},
 "data":{"via":"playwright","ms":28,"resolvedTarget":{"selector":"#b"}}}}
```
> ① `text` 目标按四级优先级定位：**交互元素精确 > 任意元素精确 > 交互元素子串 > 任意元素子串**，
> 同级多个匹配时优先「可见且在视口内」，并在 `data` 里回 `matchTier` / `ambiguous` / `candidates`。
> ② 返回的 `step` 是**可直接进 recipe** 的规范化步骤：`ref` 会被降级成 `selector`
> （ref 只在下一次 snapshot 前有效，写进 recipe 就是死引用）。

**6) `session.screenshot`**
```json
{"id":7,"method":"session.screenshot","params":{"sessionId":"s1","fullPage":false,"label":"smoke"}}
{"id":7,"ok":true,"result":{"path":"…\\accounts\\a-1\\shots\\20261013-120356-smoke-s1.png","width":1366,"height":768,"bytes":9078,"fullPage":false}}
```

**7) `session.close`**
```json
{"id":8,"method":"session.close","params":{"sessionId":"s1","saveState":true}}
{"id":8,"ok":true,"result":{"ok":true,"sessionId":"s1","savedStatePath":"…\\accounts\\a-1\\storage_state.json"}}
```

**主动事件**（无 `id`，可与响应交错，客户端忽略不认识的事件）：
```json
{"event":"handoff","data":{"sessionId":"s1","reason":"captcha","hint":"请在浏览器窗口中完成人工操作…","url":"https://…","headless":false}}
{"event":"progress","data":{"method":"play.run","index":3,"type":"type","status":"running"}}
```

## 隔离与代理要点

* 每个账号一个独立 `BrowserContext`（不共享 `user_data_dir`），目录全部按账号分开：
  `accounts/<code>/{storage_state.json,proxy.json,shots,downloads,logs}`；回放产物走
  `runs/<ts>-<recipe>-<code>/`。
* 指纹由 `HMAC-SHA256(code)` 从**设备档案池**（8 套：OS × Chrome 主版本 × 分辨率 × 时区 × GPU）
  里挑一套，同一账号恒定；`前缀+数字` 的相邻账号（`a-1`/`a-2`）必然落在相邻且不同的档案上。
* 代理密码**只**进 `secrets.yaml`（key = `server|username`）；`accounts/*/proxy.json` 只有
  `server/username/expiresAt`，两处都在自动生成的 `.gitignore` 里。
* 代理默认 `sticky`：先复用未过期绑定，只有 `force`/换 IP 才去问提取器；`static` 列表是
  一等来源（没配 `extractors` 也能用）。
* Chromium 默认绕过 loopback，会让本地代理静默失效。这里显式设
  `proxy.bypass = "<-loopback>"`（不选 `--proxy-bypass-list` 启动参数：启动参数是进程内全局的，
  而本引擎按 headless 值共享 Browser，全局 bypass 会污染直连会话）。
* 反检测：一个统一 init script 处理 `navigator.webdriver` / `chrome.runtime` / `plugins` /
  `languages`（与指纹 locale 自洽）/ WebGL vendor+renderer / `Notification.permission`，
  启动参数**永远**带 `--disable-blink-features=AutomationControlled`，`channel` 不设置
  （用 Playwright 自带 chromium），`headless=<参数>`。

## 测试

```powershell
python -m engine.sessiond --selftest    # 12 项纯逻辑检查（不开浏览器）
python tests\test_selftest.py           # 14 个独立纯逻辑用例 + 跑一遍上面那条
python tests\smoke_browser.py           # 真无头浏览器：打开→快照→按 text/ref 点击→截图→关闭
python tests\smoke_browser.py --piped   # 一次性灌入全部请求（验证顺序屏障）
python tests\smoke_browser.py --isolation   # 两账号同时开会话：指纹/状态/context 互不相同
```

Node 侧的端到端验收（在本仓库根目录跑）：
`node tests\engine-smoke.mjs`、`node tests\proxy-e2e.mjs`、`node tests\record-replay-e2e.mjs`。

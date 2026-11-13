---
name: zimeiti-deepseek-harness
description: 自媒体发布（ego-publish 插件）。用 ego lite（或本机 Chrome）驱动每个账号一个隔离浏览器档案，把图文发布到搜狐号／头条号／CSDN；支持账号登录态、代理池、可回放的发布流程（flow）、批量脚本发布与结果回查。当用户要求"发到搜狐号／头条号"、"多账号分发"、"发布并回查链接"时加载本技能。
---

# 自媒体发布（zimeiti-deepseek-harness）

本仓库是 DSH 插件 `@dsh-plugin/ego-publish`（显示名：**自媒体发布**）的源码与使用手册。
插件在宿主侧注册一组 `egolite_*` 工具，Agent 通过它们完成"每账号一个隔离浏览器 → 登录 → 回放发布流程 → 回查链接"。

## 0. 能力边界

- 一个账号 = 一个独立浏览器档案（cookie / localStorage 隔离）+ 可选独立代理；不共享登录态。
- 发布是**回放 flow**：flow 是一串 `goto/click/fill/select/upload/waitFor/screenshot` 步骤，参数用 `{{title}}` `{{body}}` 占位。
- **不会自己"创作"内容**：稿件由调用方（新闻写作技能／人工）提供，本插件只负责填表与提交。
- 默认 `dryRun:true`：只填表、截图、停在提交前；真发必须显式 `dryRun:false`。
- 平台侧审核不由本插件控制：发布后链接要"过审"才出现，预览链不是公开链接。

## 1. 先看状态（任何操作前）

```
egolite_status            # 插件版本、ego 路径、数据根、每个账号的登录态/代理、可用 flow
```

关键返回值：
- `dataDir`：`~/.dsh/ego-publish`（账号档案、运行记录、截图都在这里）
- `accounts[]`：`code`（账号代号，如 `a-1`）、`media`（`sohu|toutiao|csdn`）、`hasProfile`、`proxy`
- `flows[]`：`sohu__publish-article` / `toutiao__publish-article` / `csdn__publish-article`，以及各自的 `params`

## 2. 账号与登录

```
egolite_account {op:"list"}
egolite_account {op:"login", code:"a-1", timeoutSec:300}   # 开窗口，人工扫码/输密码
egolite_account {op:"check", code:"a-1"}                   # 复检登录态（会真的开浏览器）
egolite_account {op:"upsert", code:"a-2", media:"sohu", account:"<登录名>"}
```

- **平台标记必须与实际一致**（`media` 写错会把别的平台的 cookie 写进档案，污染登录态）。
- "有档案"≠"已登录"：以 `check` 或一次 dry run 能走到提交前为准。
- 新增账号优先走 GUI「新增账号」，不要手写账号清单。

## 3. 发布：单篇（稳妥，带截图）

```
# 彩排（默认 dryRun:true，填完表单并截图，停在提交前）
egolite_publish {accountCode:"a-1", flow:"sohu__publish-article",
                 params:{title:"<标题>", body:"<正文，\n 分段>"}, screenshots:true}

# 真发：必须显式 dryRun:false
egolite_publish {accountCode:"a-1", flow:"sohu__publish-article",
                 params:{title:"<标题>", body:"<正文，\n 分段>"}, dryRun:false}
```

- `params` 与 flow 声明一致：搜狐 `title`(≤72) `body` `declaration`(默认「无需声明」)；头条 `title`(≤30) `body` `keyword`；CSDN `title`(≤100) `body` `tag`。
- 每次运行都会在 `dataDir/runs/<ts>-<flow>-<account>/` 写 `run.json`、每步截图、提取到的链接。
- 失败返回 `failedStep` + 候选元素 + run 目录，先看截图再改。

## 4. 发布：批量（一个账号连发多篇，最快）

用 `egolite_script` 在同一个账号浏览器里循环，输出极小、速度最快。
**固定步骤（实测必须这条顺序）**：

```js
// 每个账号一个脚本，items 里放该账号今天要发的稿子
for (const it of items) {
  await goto("https://mp.sohu.com/mpfe/v4/contentManagement/first/page", {waitUntil:"domcontentloaded"});
  await sleep(2500);
  await click({text:"发布内容"});                                  // 打开发文页
  await waitFor({urlContains:"addarticle"}, {timeoutMs:45000});
  await sleep(3000);
  await fill({selector:"input"}, it.t);                            // 标题输入框
  await fill({selector:'[contenteditable="true"]'}, it.b);         // 正文编辑器
  await sleep(700);
  await click({text:"无需声明", exact:true});                       // ★ 创作声明是必选项
  await sleep(500);
  await scroll(2500);
  await click({text:"发布", exact:true});
  await sleep(3500);
  // 成功判据：URL 回到 contentManagement/first/page
}
```

**三个实测坑（不踩就等于白发）**：
1. **不点「创作声明」发布会静默失败**：点「发布」后 URL 停在 `addarticle`，页面无报错。必须点 `无需声明`（或其它声明项）。
2. **只点按钮不算成功**：以 `await url()` 回到 `first/page` 为准；停在 `addarticle` 就是没发出去。
3. **dry run 会留下草稿**：每个账号「草稿」箱里可能多出一份同题草稿，需要时手动清理。

## 5. 回查链接（过审后）

本插件没有独立的 backfill 命令，直接读该账号内容列表：

```
egolite_act {accountCode:"a-1", action:"goto", url:"https://mp.sohu.com/mpfe/v4/contentManagement/first/page"}
egolite_act {accountCode:"a-1", action:"eval",
  expression:"(() => { const out=[]; document.querySelectorAll('li').forEach(li=>{const a=li.querySelector('h3 a'); if(!a) return; const t=a.innerText.trim(); if(!/<关键词>/.test(t)) return; const x=li.innerText; const st=/审核中/.test(x)?'审核中':(/未通过/.test(x)?'未通过':(/草稿/.test(x)?'草稿':'已发布')); out.push(st+'|'+t+'|'+a.getAttribute('href'));}); return JSON.stringify(out); })()"}
```

- 已发布：`href` 形如 `https://www.sohu.com/a/<id>_<accountId>` → 可交付。
- 审核中/未通过：`href` 仍是 `…/articlepreview?id=…` **预览链，不能当公开链接交出去**。
- 「未通过」要按内容问题改写标题/首段后换账号重发，不要原样重投。

## 6. 代理与风控

- `egolite_proxy {op:"add"|"assign"|"test"|"list"}`：共享代理池，按账号绑定；不绑就走本机 IP。
- `proxyMode:"dynamic"`：每次开窗取新 IP（3 分钟 TTL），适合高风险账号；`static` 适合长期养号。
- 同一账号**串行**发布会话，不要并发开两个窗口（档案自带单例锁，第二个会被拒绝）。

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| `EGO_NOT_FOUND` | `egolite_config {op:"get"}` 看 `egoPath`；或设 `browserPath` 用本机 Chrome |
| 页面空白 / `Runtime.evaluate timeout` | 关会话重开：`egolite_session {op:"close", accountCode}` → 再 `{op:"open"}` |
| 登录失效 | `egolite_account {op:"login", code}` 重新扫码 |
| 发布按钮点了不跳转 | 检查创作声明是否选中、正文是否为空、标题是否超长 |
| 链接 404 | 仍在审核；等 10–60 分钟后重查，或改用后台列表读状态 |

## 8. 源码结构

```
src/            宿主侧：工具注册、账号与档案、flow 执行器、run 记录
lib/            前端（Web UI）构建产物
flows/          flow 定义（sohu / toutiao / csdn）
locale/         中英文案
docs/           设计说明
cordis.patch.yml 插件补丁（DSH 加载入口）
package.json    插件清单（name: @dsh-plugin/ego-publish，显示名：自媒体发布）
```

运行时数据（不进仓库）：`~/.dsh/ego-publish/`（`accounts/`、`profiles/`、`runs/`、`config.json`）。

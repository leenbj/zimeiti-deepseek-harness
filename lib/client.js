/**
 * lib/client.js — the ego-publish page: a Settings page plus a first-class panel in the left sidebar.
 *
 * Hand-written in the shipped client-bundle shape (`window.__ModuleLoader__.load({ id, factory })`, no
 * build step), so the host serves this file verbatim as the package's `./client` export. Only `react`
 * is required; the shell seeds it in its frozen module table.
 *
 * Seats:
 *   - `sidebar.panellist` (id `ego-publish`)  → the left-rail entry and its row in the More menu
 *   - `main`              (key `ego-publish`)  → the full page that entry opens
 *   - `settings.section`  (id `ego-publish`)   → the same page inside Settings
 *   - `settings.plugins.tab` / `plugins.row.config` / `plugins.bundle.config` → Settings → Plugins
 *
 * Every colour is a `--dsw-alias-*` theme token, so the page follows the host's light/dark palette.
 */

window.__ModuleLoader__.load({
	id: "@dsh-plugin/ego-publish",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const NS = "ego-publish";
		const BUNDLE = "@dsh-plugin/ego-publish";
		const ROW_ID = "ego-publish";
		const PANEL_ID = "ego-publish";

		const ROUTES = {
			status: "/ego-publish/status",
			accounts: "/ego-publish/accounts",
			points: "/ego-publish/accounts/points",
			login: "/ego-publish/accounts/login",
			check: "/ego-publish/accounts/check",
			session: "/ego-publish/accounts/session",
			proxy: "/ego-publish/proxy",
			proxies: "/ego-publish/proxies",
			proxyExtract: "/ego-publish/proxies/extract",
			config: "/ego-publish/config",
			configReset: "/ego-publish/config/reset",
			flows: "/ego-publish/flows",
			tasks: "/ego-publish/tasks",
			sources: "/ego-publish/dynamic-sources",
		};

		const en = {
			title: "ego publish",
			summary: "Publish through ego lite: one isolated browser profile per account, its own proxy, and replayable publish flows.",
			loading: "Reading status…",
			unreachable: "The plugin route did not answer; its host half may not be loaded in this deployment.",
			routeMissing: "This deployment's web server has no route for the plugin.",
			readFailed: "Could not read the plugin's status.",
			reload: "Reload",
			refresh: "Refresh",
			saved: "Saved.",
			save: "Save",
			saving: "Saving…",
			reset: "Reset",
			cancel: "Cancel",
			remove: "Remove",
			confirmRemove: "Remove this account? Its browser profile (cookies and sign-in) is kept.",
			confirmPurge: "Remove this account AND delete its browser profile (cookies and sign-in)?",
			tabAccounts: "Accounts",
			tabProxies: "Proxies",
			tabConfig: "Settings",
			tabFlows: "Publish flows",
			tabTasks: "Tasks",
			tasksTitle: "Browser tasks",
			tasksDesc: "Tasks created from an AI conversation or here; each runs in an account browser with a proxy you choose.",
			taskProxy: "Proxy",
			taskProxyAccount: "Follow the account",
			taskProxyDynamic: "Dynamic IP",
			taskProxyStatic: "Static IP",
			taskProxyId: "Static proxy",
			newTask: "New task",
			editTask: "Edit task",
			noTasks: "No tasks yet.",
			runTask: "Run",
			taskRunning: "Running…",
			taskLastRun: "Last run",
			taskTitle: "Name",
			taskDescription: "Description",
			taskAccount: "Account",
			taskUrl: "Start URL",
			taskScript: "Script (runs in the page)",
			confirmRemoveTask: "Delete this task?",
			tabSessions: "Open browsers",
			accountsTitle: "Accounts",
			accountsDesc: "Each account owns one isolated ego lite profile and, optionally, its own proxy.",
			noAccounts: "No accounts yet",
			noAccountsHint: "Add an account, sign in once in its own ego window, then publish with a dry run.",
			addAccount: "New account",
			addAccountTitle: "Add an account",
			addAccountHint: "Fill in the identity, optionally pick a proxy, then save. You can change any field later.",
			editAccountTitle: "Edit account",
			editAccountHint: "Update the account or its proxy assignment, or delete it together with its browser profile.",
			closeDialog: "Close dialog",
			sectionIdentity: "Account",
			sectionNetwork: "Network",
			loginNamePlaceholder: "phone number / login name",
			loginNameHint: "For your reference on this page; it does not affect automation.",
			notePlaceholder: "optional",
			useProxyHint: "Add proxies in the Proxies tab; one proxy can be shared by several accounts.",
			afterSaveHint: "After saving: click Sign in, finish the sign-in in that account's own ego window, then click Check.",
			editAccount: "Edit",
			saveAccount: "Save account",
			code: "Code",
			codeHint: "Lowercase letters, digits, . _ - (max 32). It names the profile directory.",
			platform: "Platform",
			loginName: "Login name",
			note: "Note",
			proxy: "Proxy",
			proxyServer: "Proxy server",
			proxyServerHint: "http://host:port or socks5://host:port; empty means a direct connection.",
			proxyUser: "Proxy user",
			proxyPassword: "Proxy password",
			credentialNote: "A proxy password is stored locally and never shown again.",
			direct: "Direct",
			hasAuth: "auth",
			signedIn: "Signed in",
			signedOut: "Not signed in",
			unchecked: "Not checked",
			login: "Sign in",
			check: "Check",
			checking: "Checking…",
			openWindow: "Open",
			closeWindow: "Close",
			loginStarted: "A browser window is open for this account. Finish the sign-in there, then click Check.",
			configTitle: "Plugin settings",
			configDesc: "Values saved here win over the bundle patch and apply to the next call.",
			groupRuntime: "Publish behaviour",
			groupBrowser: "Browser",
			groupProvider: "Proxy API",
			egoPath: "ego lite executable",
			egoPathHint: "Empty auto-detects the installed ego lite.",
			headless: "Headless windows",
			headlessHint: "Keep off for sign-in and for platforms that block headless agents.",
			requireExplicitPublish: "Require explicit publish",
			requireExplicitPublishHint: "On: omitting dryRun means a dry run. Off: omitting dryRun publishes for real.",
			idleCloseMinutes: "Close idle browsers (min)",
			idleCloseMinutesHint: "0 disables the idle sweeper.",
			loginTimeoutSec: "Login wait (s)",
			actionTimeoutMs: "Action timeout (ms)",
			navigationTimeoutMs: "Navigation timeout (ms)",
			pointsRefreshMinutes: "Points refresh (min)",
			pointsRefreshMinutesHint: "0 disables the periodic refresh (default): points are read after a publish check.",
			linkCheckDelayMinutes: "Post-publish check (min)",
			linkCheckDelayMinutesHint: "After a real publish, wait this long, verify the link, then refresh points.",
			flowsTitle: "Publish flows",
			flowsDesc: "Built-in flows ship with the plugin; a user flow with the same id replaces one.",
			flowSteps: "{n} steps",
			sessionsTitle: "Open browsers",
			sessionsDesc: "One isolated ego lite window per account; idle windows close automatically.",
			connected: "Connected",
			connectionFailed: "No connection",
			notProbed: "Not checked",
			checkConnection: "Check connection",
			probing: "Checking…",
			noSessions: "No browser is open.",
			pluginState: "ego lite",
			found: "found",
			missing: "NOT found",
			version: "Version",
			invalidCode: "Pick a code (lowercase letters, digits, . _ -).",
			mediaRequired: "Pick a platform.",
			on: "on",
			off: "off",
			sourceDefault: "default",
			sourcePatch: "plugin config",
			sourceFile: "this page",
			sourceEnv: "environment",
			purgeAccount: "Delete account and sign out",
			proxiesTitle: "Static IPs",
			proxiesDesc: "Add a fixed HTTP/SOCKS proxy once, then assign it to any account.",
			addProxy: "New proxy",
			editProxy: "Edit proxy",
			saveProxy: "Save proxy",
			noProxies: "No proxies yet",
			noProxiesHint: "Add an HTTP or SOCKS5 proxy, test its exit IP, then assign it to accounts.",
			proxyLabel: "Name",
			proxyLabelHint: "Shown when assigning, e.g. “HK-01”.",
			assignedTo: "Used by",
			notAssigned: "not assigned",
			testProxy: "Test",
			testingProxy: "Testing…",
			proxyTested: "Exit IP",
			confirmRemoveProxy: "Delete this proxy? Accounts using it fall back to a direct connection.",
			proxyApiUrl: "Shenlong extraction URL",
			proxyApiUrlHint: "Full URL containing key & sign; stored locally and never shown again.",
			proxyApiWhitelist: "Whitelist this machine",
			proxyApiWhitelistHint: "Add the public IP to the provider whitelist before each extraction.",
			proxyExtract: "Extract proxy",
			proxyExtracting: "Extracting…",
			proxyExtracted: "Added proxies",
			providerTitle: "Add dynamic IP link",
			providerDesc: "Paste the Shenlong extraction link; IPs appear in the dynamic pool with a countdown.",
			providerHint: "Example: http://api.shenlongip.com/ip?key=...&sign=...&count=1&pattern=json&mr=1",
			providerConfigured: "Configured",
			providerNotConfigured: "Not configured",
			providerOpen: "Add link",
			dynamicSourcesTitle: "Dynamic proxy",
			dynamicSourcesDesc: "API links used to extract IPs; each can be edited or removed.",
			addSource: "Add link",
			editSource: "Edit link",
			noSources: "No dynamic proxy link yet.",
			confirmRemoveSource: "Delete this API link?",
			sourceLabel: "Name",
			dynamicPoolTitle: "Dynamic proxy pool",
			dynamicPoolDesc: "IPs extracted on demand; each is valid for a few minutes.",
			dynamicRemaining: "remaining",
			dynamicEmpty: "No live dynamic IP right now — open a dynamic account to extract one.",
			dynamicExpires: "expires",
			directOption: "Direct (no proxy)",
			noProxy: "No proxy",
			noProxyHint: "No proxy assigned — edit to assign one from the pool.",
			proxyModeDynamic: "Dynamic proxy (extract a fresh IP on every launch, 3-minute TTL)",
			dynamicTag: "Dynamic",
			pointsDetail: "Points detail",
			pointsTrendLabel: "Trend",
			pointsHistory: "History",
			refreshPointsNow: "Refresh points",
			trendDown: "falling",
			trendUp: "rising",
			trendFlat: "steady",
			trendUnknown: "unknown",
			proxyLegacy: "This account still uses a legacy inline proxy; choosing Direct or a pool entry replaces it.",
			statsAccounts: "accounts",
			statsSessions: "open",
			statsProxied: "proxied",
			statsFlows: "flows",
			points: "Points",
			pointsRecent30: "30-day points",
			pointsViolation: "violations",
			pointsAt: "updated",
			pointsUnknown: "Not fetched yet — click to fetch",
			pointsWarning: "Points are falling — pause advertising/marketing content",
			pointsFetching: "Reading points…",
			profileReady: "profile ready",
			profileMissing: "profile not created yet",
			pageSubtitle: "Isolated browser profiles, per-account proxies and replayable publish flows.",
		};

		const zh = {
			title: "ego 发稿",
			summary: "通过 ego lite 自动发稿：每个账号一个隔离的浏览器资料、独立代理，以及可回放的发布流程。",
			loading: "正在读取状态…",
			unreachable: "插件路由没有响应：当前部署里插件宿主半可能没有加载。",
			routeMissing: "当前部署的 web 服务没有注册插件的路由。",
			readFailed: "无法读取插件状态。",
			reload: "重新读取",
			refresh: "刷新",
			saved: "已保存。",
			save: "保存",
			saving: "保存中…",
			reset: "恢复默认",
			cancel: "取消",
			remove: "删除",
			confirmRemove: "删除这个账号？它的浏览器资料（Cookie 与登录态）会保留。",
			confirmPurge: "删除这个账号，并一并删除它的浏览器资料（Cookie 与登录态）？",
			tabAccounts: "账号",
			tabProxies: "代理",
			tabConfig: "插件设置",
			tabFlows: "发布流程",
			tabTasks: "任务",
			tasksTitle: "浏览器任务",
			tasksDesc: "通过 AI 对话或本页创建的任务；运行时选择账号，并可指定动态 IP 或静态 IP。",
			taskProxy: "代理",
			taskProxyAccount: "跟随账号",
			taskProxyDynamic: "动态IP",
			taskProxyStatic: "静态IP",
			taskProxyId: "静态代理",
			newTask: "新建任务",
			editTask: "编辑任务",
			noTasks: "还没有任务。",
			runTask: "运行",
			taskRunning: "运行中…",
			taskLastRun: "最近运行",
			taskTitle: "任务名称",
			taskDescription: "说明",
			taskAccount: "账号",
			taskUrl: "起始网址",
			taskScript: "脚本（在页面中执行）",
			confirmRemoveTask: "删除这个任务？",
			tabSessions: "运行窗口",
			accountsTitle: "账号",
			accountsDesc: "每个账号独占一个 ego lite 资料；绑定代理后，它的页面请求只从该代理出口。",
			noAccounts: "还没有账号",
			noAccountsHint: "先新增账号，在它自己的 ego 窗口里登录一次，然后先跑一次演练。",
			addAccount: "新增账号",
			addAccountTitle: "新增账号",
			addAccountHint: "填写账号信息，可选绑定代理，保存即可。所有字段之后都能修改。",
			editAccountTitle: "编辑账号",
			editAccountHint: "修改账号或代理分配，也可以连同浏览器资料一起删除。",
			closeDialog: "关闭对话框",
			sectionIdentity: "账号信息",
			sectionNetwork: "网络",
			loginNamePlaceholder: "手机号 / 登录名",
			loginNameHint: "仅用于本页备注，不影响自动化流程。",
			notePlaceholder: "可选",
			useProxyHint: "代理先到「代理」标签添加；同一个代理可以给多个账号共用。",
			afterSaveHint: "保存后：点「登录」，在该账号自己的 ego 窗口完成扫码，再点「检查」确认。",
			editAccount: "编辑",
			saveAccount: "保存账号",
			code: "账号代号",
			codeHint: "小写字母、数字、. _ -（最多 32 位），同时决定资料目录名。",
			platform: "平台",
			loginName: "登录名",
			note: "备注",
			proxy: "代理",
			proxyServer: "代理服务器",
			proxyServerHint: "http://host:port 或 socks5://host:port；留空表示直连。",
			proxyUser: "代理用户名",
			proxyPassword: "代理密码",
			credentialNote: "代理密码只存本机，保存后不再回显。",
			direct: "直连",
			hasAuth: "带认证",
			signedIn: "已登录",
			signedOut: "未登录",
			unchecked: "未检测",
			login: "登录",
			check: "检查",
			checking: "检查中…",
			openWindow: "打开",
			closeWindow: "关闭",
			loginStarted: "已为该账号打开浏览器窗口：请在那里完成扫码/登录，然后点「检查」。",
			configTitle: "插件设置",
			configDesc: "这里保存的值优先于 bundle patch，从下一次调用起生效。",
			groupRuntime: "发布行为",
			groupBrowser: "浏览器",
			groupProvider: "代理 API",
			egoPath: "ego lite 可执行文件",
			egoPathHint: "留空则自动探测已安装的 ego lite。",
			headless: "无头窗口",
			headlessHint: "登录和会拦截无头浏览器的平台请保持关闭。",
			requireExplicitPublish: "必须显式发布",
			requireExplicitPublishHint: "开启：不传 dryRun 就是演练。关闭：不传 dryRun 会真的发布。",
			idleCloseMinutes: "空闲关闭（分钟）",
			idleCloseMinutesHint: "0 表示不自动回收。",
			loginTimeoutSec: "登录等待（秒）",
			actionTimeoutMs: "单动作超时（毫秒）",
			navigationTimeoutMs: "导航超时（毫秒）",
			pointsRefreshMinutes: "积分定时刷新（分钟）",
			pointsRefreshMinutesHint: "默认 0（关闭）：积分改为发稿后由发布检查读取。",
			linkCheckDelayMinutes: "发稿后检查延迟（分钟）",
			linkCheckDelayMinutesHint: "真实发布后等待这么久，先检查链接是否生效，再刷新积分。",
			flowsTitle: "发布流程",
			flowsDesc: "内置流程随插件发布；同 id 的用户流程会覆盖内置流程。",
			flowSteps: "{n} 步",
			sessionsTitle: "运行中的浏览器",
			sessionsDesc: "每个账号一个隔离的 ego lite 窗口；空闲会被自动关闭。",
			connected: "已连接",
			connectionFailed: "连接失败",
			notProbed: "未检测",
			checkConnection: "点击检测连接",
			probing: "检测中…",
			noSessions: "没有打开的浏览器。",
			pluginState: "ego lite",
			found: "已找到",
			missing: "未找到",
			version: "版本",
			invalidCode: "请填写账号代号（小写字母、数字、. _ -）。",
			mediaRequired: "请选择平台。",
			on: "开",
			off: "关",
			sourceDefault: "默认值",
			sourcePatch: "插件配置",
			sourceFile: "本页保存",
			sourceEnv: "环境变量",
			purgeAccount: "删除账号并退出登录",
			proxiesTitle: "静态IP",
			proxiesDesc: "固定代理只需添加一次，可分配给任意账号；同一代理可多个账号共用。",
			addProxy: "新增代理",
			editProxy: "编辑代理",
			saveProxy: "保存代理",
			noProxies: "还没有代理",
			noProxiesHint: "添加一个 HTTP / SOCKS5 代理，测试出口 IP 后分配给账号。",
			proxyLabel: "名称",
			proxyLabelHint: "分配时显示，例如「香港-01」。",
			assignedTo: "使用账号",
			notAssigned: "未分配",
			testProxy: "测试",
			testingProxy: "测试中…",
			proxyTested: "出口 IP",
			confirmRemoveProxy: "删除这个代理？正在使用它的账号会回退为直连。",
			proxyApiUrl: "神龙提取链接",
			proxyApiUrlHint: "含 key 与 sign 的完整 URL；只存本机，保存后不再回显。",
			proxyApiWhitelist: "自动加白名单",
			proxyApiWhitelistHint: "每次提取前把本机公网 IP 加到神龙白名单。",
			proxyExtract: "提取代理",
			proxyExtracting: "提取中…",
			proxyExtracted: "新增代理",
			providerTitle: "添加动态IP链接",
			providerDesc: "粘贴神龙提取链接；提取到的 IP 会出现在动态代理池并倒计时。",
			providerHint: "示例：http://api.shenlongip.com/ip?key=...&sign=...&count=1&pattern=json&mr=1",
			providerConfigured: "已配置",
			providerNotConfigured: "未配置",
			providerOpen: "添加链接",
			dynamicSourcesTitle: "动态代理",
			dynamicSourcesDesc: "用于提取 IP 的 API 链接，可添加、编辑、删除。",
			addSource: "添加链接",
			editSource: "编辑链接",
			noSources: "还没有动态代理链接。",
			confirmRemoveSource: "删除这个 API 链接？",
			sourceLabel: "名称",
			dynamicPoolTitle: "动态代理池",
			dynamicPoolDesc: "按需提取的 IP，每个只有几分钟有效期。",
			dynamicRemaining: "剩余可用",
			dynamicEmpty: "当前没有可用动态 IP——打开一个动态代理账号即可提取。",
			dynamicExpires: "到期",
			directOption: "直连（不使用代理）",
			noProxy: "未代理",
			noProxyHint: "尚未分配代理——点编辑可从代理池分配。",
			proxyModeDynamic: "动态代理（每次打开自动提取新 IP，3 分钟有效）",
			dynamicTag: "动态",
			pointsDetail: "积分详情",
			pointsTrendLabel: "趋势",
			pointsHistory: "历史",
			refreshPointsNow: "刷新积分",
			trendDown: "下降",
			trendUp: "回升",
			trendFlat: "持平",
			trendUnknown: "未知",
			proxyLegacy: "该账号仍在用旧的内联代理；选择「直连」或某个代理池条目会替换它。",
			statsAccounts: "账号",
			statsSessions: "运行中",
			statsProxied: "已绑代理",
			statsFlows: "流程",
			points: "积分",
			pointsRecent30: "近30日积分",
			pointsViolation: "违规扣分",
			pointsAt: "更新于",
			pointsUnknown: "尚未获取，点击读取",
			pointsWarning: "积分正在走低：建议暂停广告/营销类内容",
			pointsFetching: "读取积分…",
			profileReady: "资料已创建",
			profileMissing: "资料尚未创建",
			pageSubtitle: "隔离的浏览器资料、按账号代理、可回放的发布流程。",
		};

		const STYLES = [
			// page shell
			".ep-page{box-sizing:border-box;flex:1 1 auto;height:100%;overflow:auto;background:var(--dsw-alias-bg-base);}",
			".ep-page .ep-root{max-width:1040px;margin:0 auto;padding:32px 36px 56px;}",
			".ep-root{display:flex;flex-direction:column;gap:20px;font-size:14px;line-height:22px;",
			"color:var(--dsw-alias-label-primary);font-family:inherit;}",
			// hero
			".ep-hero{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;}",
			".ep-hero-icon{display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:44px;height:44px;",
			"border-radius:14px;color:var(--dsw-alias-brand-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);",
			"border:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);}",
			".ep-hero-text{flex:1 1 260px;min-width:0;}",
			".ep-hero-title{margin:2px 0 0;font-size:22px;line-height:30px;font-weight:650;letter-spacing:-.01em;}",
			".ep-hero-sub{margin:6px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}",
			".ep-hero-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px;}",
			".ep-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:12px;",
			"line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".ep-meta code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;",
			"color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);padding:1px 6px;",
			"border-radius:6px;word-break:break-all;}",
			".ep-sep{opacity:.5;}",
			// pills / tags
			".ep-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;",
			"font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);",
			"color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1);white-space:nowrap;}",
			".ep-pill::before{content:\"\";width:6px;height:6px;border-radius:999px;flex:0 0 auto;",
			"background:var(--dsw-alias-state-idle-primary);}",
			".ep-pill-on{color:var(--dsw-alias-state-success-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);",
			"border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);}",
			".ep-pill-on::before{background:var(--dsw-alias-state-success-primary);}",
			".ep-pill-bad{color:var(--dsw-alias-state-error-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);",
			"border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);}",
			".ep-pill-bad::before{background:var(--dsw-alias-state-error-primary);}",
			".ep-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;",
			"font-size:11px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);",
			"border:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);white-space:nowrap;}",
			// stats
			".ep-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;}",
			"@media (max-width:720px){.ep-stats{grid-template-columns:repeat(2,minmax(0,1fr));}}",
			".ep-stat{padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;",
			"background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:2px;}",
			".ep-stat-num{font-size:20px;line-height:26px;font-weight:650;letter-spacing:-.01em;}",
			".ep-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			// tabs
			".ep-tabs{display:inline-flex;gap:2px;padding:3px;border-radius:999px;align-self:flex-start;",
			"background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);}",
			".ep-tab{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 14px;",
			"border:.5px solid transparent;border-radius:999px;background:transparent;font-family:inherit;",
			"font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;}",
			".ep-tab:hover:not(.ep-tab-on){color:var(--dsw-alias-label-primary);}",
			".ep-tab-on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);",
			"color:var(--dsw-alias-label-primary);font-weight:550;}",
			".ep-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;",
			"padding:0 5px;border-radius:999px;font-size:10px;line-height:18px;",
			"background:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}",
			// cards
			".ep-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);",
			"overflow:hidden;}",
			".ep-stack{display:flex;flex-direction:column;gap:12px;}",
			".ep-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px 14px;",
			"flex-wrap:wrap;padding:16px 18px;border-bottom:.5px solid var(--dsw-alias-border-l1);}",
			".ep-card-title{margin:0;font-size:14px;line-height:22px;font-weight:600;}",
			".ep-card-desc{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".ep-head-text{flex:1 1 180px;min-width:0;}",
			".ep-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".ep-grow{flex:1 1 auto;}",
			// buttons
			".ep-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;",
			"height:34px;padding:0 14px;border:.5px solid transparent;border-radius:10px;font-size:13px;",
			"line-height:20px;font-family:inherit;color:var(--dsw-alias-label-primary);background:transparent;",
			"cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease;}",
			".ep-btn:disabled{opacity:.45;cursor:not-allowed;}",
			".ep-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;}",
			".ep-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);",
			"border-color:transparent;}",
			".ep-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}",
			".ep-btn-ghost{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}",
			".ep-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}",
			".ep-btn-quiet{color:var(--dsw-alias-label-secondary);}",
			".ep-btn-quiet:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}",
			".ep-btn-danger{color:var(--dsw-alias-state-error-primary);}",
			".ep-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}",
			".ep-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:8px;}",
			".ep-icon-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;",
			"width:28px;height:28px;padding:0;border:.5px solid transparent;border-radius:8px;background:transparent;",
			"color:var(--dsw-alias-label-tertiary);cursor:pointer;}",
			".ep-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}",
			".ep-icon-btn:disabled{opacity:.45;cursor:not-allowed;}",
			// account rows
			".ep-accounts{display:flex;flex-direction:column;}",
			".ep-account{display:flex;align-items:center;gap:12px;padding:14px 18px;",
			"border-top:.5px solid var(--dsw-alias-border-l1);}",
			".ep-account:first-child{border-top:none;}",
			".ep-account:hover{background:var(--dsw-alias-bg-layer-2);}",
			".ep-avatar{display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:38px;height:38px;",
			"border-radius:12px;font-size:14px;font-weight:650;letter-spacing:.02em;",
			"color:var(--dsw-alias-brand-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);",
			"border:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);}",
			".ep-account-main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:3px;}",
			".ep-account-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;line-height:22px;",
			"font-weight:550;}",
			".ep-account-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;",
			"color:var(--dsw-alias-label-tertiary);}",
			".ep-account-sub code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;",
			"color:var(--dsw-alias-label-secondary);}",
			".ep-account-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;}",
			".ep-session-net{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;}",
			".ep-conn{font-family:inherit;cursor:pointer;gap:5px;}",
			".ep-conn::before{display:none;}",
			".ep-conn:disabled{opacity:.7;cursor:default;}",
			".ep-conn-dot{width:7px;height:7px;border-radius:999px;flex:0 0 auto;",
			"background:var(--dsw-alias-state-idle-primary);}",
			".ep-conn svg{flex:0 0 auto;}",
			".ep-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;}",
			// empty state
			".ep-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 24px;text-align:center;}",
			".ep-empty-icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;",
			"border-radius:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);}",
			".ep-empty-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);}",
			".ep-empty-text{max-width:420px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			// forms
			".ep-form{display:flex;flex-direction:column;gap:14px;padding:18px;border-top:.5px solid var(--dsw-alias-border-l1);",
			"background:var(--dsw-alias-bg-layer-2);}",
			".ep-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px 14px;}",
			".ep-field-full{grid-column:1/-1;}",
			".ep-item{display:flex;flex-direction:column;gap:5px;min-width:0;}",
			".ep-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:500;}",
			".ep-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
			".ep-input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;font-family:inherit;font-size:13px;",
			"line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);",
			"border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;outline:none;transition:border-color .12s ease;}",
			".ep-input:focus{border-color:var(--dsw-alias-state-business-primary);",
			"box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);}",
			".ep-input::placeholder{color:var(--dsw-alias-label-dimmed);}",
			".ep-input:disabled{opacity:.55;cursor:not-allowed;}",
			".ep-select{box-sizing:border-box;width:100%;height:34px;padding:0 8px;font-family:inherit;font-size:13px;",
			"color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);",
			"border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;outline:none;}",
			".ep-select:focus{border-color:var(--dsw-alias-state-business-primary);}",
			".ep-select-xs{width:auto;max-width:190px;height:26px;font-size:12px;line-height:18px;border-radius:7px;",
			"padding:0 6px;background:var(--dsw-alias-bg-layer-2);}",
			".ep-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".ep-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;",
			"color:var(--dsw-alias-label-primary);cursor:pointer;}",
			".ep-check input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);",
			"cursor:inherit;}",
			// settings rows
			".ep-rows{display:flex;flex-direction:column;}",
			".ep-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 18px;",
			"border-top:.5px solid var(--dsw-alias-border-l1);}",
			".ep-row:first-child{border-top:none;}",
			".ep-row-text{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:2px;}",
			".ep-row-label{font-size:13px;line-height:20px;font-weight:500;}",
			".ep-row-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
			".ep-row-control{flex:0 1 300px;display:flex;align-items:center;justify-content:flex-end;gap:8px;}",
			".ep-row-control .ep-input{max-width:280px;}",
			".ep-source{flex:0 0 auto;font-size:10px;line-height:16px;padding:1px 7px;border-radius:999px;",
			"background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);",
			"border:.5px solid var(--dsw-alias-border-l1);}",
			".ep-source-own{color:var(--dsw-alias-brand-primary);",
			"border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);}",
			// banners
			".ep-banner{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;",
			"font-size:12px;line-height:18px;border:.5px solid transparent;}",
			".ep-banner-ok{color:var(--dsw-alias-state-success-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent);",
			"border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 24%,transparent);}",
			".ep-banner-error{color:var(--dsw-alias-state-error-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);",
			"border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,transparent);}",
			".ep-banner-warn{color:var(--dsw-alias-state-warn-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);",
			"border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 26%,transparent);}",
			".ep-points{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:999px;",
			"font-family:inherit;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l1);",
			"background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;}",
			".ep-points:hover:not(:disabled){color:var(--dsw-alias-label-primary);}",
			".ep-points:disabled{opacity:.6;cursor:default;}",
			".ep-points-bad{color:var(--dsw-alias-state-error-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);",
			"border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);}",
			".ep-points-good{color:var(--dsw-alias-state-success-primary);",
			"background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);",
			"border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);}",
			".ep-tag-muted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);",
			"border-color:var(--dsw-alias-border-l1);}",
			".ep-points-panel{display:flex;flex-direction:column;gap:10px;padding:12px;",
			"border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);}",
			".ep-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;}",
			".ep-detail{display:flex;flex-direction:column;gap:2px;}",
			".ep-detail-k{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
			".ep-detail-v{font-size:14px;line-height:20px;font-weight:600;}",
			".ep-detail-bad{color:var(--dsw-alias-state-error-primary);}",
			".ep-detail-comps{display:flex;flex-wrap:wrap;gap:6px;}",
			".ep-history{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all;}",
			// modal
			".ep-modal-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;",
			"padding:24px;background:rgba(10,12,18,.46);animation:ep-fade .12s ease;}",
			".ep-modal{display:flex;flex-direction:column;width:min(600px,100%);max-height:min(88vh,780px);",
			"border-radius:18px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);",
			"box-shadow:0 28px 72px rgba(0,0,0,.3);overflow:hidden;animation:ep-pop .16s cubic-bezier(.2,.8,.3,1);}",
			".ep-modal-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 14px;}",
			".ep-modal-icon{width:38px;height:38px;border-radius:12px;}",
			".ep-modal-heading{flex:1 1 auto;min-width:0;}",
			".ep-modal-title{margin:1px 0 0;font-size:17px;line-height:24px;font-weight:650;letter-spacing:-.01em;}",
			".ep-modal-sub{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".ep-modal-body{display:flex;flex-direction:column;gap:12px;padding:4px 20px 18px;overflow:auto;}",
			".ep-section-label{margin-top:6px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;",
			"text-transform:uppercase;color:var(--dsw-alias-label-tertiary);}",
			".ep-grid-modal{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));}",
			".ep-required{margin-left:3px;color:var(--dsw-alias-state-error-primary);}",
			".ep-modal-tip{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;",
			"font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);",
			"border:.5px solid var(--dsw-alias-border-l1);}",
			".ep-modal-tip svg{flex:0 0 auto;margin-top:1px;color:var(--dsw-alias-brand-primary);}",
			".ep-modal-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:14px 20px;",
			"border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}",
			"@keyframes ep-fade{from{opacity:0}to{opacity:1}}",
			"@keyframes ep-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}",
			"@media (max-width:520px){.ep-modal-backdrop{padding:12px;align-items:flex-end}",
			".ep-modal{max-height:92vh;border-radius:16px}}",
			// lists
			".ep-list{display:flex;flex-direction:column;}",
			".ep-list-row{display:flex;align-items:center;gap:12px;padding:13px 18px;",
			"border-top:.5px solid var(--dsw-alias-border-l1);}",
			".ep-list-row:first-child{border-top:none;}",
			".ep-list-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}",
			".ep-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;",
			"color:var(--dsw-alias-label-secondary);word-break:break-all;}",
			".ep-dim{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".ep-loading{display:flex;align-items:center;gap:10px;padding:40px 8px;color:var(--dsw-alias-label-tertiary);",
			"font-size:13px;}",
			".ep-spinner{width:16px;height:16px;border-radius:999px;border:2px solid var(--dsw-alias-border-l2);",
			"border-top-color:var(--dsw-alias-brand-primary);animation:ep-spin .8s linear infinite;}",
			"@keyframes ep-spin{to{transform:rotate(360deg)}}",
		].join("");

		const CONFIG_FIELDS = [
			{ key: "requireExplicitPublish", type: "bool", group: "runtime", hint: "requireExplicitPublishHint" },
			{ key: "idleCloseMinutes", type: "number", group: "runtime", hint: "idleCloseMinutesHint" },
			{ key: "loginTimeoutSec", type: "number", group: "runtime" },
			{ key: "actionTimeoutMs", type: "number", group: "runtime" },
			{ key: "navigationTimeoutMs", type: "number", group: "runtime" },
			{ key: "pointsRefreshMinutes", type: "number", group: "runtime", hint: "pointsRefreshMinutesHint" },
			{ key: "linkCheckDelayMinutes", type: "number", group: "runtime", hint: "linkCheckDelayMinutesHint" },
			{ key: "proxyApiUrl", type: "text", group: "provider", hint: "proxyApiUrlHint" },
			{ key: "proxyApiWhitelist", type: "bool", group: "provider", hint: "proxyApiWhitelistHint" },
			{ key: "egoPath", type: "text", group: "browser", hint: "egoPathHint" },
			{ key: "headless", type: "bool", group: "browser", hint: "headlessHint" },
		];

		async function callRoute(path, init = {}) {
			const headers = { accept: "application/json" };
			const request = { method: init.method ?? "GET", headers, credentials: "same-origin" };
			if (init.body !== undefined) {
				headers["content-type"] = "application/json";
				request.body = JSON.stringify(init.body);
			}
			try {
				const response = await fetch(path, request);
				let payload = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				return { status: response.status, ok: response.ok, payload };
			} catch (error) {
				return { status: 0, ok: false, payload: null, transport: String((error && error.message) || error) };
			}
		}

		function failureText(t, result) {
			if (result.status === 0) return `${t("unreachable")} (${result.transport})`;
			if (result.status === 404) return t("routeMissing");
			const message = result.payload && result.payload.error && result.payload.error.message;
			if (message) return String(message);
			return `${t("readFailed")} (HTTP ${result.status})`;
		}

		function h(type, props, ...children) {
			return React.createElement(type, props, ...children);
		}

		function cls(...values) {
			return values.filter(Boolean).join(" ");
		}

		function Icon({ name, size = 16 }) {
			const common = {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			};
			const paths = {
				plus: [h("path", { key: "a", d: "M12 5v14M5 12h14" })],
				refresh: [h("path", { key: "a", d: "M21 12a9 9 0 1 1-2.64-6.36" }), h("path", { key: "b", d: "M21 3v6h-6" })],
				login: [h("path", { key: "a", d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" }), h("path", { key: "b", d: "M10 17l5-5-5-5M15 12H3" })],
				check: [h("path", { key: "a", d: "M20 6 9 17l-5-5" })],
				window: [h("rect", { key: "a", x: 3, y: 4, width: 18, height: 16, rx: 2.5 }), h("path", { key: "b", d: "M3 9h18" })],
				edit: [h("path", { key: "a", d: "M12 20h9" }), h("path", { key: "b", d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" })],
				trash: [h("path", { key: "a", d: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" })],
				flow: [h("path", { key: "a", d: "M4 6h10M4 12h16M4 18h7" }), h("circle", { key: "b", cx: 18, cy: 6, r: 2 }), h("circle", { key: "c", cx: 15, cy: 18, r: 2 })],
				terminal: [h("rect", { key: "a", x: 3, y: 4, width: 18, height: 16, rx: 2.5 }), h("path", { key: "b", d: "m7 9 3 3-3 3M13 15h4" })],
				shield: [h("path", { key: "a", d: "M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z" }), h("path", { key: "b", d: "m9 12 2 2 4-4" })],
				close: [h("path", { key: "a", d: "M6 6l12 12M18 6 6 18" })],
				alert: [h("path", { key: "a", d: "M12 3 2.5 20h19Z" }), h("path", { key: "b", d: "M12 9v5M12 17h.01" })],
				spark: [h("path", { key: "a", d: "M12 3v3.5M12 17.5V21M3.5 12H7M17 12h3.5M6 6l2.4 2.4M15.6 15.6 18 18M18 6l-2.4 2.4M8.4 15.6 6 18" })],
			};
			return h("svg", common, paths[name] || paths.plus);
		}

		function BrandGlyph({ size = 18 }) {
			return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
				h("rect", { x: 2.5, y: 3.5, width: 19, height: 15, rx: 3, stroke: "currentColor", strokeWidth: 1.6 }),
				h("path", { d: "M2.5 8.5h19", stroke: "currentColor", strokeWidth: 1.6, opacity: 0.75 }),
				h("path", { d: "M16.2 13.2l4.2 1.9-1.9.8-.8 1.9z", fill: "currentColor", stroke: "currentColor", strokeWidth: 1.1, strokeLinejoin: "round" }),
				h("path", { d: "M6 12.2h5M6 15.6h3", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", opacity: 0.75 }),
			);
		}

		function ActionButton({ label, onClick, disabled, icon, tone, primary }) {
			return h("button", {
				type: "button",
				className: cls("ep-btn", "ep-btn-sm", primary ? "ep-btn-primary" : "ep-btn-ghost", tone === "danger" ? "ep-btn-danger" : null),
				onClick,
				disabled,
				title: label,
			}, icon ? h(Icon, { name: icon, size: 14 }) : null, label);
		}

		function IconButton({ label, onClick, icon, disabled, tone }) {
			return h("button", {
				type: "button",
				className: cls("ep-icon-btn", tone === "danger" ? "ep-btn-danger" : null),
				onClick,
				disabled,
				title: label,
				"aria-label": label,
			}, h(Icon, { name: icon, size: 15 }));
		}

		function Stat({ value, label }) {
			return h("div", { className: "ep-stat" },
				h("span", { className: "ep-stat-num" }, String(value)),
				h("span", { className: "ep-stat-label" }, label),
			);
		}

		/**
		 * Body shared by the Settings seats and the main panel.
		 * @param {{ view?: 'summary'|'page', page?: boolean, t?: Function }} props
		 */
		function EgoPublishBody(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const isSummary = props.view === "summary";
			const [state, setState] = React.useState({
				phase: "idle",
				data: null,
				error: null,
				notice: null,
				busy: null,
				tab: "accounts",
				modalOpen: false,
				editing: null,
				autoProbed: {},
				form: { code: "", media: "sohu", account: "", note: "", proxyId: "", proxyMode: "static" },
				proxyFormOpen: false,
				proxyEditing: null,
				proxyForm: { label: "", server: "", username: "", password: "" },
				providerOpen: false,
				providerId: "",
				providerLabel: "",
				providerValue: "",
				taskOpen: false,
				taskForm: { id: "", title: "", description: "", accountCode: "", url: "", script: "", proxyMode: "account", proxyId: "" },
				draft: null,
				draftDirty: false,
			});

			const load = React.useCallback(async () => {
				setState((s) => ({ ...s, phase: s.data ? "ready" : "loading", error: null }));
				const result = await callRoute(ROUTES.status);
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, phase: "error", error: failureText(t, result) }));
					return;
				}
				setState((s) => ({
					...s,
					phase: "ready",
					data: result.payload,
					error: null,
					draft: s.draftDirty ? s.draft : { ...result.payload.config.values },
				}));
			}, [t]);

			React.useEffect(() => {
				if (isSummary || state.phase !== "idle") return undefined;
				void load();
				return undefined;
			}, [isSummary, state.phase, load]);

			// While the account dialog is open: Escape closes it and the page behind does not scroll.
			React.useEffect(() => {
				if (!state.modalOpen) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") closeForm();
				};
				let previousOverflow = "";
				try {
					previousOverflow = document.body.style.overflow;
					document.body.style.overflow = "hidden";
				} catch {
					/* no document */
				}
				if (typeof window !== "undefined") window.addEventListener("keydown", onKey);
				return () => {
					if (typeof window !== "undefined") window.removeEventListener("keydown", onKey);
					try {
						document.body.style.overflow = previousOverflow;
					} catch {
						/* no document */
					}
				};
			}, [state.modalOpen]);

			// When the Open browsers tab is shown, probe sessions that have no cached result yet.
			React.useEffect(() => {
				if (isSummary || state.phase !== "ready" || state.tab !== "sessions" || !state.data) return undefined;
				const pendingSessions = (state.data.sessions || []).filter((item) => !item.connectivity && !(state.autoProbed || {})[item.accountCode]);
				if (!pendingSessions.length) return undefined;
				const probed = { ...(state.autoProbed || {}) };
				for (const item of pendingSessions) probed[item.accountCode] = true;
				setState((s) => ({ ...s, autoProbed: { ...(s.autoProbed || {}), ...probed } }));
				let cancelled = false;
				(async () => {
					for (const item of pendingSessions) {
						if (cancelled) return;
						await callRoute(ROUTES.session, { method: "POST", body: { op: "probe", code: item.accountCode } });
					}
					if (!cancelled) await load();
				})();
				return () => { cancelled = true; };
			}, [isSummary, state.phase, state.tab, state.data]);

			if (isSummary) {
				return h("div", { className: "ep-root" },
					h("div", { className: "ep-hero" },
						h("div", { className: "ep-hero-icon" }, h(BrandGlyph, { size: 24 })),
						h("div", { className: "ep-hero-text" },
							h("h3", { className: "ep-hero-title" }, t("title")),
							h("p", { className: "ep-hero-sub" }, t("summary")),
						),
					),
				);
			}

			const data = state.data;
			const busy = state.busy;
			const accounts = (data && data.accounts) || [];
			const proxies = (data && data.proxies) || [];
			const sessions = (data && data.sessions) || [];
			const flows = (data && data.flows) || [];
			const tasks = (data && data.tasks) || [];
			const mediaOptions = (data && data.media) || [];
			const proxied = accounts.filter((account) => account.proxy && account.proxy.server).length;
			const falling = accounts.filter((account) => account.points?.trend === "down");

			async function act(key, path, body, okMessage) {
				setState((s) => ({ ...s, busy: key, error: null, notice: null }));
				const result = await callRoute(path, { method: "POST", body });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return null;
				}
				setState((s) => ({ ...s, busy: null, notice: okMessage || null }));
				await load();
				return result.payload;
			}

			function openAddForm() {
				setState((s) => ({
					...s,
					tab: "accounts",
					modalOpen: true,
					step: 1,
					editing: null,
					error: null,
					form: {
						code: "",
						media: (mediaOptions[0] && mediaOptions[0].key) || "sohu",
						account: "",
						note: "",
						proxyId: "",
						proxyMode: "static",
					},
				}));
			}

			function openEditForm(account) {
				setState((s) => ({
					...s,
					modalOpen: true,
					step: 1,
					editing: account.code,
					error: null,
					form: {
						code: account.code,
						media: account.media,
						account: account.account || "",
						note: account.note || "",
						proxyId: account.proxyId || "",
						proxyMode: account.proxyMode || "static",
					},
				}));
			}

			function closeForm() {
				setState((s) => ({ ...s, modalOpen: false, step: 1, editing: null, error: null }));
			}

			function setField(key, value) {
				setState((s) => ({ ...s, form: { ...s.form, [key]: value }, error: null }));
			}

			/** Validate step 1 before letting the dialog advance. */
			function stepOneValid() {
				const form = state.form;
				if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(form.code)) {
					setState((s) => ({ ...s, error: t("invalidCode") }));
					return false;
				}
				if (!form.media) {
					setState((s) => ({ ...s, error: t("mediaRequired") }));
					return false;
				}
				return true;
			}

			async function submitForm() {
				if (!stepOneValid()) return;
				const form = state.form;
				const payload = await act("save-account", ROUTES.accounts, {
					op: "upsert",
					code: form.code,
					media: form.media,
					account: form.account,
					note: form.note,
					proxyId: form.proxyMode === "dynamic" ? null : (form.proxyId === "__legacy" ? undefined : (form.proxyId || null)),
					proxyMode: form.proxyMode,
				}, t("saved"));
				if (payload) closeForm();
			}

			async function removeAccount(account, purge) {
				const ok = typeof window === "undefined" || !window.confirm
					? true
					: window.confirm(purge ? t("confirmPurge") : t("confirmRemove"));
				if (!ok) return;
				await act(`remove-${account.code}`, ROUTES.accounts, { op: "remove", code: account.code, removeProfile: purge === true }, t("saved"));
			}

			async function login(account) {
				setState((s) => ({ ...s, busy: `login-${account.code}`, error: null, notice: null }));
				const result = await callRoute(ROUTES.login, { method: "POST", body: { code: account.code } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({ ...s, busy: null, notice: result.payload.message || t("loginStarted") }));
				await load();
			}

			async function check(account) {
				setState((s) => ({ ...s, busy: `check-${account.code}`, error: null, notice: null }));
				const result = await callRoute(ROUTES.check, { method: "POST", body: { code: account.code } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({ ...s, busy: null, notice: result.payload.message || t("saved") }));
				await load();
			}

			async function session(account, op) {
				await act(`${op}-${account.code}`, ROUTES.session, { op, code: account.code }, op === "open" ? t("loginStarted") : t("saved"));
			}

			async function probeSession(item) {
				setState((s) => ({ ...s, busy: `probe-${item.accountCode}`, error: null }));
				const result = await callRoute(ROUTES.session, { method: "POST", body: { op: "probe", code: item.accountCode } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({ ...s, busy: null }));
				await load();
			}

			function setDraft(key, value) {
				setState((s) => ({ ...s, draft: { ...(s.draft || {}), [key]: value }, draftDirty: true }));
			}

			async function saveConfig() {
				const values = {};
				for (const field of CONFIG_FIELDS) {
					const value = state.draft ? state.draft[field.key] : undefined;
					if (field.type === "number") {
						const parsed = Number(value);
						if (Number.isFinite(parsed)) values[field.key] = parsed;
					} else if (field.type === "bool") {
						values[field.key] = value === true;
					} else {
						values[field.key] = value === undefined || value === null || String(value).trim() === "" ? null : String(value).trim();
					}
				}
				const payload = await act("save-config", ROUTES.config, { values }, t("saved"));
				if (payload) setState((s) => ({ ...s, draftDirty: false }));
			}

			async function resetConfig() {
				const payload = await act("reset-config", ROUTES.configReset, { names: CONFIG_FIELDS.map((field) => field.key) }, t("saved"));
				if (payload) setState((s) => ({ ...s, draftDirty: false }));
			}

			function statusPill(account) {
				const check = account.lastCheck;
				if (!check) return h("span", { className: "ep-pill" }, t("unchecked"));
				if (check.ok) return h("span", { className: "ep-pill ep-pill-on" }, t("signedIn"));
				return h("span", { className: "ep-pill ep-pill-bad" }, t("signedOut"));
			}

			// ---- proxy pool -------------------------------------------------------------------------

			function openProxyForm(entry) {
				setState((s) => ({
					...s,
					tab: "proxies",
					proxyFormOpen: true,
					proxyEditing: entry ? entry.id : null,
					error: null,
					proxyForm: entry
						? { label: entry.label || "", server: entry.server || "", username: entry.username || "", password: "" }
						: { label: "", server: "", username: "", password: "" },
				}));
			}

			function closeProxyForm() {
				setState((s) => ({ ...s, proxyFormOpen: false, proxyEditing: null }));
			}

			function setProxyField(key, value) {
				setState((s) => ({ ...s, proxyForm: { ...s.proxyForm, [key]: value } }));
			}

			async function submitProxy() {
				const form = state.proxyForm;
				if (!String(form.server).trim()) {
					setState((s) => ({ ...s, error: t("proxyServerHint") }));
					return;
				}
				const body = state.proxyEditing
					? {
						op: "update",
						id: state.proxyEditing,
						label: form.label,
						server: form.server,
						username: form.username,
						...(form.password ? { password: form.password } : {}),
					}
					: { op: "add", label: form.label, server: form.server, username: form.username, password: form.password };
				const payload = await act(state.proxyEditing ? "update-proxy" : "add-proxy", ROUTES.proxies, body, t("saved"));
				if (payload) closeProxyForm();
			}

			async function testProxyEntry(entry) {
				setState((s) => ({ ...s, busy: `test-proxy-${entry.id}`, error: null, notice: null }));
				const result = await callRoute(ROUTES.proxies, { method: "POST", body: { op: "test", id: entry.id } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				const ip = result.payload.result?.ip ?? "?";
				setState((s) => ({ ...s, busy: null, notice: `${t("proxyTested")} ${ip}` }));
				await load();
			}

			async function removeProxy(entry) {
				const ok = typeof window === "undefined" || !window.confirm ? true : window.confirm(t("confirmRemoveProxy"));
				if (!ok) return;
				await act(`remove-proxy-${entry.id}`, ROUTES.proxies, { op: "remove", id: entry.id }, t("saved"));
			}

			async function assignProxy(account, id) {
				setState((s) => ({ ...s, busy: `assign-${account.code}`, error: null, notice: null }));
				const result = await callRoute(ROUTES.proxies, { method: "POST", body: { op: "assign", code: account.code, id: id || null } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({ ...s, busy: null, notice: t("saved") }));
				await load();
			}

			function openProviderModal(source) {
				setState((s) => ({
					...s,
					providerOpen: true,
					providerId: source?.id || "",
					providerLabel: source?.label || "",
					providerValue: "",
					error: null,
				}));
			}

			function closeProviderModal() {
				setState((s) => ({ ...s, providerOpen: false, providerValue: "" }));
			}

			async function saveProvider() {
				const value = state.providerValue.trim();
				if (!value) {
					setState((s) => ({ ...s, error: t("providerHint") }));
					return;
				}
				const result = await callRoute(ROUTES.sources, { method: "POST", body: { op: "save", id: state.providerId || undefined, label: state.providerLabel, url: value } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({ ...s, providerOpen: false, providerValue: "", notice: t("saved") }));
				await load();
			}

			async function removeSource(source) {
				const ok = typeof window === "undefined" || !window.confirm ? true : window.confirm(t("confirmRemoveSource"));
				if (!ok) return;
				await callRoute(ROUTES.sources, { method: "POST", body: { op: "remove", id: source.id } });
				await load();
			}

			function providerModal() {
				if (!state.providerOpen) return null;
				return h("div", { className: "ep-modal-backdrop", onClick: (event) => { if (event.target === event.currentTarget) closeProviderModal(); } },
					h("div", { className: "ep-modal", role: "dialog", "aria-modal": "true" },
						h("div", { className: "ep-modal-head" },
							h("div", { className: "ep-hero-icon ep-modal-icon" }, h(Icon, { name: "shield", size: 20 })),
							h("div", { className: "ep-modal-heading" },
								h("h3", { className: "ep-modal-title" }, t("providerTitle")),
								h("p", { className: "ep-modal-sub" }, t("providerDesc")),
							),
							h("button", { type: "button", className: "ep-icon-btn", onClick: closeProviderModal }, h(Icon, { name: "close", size: 16 })),
						),
						h("div", { className: "ep-modal-body" },
							h("label", { className: "ep-item" },
								h("span", { className: "ep-label" }, t("proxyApiUrl")),
								h("input", {
									className: "ep-input",
									value: state.providerValue,
									placeholder: "http://api.shenlongip.com/ip?key=...&sign=...&count=1&pattern=json&mr=1",
									autoFocus: true,
									onChange: (event) => setState((s) => ({ ...s, providerValue: event.target.value })),
								}),
								h("span", { className: "ep-hint" }, t("providerHint")),
							),
							state.error ? h("div", { className: "ep-banner ep-banner-error" }, state.error) : null,
						),
						h("div", { className: "ep-modal-foot" },
							h("span", { className: "ep-grow" }),
							h("button", { type: "button", className: "ep-btn ep-btn-ghost", onClick: closeProviderModal }, t("cancel")),
							h("button", { type: "button", className: "ep-btn ep-btn-primary", onClick: saveProvider }, t("save")),
						),
					),
				);
			}

			async function extractProxy() {				setState((s) => ({ ...s, busy: "extract-proxy", error: null, notice: null }));
				const result = await callRoute(ROUTES.proxyExtract, { method: "POST", body: { count: 1 } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				const added = result.payload.added?.length ?? 0;
				setState((s) => ({ ...s, busy: null, notice: `${t("proxyExtracted")}: ${added}` }));
				await load();
			}

			async function refreshPoints(account) {				setState((s) => ({ ...s, busy: `points-${account.code}`, error: null, notice: null }));
				const result = await callRoute(ROUTES.points, { method: "POST", body: { code: account.code } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({
					...s,
					busy: null,
					notice: `${account.code} ${t("points")} ${result.payload.points?.value ?? "—"}`,
				}));
				await load();
			}

			function pointsChip(account) {
				const pts = account.points;
				const fetching = busy === `points-${account.code}`;
				const trend = pts?.trend ?? "unknown";
				const tone = trend === "down" ? " ep-points-bad" : trend === "up" ? " ep-points-good" : "";
				const arrow = trend === "down" ? " ↓" : trend === "up" ? " ↑" : trend === "flat" ? " →" : "";
				const value = pts?.value;
				const label = fetching
					? t("pointsFetching")
					: value === undefined || value === null
						? `${t("points")} —`
						: `${t("points")} ${value}${arrow}`;
				const title = pts
					? `${t("points")} ${pts.value} · ${t("pointsRecent30")} ${pts.recent30 ?? "—"} · ${t("pointsAt")} ${pts.at ? new Date(pts.at).toLocaleString() : "—"}${pts.error ? ` · ${pts.error}` : ""}`
					: t("pointsUnknown");
				return h("button", {
					type: "button",
					className: `ep-points${tone}`,
					title,
					onClick: () => refreshPoints(account),
					disabled: fetching,
				}, label);
			}

			function accountRow(account) {
				const label = String(account.label || account.media || "");
				const initials = String(account.code || "?").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
				const proxyText = account.proxy && account.proxy.server ? account.proxy.server : t("direct");
				const dynamicIp = ((data && data.dynamic && data.dynamic.ips) || []).find((item) => item.accountCode === account.code);
				return h("div", { className: "ep-account", key: account.code },
					h("div", { className: "ep-avatar", "aria-hidden": "true" }, initials),
					h("div", { className: "ep-account-main" },
						h("div", { className: "ep-account-title" },
							h("span", { className: "ep-code" }, account.code),
							h("span", { className: "ep-tag" }, label),
							statusPill(account),
							pointsChip(account),
						),
						h("div", { className: "ep-account-sub" },
							h("span", null, account.account || "—"),
							h("span", { className: "ep-sep" }, "·"),
							h("span", {
								className: cls("ep-tag", account.proxyId ? null : "ep-tag-muted"),
								title: account.proxy ? account.proxy.server : t("noProxyHint"),
							}, account.proxyMode === "dynamic"
								? (dynamicIp ? `${dynamicIp.server} · ${dynamicIp.remainingSeconds}s` : t("dynamicTag"))
								: (account.proxyId || t("noProxy"))),
							h("span", { className: "ep-sep" }, "·"),
							h("span", null, account.hasProfile ? t("profileReady") : t("profileMissing")),
						),
					),
					h("div", { className: "ep-account-actions" },
						h(ActionButton, { label: t("login"), icon: "login", onClick: () => login(account), disabled: busy === `login-${account.code}` }),
						h(ActionButton, { label: busy === `check-${account.code}` ? t("checking") : t("check"), icon: "check", onClick: () => check(account), disabled: busy === `check-${account.code}` }),
						h(ActionButton, { label: t("openWindow"), icon: "window", onClick: () => session(account, "open"), disabled: busy === `open-${account.code}` }),
						h(IconButton, { label: t("editAccount"), icon: "edit", onClick: () => openEditForm(account) }),
						h(IconButton, { label: t("remove"), icon: "trash", tone: "danger", onClick: () => removeAccount(account, false), disabled: busy === `remove-${account.code}` }),
					),
				);
			}

			/** The guided account dialog: overlay + header + fields + next-step hint + actions. */
			function accountModal() {
				if (!state.modalOpen) return null;
				const form = state.form;
				const editingAccount = state.editing ? accounts.find((item) => item.code === state.editing) : null;
				const hasLegacyProxy = Boolean(editingAccount && editingAccount.proxy && !editingAccount.proxyId);
				const title = state.editing ? t("editAccountTitle") : t("addAccountTitle");
				const subtitle = state.editing ? t("editAccountHint") : t("addAccountHint");
				return h("div", {
					className: "ep-modal-backdrop",
					onClick: (event) => {
						if (event.target === event.currentTarget) closeForm();
					},
				},
					h("div", {
						className: "ep-modal",
						role: "dialog",
						"aria-modal": "true",
						"aria-labelledby": "ep-account-dialog-title",
						onClick: (event) => event.stopPropagation(),
					},
						h("div", { className: "ep-modal-head" },
							h("div", { className: "ep-hero-icon ep-modal-icon" }, h(BrandGlyph, { size: 22 })),
							h("div", { className: "ep-modal-heading" },
								h("h3", { id: "ep-account-dialog-title", className: "ep-modal-title" }, title),
								h("p", { className: "ep-modal-sub" }, subtitle),
							),
							h("button", {
								type: "button",
								className: "ep-icon-btn",
								onClick: closeForm,
								"aria-label": t("closeDialog"),
							}, h(Icon, { name: "close", size: 16 })),
						),
						h("div", { className: "ep-modal-body" },
							h("div", { className: "ep-section-label" }, t("sectionIdentity")),
							h("div", { className: "ep-grid ep-grid-modal" },
								h("label", { className: "ep-item" },
									h("span", { className: "ep-label" }, t("code"), h("span", { className: "ep-required" }, "*")),
									h("input", {
										className: "ep-input",
										value: form.code,
										disabled: Boolean(state.editing),
										maxLength: 32,
										placeholder: "a-1",
										autoFocus: true,
										onChange: (event) => setField("code", String(event.target.value || "").toLowerCase()),
									}),
									h("span", { className: "ep-hint" }, t("codeHint")),
								),
								h("label", { className: "ep-item" },
									h("span", { className: "ep-label" }, t("platform"), h("span", { className: "ep-required" }, "*")),
									h("select", {
										className: "ep-select",
										value: form.media,
										onChange: (event) => setField("media", event.target.value),
									}, mediaOptions.map((option) => h("option", { key: option.key, value: option.key }, option.label))),
								),
								h("label", { className: "ep-item" },
									h("span", { className: "ep-label" }, t("loginName")),
									h("input", {
										className: "ep-input",
										value: form.account,
										placeholder: t("loginNamePlaceholder"),
										onChange: (event) => setField("account", event.target.value),
									}),
									h("span", { className: "ep-hint" }, t("loginNameHint")),
								),
								h("label", { className: "ep-item" },
									h("span", { className: "ep-label" }, t("note")),
									h("input", {
										className: "ep-input",
										value: form.note,
										placeholder: t("notePlaceholder"),
										onChange: (event) => setField("note", event.target.value),
									}),
								),
							),
							h("div", { className: "ep-section-label" }, t("sectionNetwork")),
							h("div", { className: "ep-grid ep-grid-modal" },
								h("label", { className: "ep-check ep-field-full" },
									h("input", {
										type: "checkbox",
										checked: form.proxyMode === "dynamic",
										onChange: (event) => setField("proxyMode", event.target.checked ? "dynamic" : "static"),
									}),
									h("span", null, t("proxyModeDynamic")),
								),
								h("label", { className: "ep-item" },
									h("span", { className: "ep-label" }, t("useProxy")),
									h("select", {
										className: "ep-select",
										disabled: form.proxyMode === "dynamic",
										value: form.proxyId || (hasLegacyProxy ? "__legacy" : ""),
										onChange: (event) => setField("proxyId", event.target.value),
									},
										h("option", { value: "" }, t("directOption")),
										hasLegacyProxy && editingAccount
											? h("option", { value: "__legacy" }, `${editingAccount.proxy.server}`)
											: null,
										proxies.map((entry) => h("option", { key: entry.id, value: entry.id },
											`${entry.label} · ${entry.server}${entry.hasAuth ? ` (${t("hasAuth")})` : ""}`)),
									),
									h("span", { className: "ep-hint" }, t("useProxyHint")),
									state.editing && hasLegacyProxy ? h("span", { className: "ep-hint" }, t("proxyLegacy")) : null,
								),
							),
							state.editing && editingAccount
								? h("div", { className: "ep-points-panel" },
									h("div", { className: "ep-section-label" }, t("pointsDetail")),
									editingAccount.points
										? h("div", null,
											h("div", { className: "ep-detail-grid" },
												h("div", { className: "ep-detail" }, h("span", { className: "ep-detail-k" }, t("points")), h("span", { className: "ep-detail-v" }, String(editingAccount.points.value))),
												h("div", { className: "ep-detail" }, h("span", { className: "ep-detail-k" }, t("pointsRecent30")), h("span", { className: "ep-detail-v" }, String(editingAccount.points.recent30 ?? "—"))),
												h("div", { className: "ep-detail" }, h("span", { className: "ep-detail-k" }, t("pointsTrendLabel")), h("span", { className: `ep-detail-v${editingAccount.points.trend === "down" ? " ep-detail-bad" : ""}` },
													t(`trend${String(editingAccount.points.trend || "unknown").replace(/^./, (c) => c.toUpperCase())}`))),
												h("div", { className: "ep-detail" }, h("span", { className: "ep-detail-k" }, t("pointsAt")), h("span", { className: "ep-detail-v" }, editingAccount.points.at ? new Date(editingAccount.points.at).toLocaleString() : "—")),
											),
											Object.keys(editingAccount.points.components || {}).length
												? h("div", { className: "ep-detail-comps" },
													Object.entries(editingAccount.points.components).map(([name, value]) => h("span", { className: "ep-tag", key: name }, `${name} ${value}`)))
												: null,
											(editingAccount.points.history || []).length
												? h("div", { className: "ep-history" }, `${t("pointsHistory")}: ${editingAccount.points.history.slice(-6).map((sample) => sample.value).join(" → ")}`)
												: null,
										)
										: h("div", { className: "ep-hint" }, editingAccount.points?.error || t("pointsUnknown")),
									h("button", {
										type: "button",
										className: "ep-btn ep-btn-ghost ep-btn-sm",
										onClick: () => refreshPoints(editingAccount),
										disabled: busy === `points-${editingAccount.code}`,
									}, busy === `points-${editingAccount.code}` ? t("pointsFetching") : t("refreshPointsNow")),
								)
								: null,
							h("div", { className: "ep-modal-tip" },
								h(Icon, { name: "spark", size: 16 }),
								h("span", null, t("afterSaveHint")),
							),
							state.error ? h("div", { className: "ep-banner ep-banner-error" }, state.error) : null,
						),
						h("div", { className: "ep-modal-foot" },
							state.editing
								? h("button", {
									type: "button",
									className: "ep-btn ep-btn-ghost ep-btn-danger ep-btn-sm",
									onClick: () => {
										const target = accounts.find((item) => item.code === state.editing);
										if (target) void removeAccount(target, true);
									},
								}, t("purgeAccount"))
								: null,
							h("span", { className: "ep-grow" }),
							h("button", { type: "button", className: "ep-btn ep-btn-ghost", onClick: closeForm }, t("cancel")),
							h("button", {
								type: "button",
								className: "ep-btn ep-btn-primary",
								onClick: submitForm,
								disabled: busy === "save-account",
							}, busy === "save-account" ? t("saving") : t("saveAccount")),
						),
					),
				);
			}

			function configRow(field) {
				const draft = state.draft || {};
				const value = draft[field.key];
				const rawSource = (data && data.config && data.config.sources && data.config.sources[field.key]) || "default";
				const source = String(rawSource).startsWith("env") ? "env" : rawSource;
				const sourceLabel = t(`source${source.charAt(0).toUpperCase()}${source.slice(1)}`);
				const control = field.type === "bool"
					? h("label", { className: "ep-check" },
						h("input", {
							type: "checkbox",
							checked: value === true,
							onChange: (event) => setDraft(field.key, event.target.checked),
						}),
						h("span", null, value === true ? t("on") : t("off")),
					)
					: h("input", {
						className: "ep-input",
						type: field.key === "proxyApiUrl" ? "password" : field.type === "number" ? "number" : "text",
						value: field.key === "proxyApiUrl" && value === "***" ? "" : value === undefined || value === null ? "" : String(value),
						placeholder: field.key === "egoPath" ? "C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe"
							: field.key === "proxyApiUrl" ? "http://api.shenlongip.com/ip?key=...&sign=...&count=1" : "",
						onChange: (event) => setDraft(field.key, event.target.value),
					});
				return h("div", { className: "ep-row", key: field.key },
					h("div", { className: "ep-row-text" },
						h("span", { className: "ep-row-label" }, t(field.key)),
						field.hint ? h("span", { className: "ep-row-hint" }, t(field.hint)) : null,
					),
					h("span", { className: cls("ep-source", source === "file" ? "ep-source-own" : null) }, sourceLabel),
					h("div", { className: "ep-row-control" }, control),
				);
			}

			function accountTab() {
				return h("section", { className: "ep-card" },
					h("div", { className: "ep-card-head" },
						h("div", { className: "ep-head-text" },
							h("h4", { className: "ep-card-title" }, t("accountsTitle")),
							h("p", { className: "ep-card-desc" }, t("accountsDesc")),
						),
						h("div", { className: "ep-bar" },
							h("button", { type: "button", className: "ep-btn ep-btn-ghost ep-btn-sm", onClick: load, disabled: Boolean(busy) },
								h(Icon, { name: "refresh", size: 14 }), t("refresh")),
							h("button", { type: "button", className: "ep-btn ep-btn-primary ep-btn-sm", onClick: openAddForm },
								h(Icon, { name: "plus", size: 14 }), t("addAccount")),
						),
					),
					accounts.length
						? h("div", { className: "ep-accounts" }, accounts.map(accountRow))
						: h("div", { className: "ep-empty" },
							h("div", { className: "ep-empty-icon" }, h(BrandGlyph, { size: 24 })),
							h("div", { className: "ep-empty-title" }, t("noAccounts")),
							h("div", { className: "ep-empty-text" }, t("noAccountsHint")),
							h("button", { type: "button", className: "ep-btn ep-btn-primary", onClick: openAddForm },
								h(Icon, { name: "plus", size: 15 }), t("addAccount")),
						),
				);
			}

			function proxyRow(entry) {
				const assigned = entry.assigned || [];
				const tested = entry.lastTest && entry.lastTest.ok === true;
				return h("div", { className: "ep-list-row", key: entry.id },
					h("div", { className: "ep-empty-icon", style: { width: 34, height: 34, borderRadius: 10 } }, h(Icon, { name: "shield", size: 16 })),
					h("div", { className: "ep-list-main" },
						h("div", { className: "ep-account-title" },
							h("span", { className: "ep-row-label" }, entry.label || entry.id),
							entry.hasAuth ? h("span", { className: "ep-tag" }, t("hasAuth")) : null,
							tested
								? h("span", { className: "ep-pill ep-pill-on" }, `${entry.lastTest.ip || "?"} · ${entry.lastTest.latencyMs ?? "?"}ms`)
								: h("span", { className: "ep-pill" }, t("proxyTested")),
						),
						h("div", { className: "ep-account-sub" },
							h("code", null, entry.server),
							h("span", { className: "ep-sep" }, "·"),
							h("span", null, assigned.length ? `${t("assignedTo")}: ${assigned.join(", ")}` : t("notAssigned")),
						),
					),
					h("div", { className: "ep-account-actions" },
						h(ActionButton, {
							label: busy === `test-proxy-${entry.id}` ? t("testingProxy") : t("testProxy"),
							icon: "check",
							onClick: () => testProxyEntry(entry),
							disabled: busy === `test-proxy-${entry.id}`,
						}),
						h(IconButton, { label: t("editProxy"), icon: "edit", onClick: () => openProxyForm(entry) }),
						h(IconButton, { label: t("remove"), icon: "trash", tone: "danger", onClick: () => removeProxy(entry), disabled: busy === `remove-proxy-${entry.id}` }),
					),
				);
			}

			function proxyForm() {
				if (!state.proxyFormOpen) return null;
				const form = state.proxyForm;
				return h("div", { className: "ep-form" },
					h("div", { className: "ep-grid" },
						h("label", { className: "ep-item" },
							h("span", { className: "ep-label" }, t("proxyLabel")),
							h("input", {
								className: "ep-input",
								value: form.label,
								placeholder: "香港-01",
								onChange: (event) => setProxyField("label", event.target.value),
							}),
							h("span", { className: "ep-hint" }, t("proxyLabelHint")),
						),
						h("label", { className: "ep-item ep-field-full" },
							h("span", { className: "ep-label" }, t("proxyServer")),
							h("input", {
								className: "ep-input",
								value: form.server,
								placeholder: "http://host:port",
								onChange: (event) => setProxyField("server", event.target.value),
							}),
							h("span", { className: "ep-hint" }, t("proxyServerHint")),
						),
						h("label", { className: "ep-item" },
							h("span", { className: "ep-label" }, t("proxyUser")),
							h("input", {
								className: "ep-input",
								value: form.username,
								onChange: (event) => setProxyField("username", event.target.value),
							}),
						),
						h("label", { className: "ep-item" },
							h("span", { className: "ep-label" }, t("proxyPassword")),
							h("input", {
								className: "ep-input",
								type: "password",
								value: form.password,
								onChange: (event) => setProxyField("password", event.target.value),
							}),
						),
					),
					h("span", { className: "ep-hint" }, t("credentialNote")),
					h("div", { className: "ep-form-actions" },
						h("button", { type: "button", className: "ep-btn ep-btn-primary", onClick: submitProxy, disabled: busy === "add-proxy" || busy === "update-proxy" }, t("saveProxy")),
						h("button", { type: "button", className: "ep-btn ep-btn-ghost", onClick: closeProxyForm }, t("cancel")),
						h("span", { className: "ep-grow" }),
						state.proxyEditing
							? h("button", {
								type: "button",
								className: "ep-btn ep-btn-ghost ep-btn-danger",
								onClick: () => {
									const entry = proxies.find((item) => item.id === state.proxyEditing);
									if (entry) void removeProxy(entry);
								},
							}, t("remove"))
							: null,
					),
				);
			}

			function openTask(task) {
				setState((s) => ({
					...s,
					taskOpen: true,
					error: null,
					taskForm: {
						id: task?.id || "",
						title: task?.title || "",
						description: task?.description || "",
						accountCode: task?.accountCode || ((accounts[0] && accounts[0].code) || ""),
						url: task?.url || "",
						script: task?.script || "",
						proxyMode: task?.proxyMode || "account",
						proxyId: task?.proxyId || "",
					},
				}));
			}

			function closeTask() {
				setState((s) => ({ ...s, taskOpen: false }));
			}

			function setTaskField(key, value) {
				setState((s) => ({ ...s, taskForm: { ...s.taskForm, [key]: value } }));
			}

			async function saveTask() {
				const form = state.taskForm;
				if (!form.title.trim()) {
					setState((s) => ({ ...s, error: t("taskTitle") }));
					return;
				}
				const result = await callRoute(ROUTES.tasks, { method: "POST", body: { op: "save", ...form } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({ ...s, taskOpen: false, notice: t("saved") }));
				await load();
			}

			async function runTask(task) {
				setState((s) => ({ ...s, busy: `task-${task.id}`, error: null, notice: null }));
				const result = await callRoute(ROUTES.tasks, { method: "POST", body: { op: "run", id: task.id } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, busy: null, error: failureText(t, result) }));
					return;
				}
				setState((s) => ({ ...s, busy: null, notice: `${task.title}: ${result.payload.title || result.payload.url || "ok"}` }));
				await load();
			}

			async function removeTask(task) {
				const ok = typeof window === "undefined" || !window.confirm ? true : window.confirm(t("confirmRemoveTask"));
				if (!ok) return;
				await callRoute(ROUTES.tasks, { method: "POST", body: { op: "remove", id: task.id } });
				await load();
			}

			function taskModal() {
				if (!state.taskOpen) return null;
				const form = state.taskForm;
				return h("div", { className: "ep-modal-backdrop" },
					h("div", { className: "ep-modal", role: "dialog", "aria-modal": "true" },
						h("div", { className: "ep-modal-head" },
							h("div", { className: "ep-hero-icon ep-modal-icon" }, h(Icon, { name: "terminal", size: 20 })),
							h("div", { className: "ep-modal-heading" },
								h("h3", { className: "ep-modal-title" }, form.id ? t("editTask") : t("newTask")),
								h("p", { className: "ep-modal-sub" }, t("tasksDesc")),
							),
							h("button", { type: "button", className: "ep-icon-btn", onClick: closeTask }, h(Icon, { name: "close", size: 16 })),
						),
						h("div", { className: "ep-modal-body" },
							h("label", { className: "ep-item" }, h("span", { className: "ep-label" }, t("taskTitle")),
								h("input", { className: "ep-input", value: form.title, onChange: (e) => setTaskField("title", e.target.value) })),
							h("label", { className: "ep-item" }, h("span", { className: "ep-label" }, t("taskDescription")),
								h("input", { className: "ep-input", value: form.description, onChange: (e) => setTaskField("description", e.target.value) })),
							h("label", { className: "ep-item" }, h("span", { className: "ep-label" }, t("taskAccount")),
								h("select", { className: "ep-select", value: form.accountCode, onChange: (e) => setTaskField("accountCode", e.target.value) },
									accounts.map((a) => h("option", { key: a.code, value: a.code }, a.code)))),
							h("label", { className: "ep-item" }, h("span", { className: "ep-label" }, t("taskProxy")),
								h("select", { className: "ep-select", value: form.proxyMode, onChange: (e) => setTaskField("proxyMode", e.target.value) },
									h("option", { value: "account" }, t("taskProxyAccount")),
									h("option", { value: "dynamic" }, t("taskProxyDynamic")),
									h("option", { value: "static" }, t("taskProxyStatic")))),
							form.proxyMode === "static"
								? h("label", { className: "ep-item" }, h("span", { className: "ep-label" }, t("taskProxyId")),
									h("select", { className: "ep-select", value: form.proxyId, onChange: (e) => setTaskField("proxyId", e.target.value) },
										h("option", { value: "" }, "—"),
										proxies.map((p) => h("option", { key: p.id, value: p.id }, `${p.id} · ${p.server}`))))
								: null,
							h("label", { className: "ep-item" }, h("span", { className: "ep-label" }, t("taskUrl")),
								h("input", { className: "ep-input", value: form.url, placeholder: "https://…", onChange: (e) => setTaskField("url", e.target.value) })),
							h("label", { className: "ep-item" }, h("span", { className: "ep-label" }, t("taskScript")),
								h("textarea", { className: "ep-input", style: { height: 140, paddingTop: 8 }, value: form.script,
									placeholder: "return document.title;", onChange: (e) => setTaskField("script", e.target.value) })),
							state.error ? h("div", { className: "ep-banner ep-banner-error" }, state.error) : null,
						),
						h("div", { className: "ep-modal-foot" },
							h("span", { className: "ep-grow" }),
							h("button", { type: "button", className: "ep-btn ep-btn-ghost", onClick: closeTask }, t("cancel")),
							h("button", { type: "button", className: "ep-btn ep-btn-primary", onClick: saveTask }, t("save")),
						),
					),
				);
			}

			function tasksTab() {
				return h("section", { className: "ep-card" },
					h("div", { className: "ep-card-head" },
						h("div", { className: "ep-head-text" },
							h("h4", { className: "ep-card-title" }, t("tasksTitle")),
							h("p", { className: "ep-card-desc" }, t("tasksDesc")),
						),
						h("div", { className: "ep-bar" },
							h("button", { type: "button", className: "ep-btn ep-btn-primary ep-btn-sm", onClick: () => openTask(null) },
								h(Icon, { name: "plus", size: 14 }), t("newTask")),
						),
					),
					tasks.length
						? h("div", { className: "ep-list" }, tasks.map((task) => h("div", { className: "ep-list-row", key: task.id },
							h("div", { className: "ep-list-main" },
								h("span", { className: "ep-row-label" }, task.title),
								h("span", { className: "ep-dim" }, `${task.accountCode || "—"} · ${task.description || task.url || ""}`),
								task.lastRun ? h("span", { className: "ep-dim" }, `${t("taskLastRun")}: ${new Date(task.lastRun.at).toLocaleString()} ${task.lastRun.ok ? "✓" : "✗"}`) : null,
							),
							h(ActionButton, { label: busy === `task-${task.id}` ? t("taskRunning") : t("runTask"), icon: "terminal", onClick: () => runTask(task), disabled: busy === `task-${task.id}` }),
							h(IconButton, { label: t("editTask"), icon: "edit", onClick: () => openTask(task) }),
							h(IconButton, { label: t("remove"), icon: "trash", tone: "danger", onClick: () => removeTask(task) }),
						)))
						: h("div", { className: "ep-empty" }, h("div", { className: "ep-empty-text" }, t("noTasks"))),
				);
			}

			function proxiesTab() {
				const dynamic = (data && data.dynamic) || { remaining: 0, ips: [], ttlMinutes: 3 };
				const dynamicSources = (data && data.dynamicSources) || [];
				const sourcesCard = h("section", { className: "ep-card" },
					h("div", { className: "ep-card-head" },
						h("div", { className: "ep-head-text" },
							h("h4", { className: "ep-card-title" }, t("dynamicSourcesTitle")),
							h("p", { className: "ep-card-desc" }, t("dynamicSourcesDesc")),
						),
						h("div", { className: "ep-bar" },
							h("button", { type: "button", className: "ep-btn ep-btn-primary ep-btn-sm", onClick: () => openProviderModal(null) },
								h(Icon, { name: "plus", size: 14 }), t("addSource")),
						),
					),
					dynamicSources.length
						? h("div", { className: "ep-list" }, dynamicSources.map((source) => h("div", { className: "ep-list-row", key: source.id },
							h("div", { className: "ep-list-main" },
								h("span", { className: "ep-row-label" }, source.label),
								h("span", { className: "ep-dim" }, `${source.url} · ${source.id}`),
							),
							h(IconButton, { label: t("editSource"), icon: "edit", onClick: () => openProviderModal(source) }),
							h(IconButton, { label: t("remove"), icon: "trash", tone: "danger", onClick: () => removeSource(source) }),
						)))
						: h("div", { className: "ep-empty" }, h("div", { className: "ep-empty-text" }, t("noSources"))),
				);
				const dynamicCard = h("section", { className: "ep-card" },
					h("div", { className: "ep-card-head" },
						h("div", { className: "ep-head-text" },
							h("h4", { className: "ep-card-title" }, t("dynamicPoolTitle")),
							h("p", { className: "ep-card-desc" }, t("dynamicPoolDesc")),
						),
						h("div", { className: "ep-bar" },
							h("span", { className: "ep-pill ep-pill-on" }, `${t("dynamicRemaining")} ${dynamic.remaining}`),
							h("button", { type: "button", className: "ep-btn ep-btn-ghost ep-btn-sm", onClick: load, disabled: Boolean(busy) },
								h(Icon, { name: "refresh", size: 14 }), t("refresh")),
						),
					),
					dynamic.ips.length
						? h("div", { className: "ep-list" }, dynamic.ips.map((item) => h("div", { className: "ep-list-row", key: item.server },
							h("div", { className: "ep-list-main" },
								h("span", { className: "ep-row-label" }, item.server),
								h("span", { className: "ep-dim" }, `${item.accountCode} · ${t("dynamicExpires")} ${item.remainingSeconds}s`),
							),
						)))
						: h("div", { className: "ep-empty" },
							h("div", { className: "ep-empty-icon" }, h(Icon, { name: "shield", size: 20 })),
							h("div", { className: "ep-empty-text" }, t("dynamicEmpty")),
						),
				);
				return h("div", { className: "ep-stack" },
					sourcesCard,
					dynamicCard,
					h("section", { className: "ep-card" },
						h("div", { className: "ep-card-head" },
							h("div", { className: "ep-head-text" },
								h("h4", { className: "ep-card-title" }, t("proxiesTitle")),
								h("p", { className: "ep-card-desc" }, t("proxiesDesc")),
							),
							h("div", { className: "ep-bar" },
								h("button", { type: "button", className: "ep-btn ep-btn-ghost ep-btn-sm", onClick: extractProxy, disabled: busy === "extract-proxy" },
									h(Icon, { name: "refresh", size: 14 }), busy === "extract-proxy" ? t("proxyExtracting") : t("proxyExtract")),
								h("button", { type: "button", className: "ep-btn ep-btn-primary ep-btn-sm", onClick: () => openProxyForm(null) },
									h(Icon, { name: "plus", size: 14 }), t("addProxy")),
							),
						),
						proxies.length
							? h("div", { className: "ep-list" }, proxies.map(proxyRow))
							: h("div", { className: "ep-empty" },
								h("div", { className: "ep-empty-icon" }, h(Icon, { name: "shield", size: 20 })),
								h("div", { className: "ep-empty-title" }, t("noProxies")),
								h("div", { className: "ep-empty-text" }, t("noProxiesHint")),
								h("button", { type: "button", className: "ep-btn ep-btn-primary", onClick: () => openProxyForm(null) },
									h(Icon, { name: "plus", size: 15 }), t("addProxy")),
							),
						proxyForm(),
					),
				);
			}

			function providerRow() {
				const configured = Boolean(data?.config?.values?.proxyApiUrl);
				return h("div", { className: "ep-row" },
					h("div", { className: "ep-row-text" },
						h("span", { className: "ep-row-label" }, t("proxyApiUrl")),
						h("span", { className: "ep-row-hint" }, t("proxyApiUrlHint")),
					),
					h("span", { className: `ep-source${configured ? " ep-source-own" : ""}` },
						configured ? t("providerConfigured") : t("providerNotConfigured")),
					h("div", { className: "ep-row-control" },
						h("button", { type: "button", className: "ep-btn ep-btn-ghost ep-btn-sm", onClick: openProviderModal },
							configured ? t("providerChange") : t("providerOpen")),
					),
				);
			}

			function configTab() {
				const groups = [
					{ key: "runtime", label: t("groupRuntime") },
					{ key: "browser", label: t("groupBrowser") },
					{ key: "provider", label: t("groupProvider") },
				];
				return h("section", { className: "ep-card" },
					h("div", { className: "ep-card-head" },
						h("div", { className: "ep-head-text" },
							h("h4", { className: "ep-card-title" }, t("configTitle")),
							h("p", { className: "ep-card-desc" }, t("configDesc")),
						),
						h("div", { className: "ep-bar" },
							h("button", { type: "button", className: "ep-btn ep-btn-ghost ep-btn-sm", onClick: resetConfig, disabled: busy === "reset-config" }, t("reset")),
							h("button", { type: "button", className: "ep-btn ep-btn-primary ep-btn-sm", onClick: saveConfig, disabled: busy === "save-config" },
								busy === "save-config" ? t("saving") : t("save")),
						),
					),
					groups.map((group) => h("div", { key: group.key, className: "ep-rows" },
						h("div", { className: "ep-row" },
							h("div", { className: "ep-row-text" }, h("span", { className: "ep-row-label" }, group.label)),
						),
						group.key === "provider" ? providerRow() : null,
						CONFIG_FIELDS.filter((field) => field.group === group.key && field.key !== "proxyApiUrl").map(configRow),
					)),
				);
			}

			function flowsTab() {
				return h("section", { className: "ep-card" },
					h("div", { className: "ep-card-head" },
						h("div", { className: "ep-head-text" },
							h("h4", { className: "ep-card-title" }, t("flowsTitle")),
							h("p", { className: "ep-card-desc" }, t("flowsDesc")),
						),
					),
					flows.length
						? h("div", { className: "ep-list" }, flows.map((flow) => h("div", { className: "ep-list-row", key: flow.id },
							h("div", { className: "ep-empty-icon", style: { width: 32, height: 32, borderRadius: 10 } },
								h(Icon, { name: "flow", size: 16 })),
							h("div", { className: "ep-list-main" },
								h("span", { className: "ep-mono" }, flow.id),
								h("span", { className: "ep-dim" }, flow.label || "—"),
							),
							flow.media ? h("span", { className: "ep-tag" }, flow.media) : null,
							h("span", { className: "ep-pill" }, t("flowSteps").replace("{n}", String(flow.stepCount ?? "—"))),
						)))
						: h("div", { className: "ep-empty" }, h("div", { className: "ep-empty-text" }, "—")),
				);
			}

			function connectionBadge(item) {
				const connectivity = item.connectivity;
				const probing = busy === `probe-${item.accountCode}`;
				if (probing) return h("span", { className: "ep-pill ep-conn" }, h("span", { className: "ep-conn-dot" }), t("probing"));
				if (!connectivity) {
					return h("button", {
						type: "button",
						className: "ep-pill ep-conn",
						title: t("checkConnection"),
						onClick: () => probeSession(item),
					}, h("span", { className: "ep-conn-dot" }), t("notProbed"));
				}
				if (connectivity.ok) {
					return h("button", {
						type: "button",
						className: "ep-pill ep-pill-on ep-conn",
						title: `${connectivity.target} · ${connectivity.checkedAt}`,
						onClick: () => probeSession(item),
					}, h(Icon, { name: "check", size: 12 }), `${t("connected")} · ${connectivity.latencyMs}ms`);
				}
				return h("button", {
					type: "button",
					className: "ep-pill ep-pill-bad ep-conn",
					title: connectivity.error || connectivity.target,
					onClick: () => probeSession(item),
				}, h(Icon, { name: "close", size: 12 }), t("connectionFailed"));
			}

			function sessionsTab() {
				return h("section", { className: "ep-card" },
					h("div", { className: "ep-card-head" },
						h("div", { className: "ep-head-text" },
							h("h4", { className: "ep-card-title" }, t("sessionsTitle")),
							h("p", { className: "ep-card-desc" }, t("sessionsDesc")),
						),
						h("div", { className: "ep-bar" },
							h("button", { type: "button", className: "ep-btn ep-btn-ghost ep-btn-sm", onClick: load, disabled: Boolean(busy) },
								h(Icon, { name: "refresh", size: 14 }), t("refresh")),
						),
					),
					sessions.length
						? h("div", { className: "ep-list" }, sessions.map((item) => h("div", { className: "ep-list-row", key: item.accountCode },
							h("div", { className: "ep-avatar", style: { width: 32, height: 32, borderRadius: 10, fontSize: 12 } },
								String(item.accountCode || "?").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase()),
							h("div", { className: "ep-list-main" },
								h("span", { className: "ep-row-label" }, item.accountCode),
								h("span", { className: "ep-mono" }, item.url || "about:blank"),
							),
							h("div", { className: "ep-session-net" },
								h("span", { className: "ep-tag", title: item.proxy || "" }, item.proxy ? t("proxy") : t("direct")),
								connectionBadge(item),
							),
							h("span", { className: "ep-dim" }, `PID ${item.pid ?? "—"}`),
							h(ActionButton, { label: t("closeWindow"), icon: "window", onClick: () => session({ code: item.accountCode }, "close") }),
						)))
						: h("div", { className: "ep-empty" },
							h("div", { className: "ep-empty-icon" }, h(Icon, { name: "terminal", size: 20 })),
							h("div", { className: "ep-empty-title" }, t("noSessions")),
							h("div", { className: "ep-empty-text" }, t("sessionsDesc")),
						),
				);
			}

			const tabs = [
				{ id: "tasks", label: t("tabTasks"), count: tasks.length, render: tasksTab },
				{ id: "accounts", label: t("tabAccounts"), count: accounts.length, render: accountTab },
				{ id: "proxies", label: t("tabProxies"), count: proxies.length, render: proxiesTab },
				{ id: "config", label: t("tabConfig"), count: null, render: configTab },
				{ id: "flows", label: t("tabFlows"), count: flows.length, render: flowsTab },
				{ id: "tasks", label: t("tabTasks"), count: tasks.length, render: tasksTab },
				{ id: "sessions", label: t("tabSessions"), count: sessions.length, render: sessionsTab },
			];

			if (state.phase === "loading" && !data) {
				return h("div", { className: "ep-root" },
					h("div", { className: "ep-loading" }, h("span", { className: "ep-spinner" }), t("loading")),
				);
			}
			if (state.phase === "error" && !data) {
				return h("div", { className: "ep-root" },
					h("div", { className: "ep-banner ep-banner-error" }, state.error || t("readFailed")),
					h("div", null, h("button", { type: "button", className: "ep-btn ep-btn-ghost", onClick: load }, t("reload"))),
				);
			}

			const plugin = (data && data.plugin) || {};
			const activeTab = tabs.find((tab) => tab.id === state.tab) || tabs[0];

			return h("div", { className: props.page ? "ep-page" : null },
				h("div", { className: "ep-root" },
					h("div", { className: "ep-hero" },
						h("div", { className: "ep-hero-icon" }, h(BrandGlyph, { size: 24 })),
						h("div", { className: "ep-hero-text" },
							h("h1", { className: "ep-hero-title" }, t("title")),
							h("p", { className: "ep-hero-sub" }, props.page ? t("pageSubtitle") : t("summary")),
							h("div", { className: "ep-meta" },
								h("span", { className: cls("ep-pill", plugin.egoExists ? "ep-pill-on" : "ep-pill-bad") },
									`${t("pluginState")} ${plugin.egoExists ? t("found") : t("missing")}`),
								h("span", { className: "ep-sep" }, "·"),
								h("span", null, `${t("version")} ${plugin.version || "—"}`),
								plugin.installedVersion ? h("span", { className: "ep-sep" }, "·") : null,
								plugin.installedVersion ? h("span", null, `ego ${plugin.installedVersion}`) : null,
							),
						),
						h("div", { className: "ep-hero-actions" },
							h("button", { type: "button", className: "ep-btn ep-btn-ghost", onClick: load, disabled: Boolean(busy) || state.phase === "loading" },
								h(Icon, { name: "refresh", size: 15 }), t("refresh")),
						),
					),

					h("div", { className: "ep-stats" },
						h(Stat, { value: accounts.length, label: t("statsAccounts") }),
						h(Stat, { value: proxied, label: t("statsProxied") }),
						h(Stat, { value: sessions.length, label: t("statsSessions") }),
						h(Stat, { value: flows.length, label: t("statsFlows") }),
					),

					state.error ? h("div", { className: "ep-banner ep-banner-error" }, state.error) : null,
					falling.length
						? h("div", { className: "ep-banner ep-banner-warn" },
							h(Icon, { name: "alert", size: 15 }),
							h("span", null, `${t("pointsWarning")} — ${falling.map((account) => `${account.code} (${account.points.value})`).join(" · ")}`),
						)
						: null,
					state.notice ? h("div", { className: "ep-banner ep-banner-ok" }, state.notice) : null,

					h("div", { className: "ep-tabs", role: "tablist" },
						tabs.map((tab) => h("button", {
							key: tab.id,
							type: "button",
							role: "tab",
							"aria-selected": state.tab === tab.id,
							className: cls("ep-tab", state.tab === tab.id ? "ep-tab-on" : null),
							onClick: () => setState((s) => ({ ...s, tab: tab.id })),
						}, tab.label, tab.count ? h("span", { className: "ep-tab-count" }, String(tab.count)) : null)),
					),

					activeTab.render(),
					accountModal(),
					providerModal(),
					taskModal(),
				),
			);
		}

		/** Settings page / row-config card. */
		function EgoPublishCard(props) {
			return h(EgoPublishBody, { ...props, page: false });
		}

		/** Full-width main panel page. */
		function EgoPublishPage(props) {
			return h(EgoPublishBody, { ...props, page: true });
		}

		/** The left-rail glyph for the panel entry. */
		function EgoPublishGlyph(props) {
			return h("span", { style: { display: "inline-flex", color: props.active ? "var(--dsw-alias-brand-primary)" : "currentColor" } },
				h(BrandGlyph, { size: Number(props.size) || 18 }),
			);
		}

		const inject = ["slots", "locale"];

		function safeTranslate(ctx) {
			let reader = null;
			try {
				reader = typeof ctx?.locale?.bind === "function" ? ctx.locale.bind(NS) : null;
			} catch {
				reader = null;
			}
			return (key, ...rest) => {
				try {
					if (typeof reader === "function") {
						const value = reader(key, ...rest);
						if (typeof value === "string") return value;
					}
				} catch {
					/* fall through */
				}
				return String(key);
			};
		}

		function injectStyles() {
			try {
				if (typeof document === "undefined" || !document.head) return () => {};
				const previous = document.getElementById("ego-publish-settings-style");
				if (previous) previous.remove();
				const element = document.createElement("style");
				element.id = "ego-publish-settings-style";
				element.textContent = STYLES;
				document.head.appendChild(element);
				return () => {
					try {
						element.remove();
					} catch {
						/* already gone */
					}
				};
			} catch {
				/* no document */
			}
			return () => {};
		}

		function guarded(label, fn) {
			try {
				return fn();
			} catch (error) {
				try {
					console.error(`ego-publish: ${label} failed`, error);
				} catch {
					/* no console */
				}
				return () => {};
			}
		}

		function apply(ctx) {
			const t = safeTranslate(ctx);
			guarded("dictionaries", () => ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				"ego-publish: dictionaries",
			));
			guarded("stylesheet", () => ctx.effect(() => injectStyles(), "ego-publish: stylesheet"));

			const withTranslate = (Component) => function Translated(props) {
				const translate = typeof props.t === "function" ? props.t : t;
				return h(Component, { ...props, t: translate });
			};

			const seats = [
				{ slot: "settings.section", options: { id: ROW_ID, order: 32, label: () => t("title") }, component: EgoPublishCard, note: "settings page" },
				{ slot: "settings.plugins.tab", options: { id: ROW_ID, order: 21, label: () => t("title") }, component: EgoPublishCard, note: "settings plugins tab" },
				{ slot: "plugins.row.config", options: { key: `${BUNDLE}#${ROW_ID}` }, component: EgoPublishCard, note: "row settings page" },
				{ slot: "plugins.bundle.config", options: { key: BUNDLE }, component: EgoPublishCard, note: "bundle settings page" },
			];
			for (const seat of seats) {
				guarded(seat.note, () => ctx.effect(
					() => ctx.slots.inject(seat.slot, () => ctx.slots.register({
						name: seat.slot,
						locale: NS,
						...seat.options,
					}, withTranslate(seat.component))),
					`ego-publish: ${seat.note}`,
				));
			}

			// The left-rail entry and the full page it opens. Registering the panellist entry is what makes
			// the panel appear in both the rail and its More menu (the sidebar derives panels from it).
			guarded("panel entry", () => ctx.effect(
				() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist",
					locale: NS,
					id: PANEL_ID,
					order: 20,
					label: () => t("title"),
				}, EgoPublishGlyph)),
				"ego-publish: sidebar panel entry",
			));
			guarded("main panel", () => ctx.effect(
				() => ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					locale: NS,
					key: PANEL_ID,
				}, withTranslate(EgoPublishPage))),
				"ego-publish: main panel",
			));
		}

		exports.NS = NS;
		exports.ROUTES = ROUTES;
		exports.PANEL_ID = PANEL_ID;
		exports.ROW_CONFIG_KEY = `${BUNDLE}#${ROW_ID}`;
		exports.BUNDLE_CONFIG_KEY = BUNDLE;
		exports.STYLES = STYLES;
		exports.EgoPublishCard = EgoPublishCard;
		exports.EgoPublishPage = EgoPublishPage;
		exports.dictionaries = { zh, en };
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

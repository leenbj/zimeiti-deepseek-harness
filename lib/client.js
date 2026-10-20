/**
 * lib/client.js — the media-publish settings page (the plugin's browser half).
 *
 * Hand-written in the exact shape the shipped client bundles use (see
 * `@deepseek-ai/dsh-client-ui-settings-agent-loop/lib/client.js`), so no build step is involved: the host
 * serves this file verbatim as the package's `./client` export.
 *
 * Why the page is plugin-owned rather than Config-derived: DSH's `settings` service renders forms from
 * fields a plugin declares with `.volatile()` on a `@deepseek-ai/schemastery` schema, and this package
 * imports no DSH package in its host half (a bare import there makes the whole entry fail to activate).
 * So the page renders itself and reads/writes over its own HTTP route, `GET|POST /media-publish/config`
 * (+ `/reset`), which the host half registers on the `webServer` service. Same origin, so `fetch` works.
 *
 * **Styling.** The markup carries `mp-*` class names and one stylesheet is injected into the document
 * head, because a bundle half has no `styles` builtin (that belongs to a dynamic half) and cannot import
 * DSH components without an externals declaration. Every value in that sheet is copied from the shipped
 * primitives — `@deepseek-ai/dsh-client-ui-primitives`' `Button.module.css`, `Checkbox.module.css` and
 * `Input.module.css` — and every colour is a `--dsw-alias-*` theme token, so the page follows the DSH
 * control radii, type scale, densities and light/dark theme instead of inventing its own look:
 *   button 36px / radius --dsw-radius-md / 14px type / 0 14px padding, compact 28px variant;
 *   input 32px / 0.5px --dsw-alias-border-l4 / --dsw-alias-bg-layer-1, focus in the business state colour;
 *   checkbox 16px with --dsw-alias-brand-primary accent, 14px label, 6px gap.
 *
 * It registers into four seats, keyed exactly as their owners dispatch them
 * (`@deepseek-ai/dsh-client-ui-plugin-manager`'s `rowConfigKey(bundle, rowId) === `${bundle}#${rowId}``):
 *   - `settings.section`      id `media-publish`                          → a page in the Settings panel
 *   - `settings.plugins.tab`  id `media-publish`                          → a tab in Settings → Plugins
 *   - `plugins.row.config`    key `@dsh-plugin/media-publish#media-publish` → a configure control on the row
 *   - `plugins.bundle.config` key `@dsh-plugin/media-publish`             → a form on the bundle's page
 */

window.__ModuleLoader__.load({
	id: "@dsh-plugin/media-publish",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** Locale namespace this page owns. */
		const NS = "media-publish";
		/** The package name, and the row id the bundle's patch declares. */
		const BUNDLE = "@dsh-plugin/media-publish";
		const ROW_ID = "media-publish";
		/** The host half's configuration route. */
		const ROUTE = "/media-publish/config";
		/** The host half's account-management routes. */
		const ACCOUNTS_ROUTE = "/media-publish/accounts";
		const REMOVE_ROUTE = "/media-publish/accounts/remove";
		const PROXY_ROUTE = "/media-publish/accounts/proxy";
		const TEST_ROUTE = "/media-publish/accounts/test-proxy";
		const LOGIN_ROUTE = "/media-publish/accounts/login";
		const CHECK_ROUTE = "/media-publish/accounts/check";

		const en = {
			title: "Media publish",
			summary: "Publish articles to 搜狐号 / 头条号 / CSDN through a browser, by replaying a recorded recipe.",
			loading: "Reading the current configuration…",
			unreachable: "The plugin's configuration route did not answer. The plugin's host half may not be loaded in this deployment.",
			routeMissing: "The plugin's configuration route is not registered on this deployment's web server, so the page cannot read or save anything.",
			readFailed: "Could not read the plugin's current configuration.",
			save: "Save",
			saving: "Saving…",
			saved: "Saved.",
			saveFailed: "The plugin refused these values; nothing was written.",
			reload: "Reload",
			reset: "Reset",
			resetHint: "Restore the value from the layer below.",
			overridden: "Set here",
			sourceFrom: "From",
			clearHint: "Leave empty to fall back to the layer below.",
			stale: "Another writer changed the configuration; the form was refreshed.",
			untouched: "No changes yet.",
			changedTemplate: "{n} field(s) changed.",
			on: "on",
			off: "off",
			restartNeeded: "Applies when the engine restarts (the next call does that automatically).",
			live: "Applies to the next call.",
			tabEnvironment: "Publish environment",
			tabAccounts: "Publish accounts",
			accountsTitle: "Accounts",
			accountsDesc: "Each account keeps its own sign-in, browser profile and proxy binding.",
			environmentTitle: "Publish environment",
			environmentDesc: "Runtime and browser defaults. A value shown as “Set here” overrides the plugin config.",
			colStatus: "Status",
			colState: "Sign-in",
			colActions: "Actions",
			addAccount: "New account",
			saveAccount: "Save account",
			cancel: "Cancel",
			remove: "Remove",
			removePurge: "Remove and sign out",
			removeHint: "Remove keeps the stored login; the second button also deletes it.",
			purgeConfirm: "Remove this account AND delete its stored login state?",
			code: "Code",
			platform: "Platform",
			selectMedia: "Choose a platform",
			mediaRequired: "Choose a platform first — a new account must have one.",
			more: "More ⋯",
			less: "Less",
			dangerZone: "This removes the account",
			loginName: "Login name",
			note: "Note",
			signedIn: "Signed in",
			notSignedIn: "Not signed in",
			direct: "Direct connection",
			proxyServer: "Proxy server",
			proxyUser: "User",
			proxyPassword: "Password",
			bindProxy: "Bind proxy",
			clearBinding: "Clear",
			testProxy: "Test",
			testing: "Testing…",
			proxyOk: "The proxy answered.",
			noAccounts: "No accounts yet — add one below.",
			accountsLoadFailed: "Could not read the account list.",
			credentialNote: "A proxy password is written to secrets.yaml and is never shown again.",
			editingTemplate: "Editing {code}",
			edit: "Edit",
			proxy: "Proxy",
			login: "Sign in",
			checkLogin: "Check",
			loginStarted: "A browser window is open — finish signing in there. This page is watching for the result.",
			loginFailed: "The sign-in did not finish:",
			stateKept: "Sign-in saved:",
			stateNone: "No saved sign-in",
			polling: "Waiting for the sign-in…",
		};
		const zh = {
			title: "自媒体发布",
			summary: "通过浏览器把稿件发布到搜狐号 / 头条号 / CSDN，回放录制好的 recipe 完成。",
			loading: "正在读取当前配置…",
			unreachable: "插件的配置路由没有响应：本部署里插件的宿主半可能没有加载。",
			routeMissing: "本部署的 web 服务上没有注册插件的配置路由，页面读不到也存不了。",
			readFailed: "无法读取插件当前的配置。",
			save: "保存",
			saving: "保存中…",
			saved: "已保存。",
			saveFailed: "插件拒绝了这些取值，没有写入任何内容。",
			reload: "重新读取",
			reset: "恢复默认",
			resetHint: "从下一层取值。",
			overridden: "已在此设置",
			sourceFrom: "来自",
			clearHint: "留空表示回退到下一层。",
			stale: "配置已被其他写入方改动，表单已刷新。",
			untouched: "尚未修改。",
			changedTemplate: "已修改 {n} 项。",
			on: "开",
			off: "关",
			restartNeeded: "重启引擎后生效（下一次调用会自动重启）。",
			live: "下一次调用即生效。",
			tabEnvironment: "发布环境",
			tabAccounts: "发布账号",
			accountsTitle: "发布账号",
			accountsDesc: "每个账号各自保留登录信息、浏览器环境与代理绑定，相互隔离。",
			environmentTitle: "发布环境",
			environmentDesc: "运行时与浏览器默认值；标注「已在此设置」的项会覆盖插件配置。",
			colStatus: "状态",
			colState: "登录信息",
			colActions: "操作",
			addAccount: "新增账号",
			saveAccount: "保存账号",
			cancel: "取消",
			remove: "删除",
			removePurge: "删除并退出登录",
			removeHint: "「删除」保留已存登录态；第二个按钮会连登录态一起删除。",
			purgeConfirm: "确定删除该账号并一并删除已保存的登录态？",
			code: "账号代号",
			platform: "平台",
			selectMedia: "请选择平台",
			mediaRequired: "请先选择平台 —— 新建账号必须指定平台。",
			more: "更多 ⋯",
			less: "收起",
			dangerZone: "以下操作会移除账号",
			loginName: "登录名",
			note: "备注",
			signedIn: "已登录",
			notSignedIn: "未登录",
			direct: "直连（未绑定代理）",
			proxyServer: "代理服务器",
			proxyUser: "用户名",
			proxyPassword: "密码",
			bindProxy: "绑定代理",
			clearBinding: "解绑",
			testProxy: "测试",
			testing: "测试中…",
			proxyOk: "代理可用。",
			noAccounts: "还没有账号，可在下方新增。",
			accountsLoadFailed: "无法读取账号列表。",
			credentialNote: "代理密码会写入 secrets.yaml，之后不再回显。",
			editingTemplate: "正在编辑 {code}",
			edit: "编辑",
			proxy: "代理",
			login: "登录",
			checkLogin: "检查",
			loginStarted: "浏览器窗口已打开，请在其中完成登录。本页会持续关注结果。",
			loginFailed: "登录未完成：",
			stateKept: "登录信息已保存：",
			stateNone: "无保存的登录信息",
			polling: "正在等待登录完成…",
		};

		/**
		 * The stylesheet. Every value is copied from the shipped primitives so this page matches the rest of
		 * the Settings surfaces, and every colour is a theme token so it follows light/dark automatically.
		 * A bundle half gets no `styles` builtin, so this text is injected into the document head instead.
		 */
		const STYLES = [
			".mp-root{display:flex;flex-direction:column;gap:16px;font-size:14px;line-height:22px;",
			"color:var(--dsw-alias-label-primary);font-family:inherit;}",
			".mp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".mp-grow{flex:1 1 auto;}",
			".mp-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".mp-msg{margin:0;font-size:12px;line-height:18px;}",
			".mp-msg-error{color:var(--dsw-alias-state-error-primary);}",
			".mp-msg-ok{color:var(--dsw-alias-state-success-primary);}",
			".mp-fields{display:flex;flex-direction:column;}",
			".mp-field{display:flex;flex-direction:column;gap:6px;padding:14px 0;",
			"border-top:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-field:first-child{border-top:none;padding-top:0;}",
			".mp-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}",
			".mp-label{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);}",
			".mp-source{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".mp-source-own{color:var(--dsw-alias-brand-primary);}",
			".mp-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".mp-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".mp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;",
			"height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);font-size:14px;",
			"line-height:22px;font-family:inherit;color:var(--dsw-alias-label-primary);background:transparent;",
			"cursor:pointer;}",
			".mp-btn:disabled{opacity:0.4;cursor:not-allowed;}",
			".mp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ",
			"var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}",
			".mp-btn-primary{background:var(--dsw-alias-button-primary-fill);",
			"color:var(--dsw-alias-label-primary-foreground);}",
			".mp-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}",
			".mp-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
			".mp-btn-ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active);}",
			".mp-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;",
			"border-radius:var(--dsw-radius-sm);}",
			".mp-input{box-sizing:border-box;height:32px;padding:0 8px;font-family:inherit;font-size:14px;",
			"line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);",
			"border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);outline:none;}",
			".mp-input:focus{border-color:var(--dsw-alias-state-business-primary);}",
			".mp-input::placeholder{color:var(--dsw-alias-label-dimmed);}",
			".mp-input:disabled{opacity:0.5;cursor:not-allowed;}",
			".mp-input-text{width:34em;max-width:100%;}",
			".mp-input-num{width:12em;}",
			".mp-check{display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:20px;",
			"color:var(--dsw-alias-label-primary);cursor:pointer;}",
			".mp-check input{flex:0 0 auto;width:16px;height:16px;margin:0;",
			"accent-color:var(--dsw-alias-brand-primary);cursor:inherit;}",
			".mp-check:has(input:disabled){cursor:default;opacity:0.5;}",
			".mp-tabs{display:flex;gap:6px;flex-wrap:wrap;}",
			".mp-tab{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 12px;",
			"border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;",
			"font-size:12px;line-height:18px;font-family:inherit;color:var(--dsw-alias-label-secondary);",
			"cursor:pointer;}",
			".mp-tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
			".mp-tab-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);",
			"border-color:var(--dsw-alias-border-l3);}",
			".mp-rows{display:flex;flex-direction:column;}",
			".mp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;",
			"border-top:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-row:first-child{border-top:none;}",
			".mp-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;",
			"color:var(--dsw-alias-label-primary);}",
			".mp-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;",
			"font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2);",
			"color:var(--dsw-alias-label-secondary);}",
			".mp-dim{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".mp-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);}",
			".mp-bad{font-size:12px;line-height:18px;color:var(--dsw-alias-state-idle-primary);}",
			".mp-form{display:flex;flex-direction:column;gap:10px;padding-top:12px;",
			"border-top:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-grid{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;}",
			".mp-item{display:flex;flex-direction:column;gap:4px;}",
			".mp-select{box-sizing:border-box;height:32px;padding:0 6px;font-family:inherit;font-size:14px;",
			"color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);",
			"border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);outline:none;}",
			".mp-select:focus{border-color:var(--dsw-alias-state-business-primary);}",
			".mp-w-sm{width:13em;}",
			".mp-w-md{width:18em;}",
			// —— 更精致的排版：标题区、分段控件、卡片分区、账号表格 ——
			// 全部颜色仍来自主题令牌，深浅色模式下自动适配；层次靠边框与底色差表达，
			// 而不是硬编码阴影色（那样在暗色模式下会脏，也躲不过“无硬编码颜色”的断言）。
			".mp-head-title{font-size:16px;line-height:24px;font-weight:600;margin:0 0 2px;}",
			".mp-head-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".mp-seg{display:inline-flex;gap:2px;padding:2px;background:var(--dsw-alias-bg-layer-2);",
			"border-radius:999px;align-self:flex-start;}",
			".mp-seg-btn{box-sizing:border-box;display:inline-flex;align-items:center;height:26px;padding:0 14px;",
			"border:0.5px solid transparent;border-radius:999px;background:transparent;font-family:inherit;",
			"font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;}",
			".mp-seg-btn:hover:not(.mp-seg-on){color:var(--dsw-alias-label-primary);}",
			".mp-seg-on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);",
			"color:var(--dsw-alias-label-primary);font-weight:500;}",
			".mp-card{border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);",
			"background:var(--dsw-alias-bg-layer-1);overflow:hidden;}",
			".mp-card-head{padding:14px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l1);}",
			// 卡片头右侧留出操作按钮（例如「新增账号」）。窄面板下按钮整体换行，不挤压标题。
			".mp-card-head-row{display:flex;align-items:flex-start;justify-content:space-between;",
			"gap:10px 12px;flex-wrap:wrap;}",
			".mp-card-head-text{flex:1 1 180px;min-width:0;}",
			".mp-card-body{padding:14px 16px;}",
			".mp-card-body-tight{padding:4px 0 0;}",
			".mp-table{width:100%;border-collapse:collapse;}",
			".mp-table th{text-align:left;font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.03em;",
			"color:var(--dsw-alias-label-tertiary);padding:10px 16px 8px;",
			"border-bottom:0.5px solid var(--dsw-alias-border-l1);white-space:nowrap;}",
			".mp-table td{padding:12px 16px;font-size:13px;line-height:20px;vertical-align:middle;",
			"border-bottom:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-table tbody tr:last-child td{border-bottom:none;}",
			".mp-table tbody tr:hover{background:var(--dsw-alias-bg-layer-2);}",
			".mp-col-actions{text-align:right;white-space:nowrap;}",
			".mp-actions{display:inline-flex;gap:6px;justify-content:flex-end;}",
			".mp-dot{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;}",
			".mp-dot::before{content:\"\";width:6px;height:6px;border-radius:999px;flex:0 0 auto;",
			"background:var(--dsw-alias-state-idle-primary);}",
			".mp-dot-on::before{background:var(--dsw-alias-state-success-primary);}",
			".mp-plat{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;",
			"font-size:11px;line-height:20px;font-weight:500;background:var(--dsw-alias-brand-soft,transparent);",
			"color:var(--dsw-alias-brand-primary);border:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;",
			"color:var(--dsw-alias-label-primary);}",
			".mp-empty{padding:28px 16px;text-align:center;font-size:13px;line-height:20px;",
			"color:var(--dsw-alias-label-tertiary);}",
			".mp-section{display:flex;flex-direction:column;gap:16px;}",
			// 账号表：用同一套 grid 列定义表头与数据行，所以列天然对齐。
			// 最后一个网格项（操作）在表头里跨 4 列，正好覆盖 4 个按钮各自的列。
			".mp-rows-head,.mp-row{display:grid;align-items:center;gap:12px;padding:12px 16px;",
			"grid-template-columns:76px 84px minmax(110px,1fr) 104px minmax(130px,1fr) minmax(120px,1fr) repeat(4,auto);}",
			".mp-rows-head{padding:10px 16px;font-size:11px;line-height:16px;letter-spacing:0.03em;",
			"color:var(--dsw-alias-label-tertiary);border-bottom:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-rows-head > :last-child{grid-column:span 4;text-align:right;}",
			".mp-rows > .mp-row{border-top:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-rows > .mp-row:first-child{border-top:none;}",
			".mp-rows > .mp-row:hover{background:var(--dsw-alias-bg-layer-2);}",
			".mp-row .mp-grow{display:none;}",
			".mp-row > button{justify-self:end;}",
			// 账号块：宽度自适应。信息区可伸缩，按钮组固定靠右；放不下时按钮组整体换到下一行，
			// 而不是把某几个按钮挤到另一行造成错位。六个按钮在窄面板下换行是正常的自适应。
			".mp-acct{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:14px 16px;",
			"border-top:0.5px solid var(--dsw-alias-border-l1);}",
			".mp-acct:first-child{border-top:none;}",
			".mp-acct:hover{background:var(--dsw-alias-bg-layer-2);}",
			".mp-acct-info{flex:1 1 180px;min-width:0;display:flex;flex-direction:column;gap:5px;}",
			".mp-acct-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;line-height:20px;}",
			".mp-acct-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;",
			"font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".mp-acct-acts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;}",
			// 展开的危险操作：占满整行（flex-basis:100%），所以它不会挤在按钮组里改变行高以外的东西。
			".mp-more{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:10px;",
			"border-top:0.5px dashed var(--dsw-alias-border-l1);}",
			".mp-more-hint{margin-right:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
			".mp-sep{color:var(--dsw-alias-label-tertiary);}",
		].join("");

		/** Field labels and descriptions ship as `{zh, en}`; `navigator.language` is enough to pick one. */
		const preferZh = String((typeof navigator !== "undefined" && navigator.language) || "")
			.toLowerCase().startsWith("zh");

		/** @param {unknown} value */
		function localize(value) {
			if (value && typeof value === "object") {
				const record = /** @type {Record<string, unknown>} */ (value);
				const chosen = preferZh ? (record.zh ?? record.en) : (record.en ?? record.zh);
				return chosen === undefined || chosen === null ? "" : String(chosen);
			}
			return value === undefined || value === null ? "" : String(value);
		}

		/** Where an effective value came from, as page copy. */
		const SOURCE_LABEL = {
			default: { zh: "默认值", en: "default" },
			env: { zh: "环境变量", en: "environment" },
			patch: { zh: "插件配置", en: "plugin config" },
			"config-file": { zh: "此页保存的值", en: "this page" },
		};

		/**
		 * One request to the host half's route. Never throws: a transport failure is reported as a result,
		 * because a rejected fetch must render a message rather than blank the card.
		 * @param {string} path
		 * @param {{ method?: string, body?: unknown }} [init]
		 */
		async function callRoute(path, init = {}) {
			/** @type {Record<string, string>} */
			const headers = { accept: "application/json" };
			/** @type {any} */
			const request = { method: init.method ?? "GET", headers };
			if (init.body !== undefined) {
				// The host half requires exactly this content type; it is also what stops a cross-origin HTML
				// form from writing here, since a custom content type forces a CORS preflight.
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

		/** The message to show for a failed call, preferring the route's own wording. */
		function failureText(t, result, mode) {
			if (result.status === 0) return `${t("unreachable")} (${result.transport})`;
			const message = result.payload && result.payload.error && result.payload.error.message;
			// A 404 diagnoses itself: no route was registered, so the request never arrived. Reporting that
			// as "the plugin refused these values" once made a failed *read* look like a refused *write*.
			if (result.status === 404) return t("routeMissing");
			if (result.status === 409) return `${t("stale")}${message ? ` ${message}` : ""}`;
			if (message) return String(message);
			return mode === "read"
				? `${t("readFailed")} (HTTP ${result.status})`
				: `${t("saveFailed")} (HTTP ${result.status})`;
		}

		/**
		 * The card the Settings seats render: a one-liner for `view: 'summary'`, the form otherwise.
		 * @param {{ view?: 'summary' | 'page', t?: (key: string, ...rest: any[]) => string }} props
		 */
		function MediaPublishCard(props) {
			// `props.t` is supplied by the slot's `locale` option. Never trust it to be a function: a throw
			// inside a rendered component reaches the operator only as the host's generic "the plugin could
			// not handle this request; see the plugin log", which names neither this plugin nor the cause.
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const isSummary = props.view === "summary";
			const [state, setState] = React.useState(
				/** @type {{ phase: string, fields: any[], revision: number, draft: Record<string, unknown>, error: string|null, note: string|null, busy: boolean, tab: string, media: string[], accounts: any[]|null, accountsError: string|null, accountsNote: string|null, form: { code: string, media: string, account: string, note: string }, proxyFor: string|null, proxyForm: { server: string, username: string, password: string }, rowBusy: string|null }} */ ({
					phase: "idle", fields: [], revision: 0, draft: {}, error: null, note: null, busy: false,
					// 打开就先给账号页：日常要动的是账号，环境配置是偶尔才改一次的。
					tab: "accounts", media: [], accounts: null, accountsError: null, accountsNote: null,
					form: { code: "", media: "", account: "", note: "" },
					// The account form is opened on demand: by the “添加账号” button, or by a row's “编辑”.
					// It used to be permanently visible at the bottom of the panel, so there was no obvious
					// place to start from and it read as if account creation had no entry point at all.
					formOpen: false,
					proxyFor: null, proxyForm: { server: "", username: "", password: "" }, rowBusy: null, loginFor: null,
					moreFor: null,
				}),
			);

			const load = React.useCallback(async () => {
				setState((s) => ({ ...s, phase: "loading", error: null, note: null }));
				const result = await callRoute(ROUTE);
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, phase: "error", error: failureText(t, result, "read") }));
					return;
				}
				setState((s) => ({
					...s,
					phase: "ready",
					fields: Array.isArray(result.payload.fields) ? result.payload.fields : [],
					revision: Number(result.payload.revision) || 0,
					draft: {},
					error: null,
				}));
			}, [t]);

			const loadAccounts = React.useCallback(async () => {
				const result = await callRoute(ACCOUNTS_ROUTE);
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, accounts: [], accountsError: failureText(t, result, "read") }));
					return;
				}
				setState((s) => ({
					...s,
					accounts: Array.isArray(result.payload.accounts) ? result.payload.accounts : [],
					media: Array.isArray(result.payload.media) && result.payload.media.length
						? result.payload.media
						: s.media,
					accountsError: null,
				}));
			}, [t]);

			// Only the page reads the routes; a summary must stay free of side effects.
			React.useEffect(() => {
				if (isSummary || state.phase !== "idle") return undefined;
				void load();
				return undefined;
			}, [isSummary, state.phase, load]);

			// The account list is fetched when its tab is first opened, so merely opening the page never
			// touches the engine.
			React.useEffect(() => {
				if (isSummary || state.tab !== "accounts" || state.accounts !== null) return undefined;
				void loadAccounts();
				return undefined;
			}, [isSummary, state.tab, state.accounts, loadAccounts]);

			if (isSummary) return t("summary");

			/** Apply a successful response to the form state. */
			function accept(payload, note) {
				setState((s) => ({
					...s,
					busy: false,
					fields: Array.isArray(payload.fields) ? payload.fields : s.fields,
					revision: Number(payload.revision) || s.revision,
					draft: {},
					error: null,
					note,
				}));
			}

			async function save() {
				setState((s) => ({ ...s, busy: true, error: null, note: null }));
				// Only the edited fields are sent, together with the revision the form was read at, so a
				// concurrent writer is answered with 409 rather than silently clobbered.
				const result = await callRoute(ROUTE, {
					method: "POST",
					body: { values: state.draft, revision: state.revision },
				});
				if (result.ok && result.payload && result.payload.ok === true) {
					accept(result.payload, t("saved"));
					return;
				}
				setState((s) => {
					const next = { ...s, busy: false, error: failureText(t, result, "write") };
					if (result.status === 409 && result.payload && Array.isArray(result.payload.fields)) {
						next.fields = result.payload.fields;
						next.revision = Number(result.payload.revision) || s.revision;
						next.draft = {};
					}
					return next;
				});
			}

			async function resetOne(name) {
				setState((s) => ({ ...s, busy: true, error: null, note: null }));
				const result = await callRoute(`${ROUTE}/reset`, {
					method: "POST",
					body: { names: [name], revision: state.revision },
				});
				if (result.ok && result.payload && result.payload.ok === true) {
					accept(result.payload, t("saved"));
					return;
				}
				setState((s) => ({ ...s, busy: false, error: failureText(t, result, "write") }));
			}

			/** POST one account operation, then refresh the list so the table always shows the truth. */
			async function accountOp(key, path, body, note) {
				setState((s) => ({ ...s, rowBusy: key, accountsError: null, accountsNote: null }));
				const result = await callRoute(path, { method: "POST", body });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, rowBusy: null, accountsError: failureText(t, result, "write") }));
					return false;
				}
				setState((s) => ({ ...s, rowBusy: null, accountsError: null, accountsNote: note }));
				await loadAccounts();
				return true;
			}

			async function saveAccount() {
				const form = state.form;
				const code = form.code.trim();
				// Creating an account REQUIRES a platform; omitting `media` only means something when updating
				// an existing one ("keep the platform it already has"). Catching it here spares the operator a
				// round trip that used to end in the engine's bare `missing required param 'media'`.
				const isNew = !(state.accounts ?? []).some((entry) => entry.code === code);
				if (isNew && !form.media) {
					setState((s) => ({ ...s, accountsNote: null, accountsError: t("mediaRequired") }));
					return;
				}
				const body = { code, account: form.account, note: form.note };
				// An omitted `media` means "keep the existing platform", so editing a note cannot drop it.
				if (form.media) body.media = form.media;
				if (await accountOp("form", ACCOUNTS_ROUTE, body, t("saved"))) {
					setState((s) => ({
						...s,
						// 保存成功后收起表单：它现在是一个「按需展开」的面板。
						formOpen: false,
						form: { code: "", media: "", account: "", note: "" },
					}));
				}
			}

			async function testProxy(code) {
				const key = `test:${code}`;
				setState((s) => ({ ...s, rowBusy: key, accountsError: null, accountsNote: null }));
				const result = await callRoute(TEST_ROUTE, { method: "POST", body: { code } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, rowBusy: null, accountsError: failureText(t, result, "read") }));
					return;
				}
				const detail = result.payload.result ?? {};
				setState((s) => ({
					...s,
					rowBusy: null,
					accountsNote: [t("proxyOk"), detail.ip ? `IP ${detail.ip}` : "", detail.ms ? `${detail.ms}ms` : ""]
						.filter(Boolean).join(" "),
				}));
			}

			/**
			 * Start a sign-in. The request returns at once (the host half refuses to hold an HTTP request
			 * open while a human scans a code), so the outcome is polled instead.
			 */
			async function startLogin(code) {
				setState((s) => ({ ...s, rowBusy: `login:${code}`, accountsError: null, accountsNote: null }));
				const result = await callRoute(LOGIN_ROUTE, { method: "POST", body: { code } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, rowBusy: null, accountsError: failureText(t, result, "write") }));
					return;
				}
				setState((s) => ({ ...s, rowBusy: null, loginFor: code, accountsNote: t("loginStarted") }));
				void pollLogin(code, 0);
			}

			/** Poll a sign-in until it finishes, then re-read the list so the new state shows up. */
			async function pollLogin(code, attempt) {
				if (attempt > 120) {
					setState((s) => ({ ...s, loginFor: null, accountsError: t("loginFailed") }));
					return;
				}
				const result = await callRoute(`${LOGIN_ROUTE}?code=${encodeURIComponent(code)}`);
				const job = result.payload && result.payload.job;
				if (job && job.status === "done") {
					setState((s) => ({ ...s, loginFor: null, accountsNote: t("saved") }));
					await loadAccounts();
					return;
				}
				if (job && job.status === "failed") {
					setState((s) => ({
						...s,
						loginFor: null,
						accountsError: `${t("loginFailed")} ${job.message ?? ""}`.trim(),
					}));
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 5000));
				void pollLogin(code, attempt + 1);
			}

			/** Verify a stored sign-in without touching it, then re-read the list. */
			async function checkLogin(code) {
				setState((s) => ({ ...s, rowBusy: `check:${code}`, accountsError: null, accountsNote: null }));
				const result = await callRoute(CHECK_ROUTE, { method: "POST", body: { code } });
				if (!result.ok || !result.payload || result.payload.ok !== true) {
					setState((s) => ({ ...s, rowBusy: null, accountsError: failureText(t, result, "read") }));
					return;
				}
				const loggedIn = result.payload.loggedIn === true;
				setState((s) => ({
					...s,
					rowBusy: null,
					accountsNote: `${code}: ${loggedIn ? t("signedIn") : t("notSignedIn")}`
						+ (result.payload.url ? ` · ${result.payload.url}` : ""),
				}));
				await loadAccounts();
			}

			function setForm(key, value) {
				setState((s) => ({ ...s, form: { ...s.form, [key]: value } }));
			}

			function setProxyField(key, value) {
				setState((s) => ({ ...s, proxyForm: { ...s.proxyForm, [key]: value } }));
			}

			/** A labelled input, shaped like the environment fields so both sections read the same. */
			function formInput(id, label, type, value, placeholder, widthClass, onChange) {
				return React.createElement("div", { className: "mp-item", key: id },
					React.createElement("label", { className: "mp-dim", htmlFor: id }, label),
					React.createElement("input", {
						id,
						type,
						value,
						placeholder,
						disabled: state.rowBusy !== null,
						className: `mp-input ${widthClass}`,
						onChange: (event) => onChange(event.target.value),
					}),
				);
			}

			/** One account row: identity, login state, proxy summary and its actions. */
			function renderAccountRow(account) {
				const busy = state.rowBusy !== null;
				const proxy = account.proxy ?? {};
				const stored = account.state;
				const loginBusy = state.loginFor === account.code || state.rowBusy === `login:${account.code}`;
				// Destructive actions live behind “More” so the row keeps four primary buttons. Six buttons on
				// one line is what pushed two of them onto a second line in a narrow settings panel.
				const moreOpen = state.moreFor === account.code;
				// 这里刻意**不用固定列宽的表格**：一行有六个操作按钮，而设置面板远窄于
				// 「排得下六个按钮的表格」所需宽度 —— 列数不够 + 总宽超限，正是按钮被挤到第二行、
				// 整个分区看起来错乱的原因。改成可自适应的一块：信息在左、按钮组在右，
				// 宽度不足时整个按钮组换行，而不会把单个按钮拆散。
				const stateText = loginBusy
					? t("polling")
					: stored && stored.exists
						? `${t("stateKept")} ${(stored.bytes / 1024).toFixed(1)}KB`
						: t("stateNone");
				return React.createElement("div", { key: account.code, className: "mp-acct" },
					React.createElement("div", { className: "mp-acct-info" },
						React.createElement("div", { className: "mp-acct-line" },
							React.createElement("span", { className: "mp-plat" }, account.media),
							React.createElement("span", { className: "mp-mono" }, account.code),
							React.createElement("span", { className: account.hasState ? "mp-dot mp-dot-on" : "mp-dot" },
								account.hasState ? t("signedIn") : t("notSignedIn")),
						),
						// The stored sign-in, read from that account's own file: this is what makes "the login is
						// kept" and "each account is separate" visible instead of merely asserted.
						React.createElement("div", { className: "mp-acct-meta" },
							React.createElement("span", null, account.account || "—"),
							React.createElement("span", { className: "mp-sep" }, "·"),
							React.createElement("span", null, stateText),
							React.createElement("span", { className: "mp-sep" }, "·"),
							React.createElement("span", null, proxy.bound ? String(proxy.server ?? "") : t("direct")),
						),
					),
					React.createElement("div", { className: "mp-acct-acts" },
					React.createElement("button", {
						type: "button",
						className: "mp-btn mp-btn-ghost mp-btn-sm",
						// Only THIS row is blocked while its own sign-in is in flight. Disabling every row
						// because one account was waiting for a human made the other accounts look broken:
						// clicking did nothing, with no explanation anywhere on the page.
						disabled: busy || state.loginFor === account.code,
						onClick: () => void startLogin(account.code),
					}, t("login")),
					React.createElement("button", {
						type: "button",
						className: "mp-btn mp-btn-ghost mp-btn-sm",
						disabled: busy || !account.hasState,
						title: account.hasState ? t("checkLogin") : t("stateNone"),
						onClick: () => void checkLogin(account.code),
					}, t("checkLogin")),
					React.createElement("button", {
						type: "button",
						className: "mp-btn mp-btn-ghost mp-btn-sm",
						disabled: busy,
						onClick: () => setState((s) => ({
							...s,
							formOpen: true,
							form: {
								code: account.code,
								media: account.media,
								account: account.account,
								note: account.note,
							},
						})),
					}, t("edit")),
					React.createElement("button", {
						type: "button",
						className: "mp-btn mp-btn-ghost mp-btn-sm",
						disabled: busy,
						onClick: () => setState((s) => ({
							...s,
							proxyFor: s.proxyFor === account.code ? null : account.code,
							proxyForm: { server: "", username: "", password: "" },
						})),
					}, t("proxy")),
					React.createElement("button", {
						type: "button",
						className: "mp-btn mp-btn-ghost mp-btn-sm",
						disabled: busy,
						"aria-expanded": moreOpen,
						title: moreOpen ? t("less") : t("more"),
						onClick: () => setState((s) => ({ ...s, moreFor: moreOpen ? null : account.code })),
					}, moreOpen ? t("less") : t("more")),
					),
					// Destructive actions, revealed on demand. Kept inline rather than absolutely positioned:
					// a floating menu would be clipped by the card's own overflow.
					moreOpen
						? React.createElement("div", { className: "mp-more" },
							React.createElement("span", { className: "mp-more-hint" }, t("dangerZone")),
							React.createElement("button", {
								type: "button",
								className: "mp-btn mp-btn-ghost mp-btn-sm",
								disabled: busy,
								title: t("removeHint"),
								onClick: () => void accountOp(account.code, REMOVE_ROUTE, { code: account.code }, t("saved")),
							}, t("remove")),
							React.createElement("button", {
								type: "button",
								className: "mp-btn mp-btn-ghost mp-btn-sm",
								disabled: busy,
								onClick: () => {
									// `confirm` may not exist in a host without a window; `typeof` makes that safe.
									if (typeof confirm === "function" && !confirm(t("purgeConfirm"))) return;
									void accountOp(account.code, REMOVE_ROUTE,
										{ code: account.code, purgeState: true }, t("saved"));
								},
							}, t("removePurge")),
						)
						: null,
				);
			}

			/** The account section: the table, the proxy form for the chosen row, and the add/edit form. */
			function renderAccounts() {
				if (state.accounts === null) {
					return React.createElement("p", { className: "mp-state" }, t("loading"));
				}
				const form = state.form;
				const proxyForm = state.proxyForm;
				const mediaOptions = state.media.length ? state.media : ["sohu", "toutiao", "csdn"];
				return React.createElement("div", { className: "mp-section" },
					state.accountsError
						? React.createElement("p", { className: "mp-msg mp-msg-error" }, state.accountsError)
						: null,
					state.accountsNote
						? React.createElement("p", { className: "mp-msg mp-msg-ok" }, state.accountsNote)
						: null,
					// 账号区做成一张卡片：卡片头说明这块是干什么的，表格本体列对齐。
					React.createElement("div", { className: "mp-card" },
						React.createElement("div", { className: "mp-card-head mp-card-head-row" },
							React.createElement("div", { className: "mp-card-head-text" },
								React.createElement("div", { className: "mp-head-title" }, t("accountsTitle")),
								React.createElement("p", { className: "mp-head-desc" }, t("accountsDesc")),
							),
							// 显式的入口按钮。之前表单一直摊在面板底部，页面上没有任何「从这里新增」的按钮，
							// 看起来就像新增账号的功能不存在。
							React.createElement("button", {
								type: "button",
								className: "mp-btn mp-btn-primary mp-btn-sm",
								disabled: state.rowBusy !== null || state.accounts === null,
								"aria-expanded": state.formOpen,
								onClick: () => setState((s) => ({
									...s,
									formOpen: true,
									form: { code: "", media: "", account: "", note: "" },
								})),
							}, t("addAccount")),
						),
						state.accounts.length === 0
							? React.createElement("div", { className: "mp-empty" }, t("noAccounts"))
							: React.createElement("div", { className: "mp-rows" }, state.accounts.map(renderAccountRow)),
					),
					state.proxyFor
						? React.createElement("div", { className: "mp-form" },
							React.createElement("div", { className: "mp-label" }, `${t("proxy")}: ${state.proxyFor}`),
							React.createElement("div", { className: "mp-grid" },
								formInput("mp-proxy-server", t("proxyServer"), "text", proxyForm.server,
									"http://host:port", "mp-w-md", (value) => setProxyField("server", value)),
								formInput("mp-proxy-user", t("proxyUser"), "text", proxyForm.username,
									"", "mp-w-sm", (value) => setProxyField("username", value)),
								formInput("mp-proxy-pass", t("proxyPassword"), "password", proxyForm.password,
									"", "mp-w-sm", (value) => setProxyField("password", value)),
							),
							React.createElement("div", { className: "mp-dim" }, t("credentialNote")),
							React.createElement("div", { className: "mp-bar" },
								React.createElement("button", {
									type: "button",
									className: "mp-btn mp-btn-primary",
									disabled: state.rowBusy !== null || !proxyForm.server.trim(),
									onClick: () => void accountOp(state.proxyFor, PROXY_ROUTE, {
										code: state.proxyFor,
										proxy: {
											server: proxyForm.server.trim(),
											username: proxyForm.username,
											password: proxyForm.password,
										},
									}, t("saved")),
								}, t("bindProxy")),
								React.createElement("button", {
									type: "button",
									className: "mp-btn mp-btn-ghost",
									disabled: state.rowBusy !== null,
									onClick: () => void accountOp(state.proxyFor, PROXY_ROUTE,
										{ code: state.proxyFor, proxy: null }, t("saved")),
								}, t("clearBinding")),
								React.createElement("button", {
									type: "button",
									className: "mp-btn mp-btn-ghost",
									disabled: state.rowBusy !== null,
									onClick: () => void testProxy(state.proxyFor),
								}, state.rowBusy === `test:${state.proxyFor}` ? t("testing") : t("testProxy")),
								React.createElement("span", { className: "mp-grow" }),
								React.createElement("button", {
									type: "button",
									className: "mp-btn mp-btn-ghost",
									onClick: () => setState((s) => ({ ...s, proxyFor: null })),
								}, t("cancel")),
							),
						)
						: null,
					state.formOpen ? React.createElement("div", { className: "mp-form" },
						React.createElement("div", { className: "mp-label" },
							form.code ? t("editingTemplate").replace("{code}", form.code) : t("addAccount")),
						React.createElement("div", { className: "mp-grid" },
							formInput("mp-acc-code", t("code"), "text", form.code, "a-1", "mp-w-sm",
								(value) => setForm("code", value)),
							React.createElement("div", { className: "mp-item", key: "mp-acc-media" },
								React.createElement("label", { className: "mp-dim", htmlFor: "mp-acc-media" },
									t("platform")),
								React.createElement("select", {
									id: "mp-acc-media",
									className: "mp-select",
									value: form.media,
									disabled: state.rowBusy !== null,
									onChange: (event) => setForm("media", event.target.value),
								}, [
									// A placeholder instead of silently preselecting the first platform: the choice is
									// required when creating an account, so it should be visible that it is unchosen.
									React.createElement("option", { key: "", value: "" }, t("selectMedia")),
									...mediaOptions.map((media) => React.createElement("option", {
										key: media, value: media,
									}, media)),
								]),
							),
							formInput("mp-acc-name", t("loginName"), "text", form.account, "", "mp-w-md",
								(value) => setForm("account", value)),
							formInput("mp-acc-note", t("note"), "text", form.note, "", "mp-w-md",
								(value) => setForm("note", value)),
						),
						React.createElement("div", { className: "mp-bar" },
							React.createElement("button", {
								type: "button",
								className: "mp-btn mp-btn-primary",
								disabled: state.rowBusy !== null || !form.code.trim(),
								onClick: () => void saveAccount(),
							}, t("saveAccount")),
							React.createElement("button", {
								type: "button",
								className: "mp-btn mp-btn-ghost",
								disabled: state.rowBusy !== null,
								onClick: () => setState((s) => ({
									...s, formOpen: false,
									form: { code: "", media: "", account: "", note: "" },
								})),
							}, t("cancel")),
						),
					) : null,
				);
			}

			function setDraft(name, value) {
				setState((s) => ({ ...s, draft: { ...s.draft, [name]: value }, note: null }));
			}

			/** One row per field: its label, the control, where the value comes from, and a reset. */
			function renderField(field) {
				const name = String(field.name);
				const edited = Object.prototype.hasOwnProperty.call(state.draft, name);
				const current = edited ? state.draft[name] : field.value;
				const sourceLabel = localize(SOURCE_LABEL[field.effectiveFrom] ?? field.effectiveFrom);
				const inputId = `mp-${name}`;

				let control;
				if (field.type === "boolean") {
					control = React.createElement("label", { className: "mp-check", htmlFor: inputId },
						React.createElement("input", {
							id: inputId,
							type: "checkbox",
							checked: current === true,
							disabled: state.busy,
							onChange: (event) => setDraft(name, event.target.checked),
						}),
						React.createElement("span", null, current === true ? t("on") : t("off")),
					);
				} else if (field.type === "integer") {
					control = React.createElement("input", {
						id: inputId,
						className: "mp-input mp-input-num",
						type: "number",
						value: current === null || current === undefined ? "" : String(current),
						disabled: state.busy,
						placeholder: field.default === null || field.default === undefined ? "" : String(field.default),
						onChange: (event) => {
							const text = event.target.value.trim();
							setDraft(name, text === "" ? null : Number(text));
						},
					});
				} else {
					control = React.createElement("input", {
						id: inputId,
						className: "mp-input mp-input-text",
						type: "text",
						value: current === null || current === undefined ? "" : String(current),
						disabled: state.busy,
						placeholder: localize(field.default) || t("clearHint"),
						onChange: (event) => setDraft(name, event.target.value),
					});
				}

				return React.createElement("div", { key: name, className: "mp-field" },
					React.createElement("div", { className: "mp-head" },
						React.createElement("label", { className: "mp-label", htmlFor: inputId },
							localize(field.label) || name),
						React.createElement("span", {
							className: field.overridden ? "mp-source mp-source-own" : "mp-source",
						}, field.overridden ? t("overridden") : `${t("sourceFrom")} ${sourceLabel}`),
					),
					React.createElement("div", { className: "mp-controls" },
						control,
						field.overridden
							? React.createElement("button", {
								type: "button",
								className: "mp-btn mp-btn-ghost mp-btn-sm",
								disabled: state.busy,
								title: t("resetHint"),
								onClick: () => void resetOne(name),
							}, t("reset"))
							: null,
					),
					React.createElement("div", { className: "mp-desc" },
						localize(field.description),
						field.applies === "engine-restart" ? ` ${t("restartNeeded")}` : ` ${t("live")}`,
					),
				);
			}

			if (state.phase === "idle" || state.phase === "loading") {
				return React.createElement("div", { className: "mp-root" },
					React.createElement("p", { className: "mp-state" }, t("loading")));
			}
			if (state.phase === "error") {
				return React.createElement("div", { className: "mp-root" },
					React.createElement("p", { className: "mp-msg mp-msg-error" }, state.error),
					React.createElement("div", { className: "mp-bar" },
						React.createElement("button", {
							type: "button",
							className: "mp-btn mp-btn-ghost",
							onClick: () => void load(),
						}, t("reload"))));
			}

			const changedCount = Object.keys(state.draft).length;

			/** The environment section: the plugin's own behaviour knobs. */
			function renderEnvironment() {
				return React.createElement(React.Fragment, null,
				React.createElement("div", { className: "mp-bar" },
					React.createElement("button", {
						type: "button",
						className: "mp-btn mp-btn-primary",
						disabled: state.busy || changedCount === 0,
						onClick: () => void save(),
					}, state.busy ? t("saving") : t("save")),
					React.createElement("button", {
						type: "button",
						className: "mp-btn mp-btn-ghost",
						disabled: state.busy,
						onClick: () => void load(),
					}, t("reload")),
					React.createElement("span", { className: "mp-grow" }),
					React.createElement("span", { className: "mp-state" },
						changedCount
							? t("changedTemplate").replace("{n}", String(changedCount))
							: t("untouched")),
				),
				state.error ? React.createElement("p", { className: "mp-msg mp-msg-error" }, state.error) : null,
				state.note ? React.createElement("p", { className: "mp-msg mp-msg-ok" }, state.note) : null,
					React.createElement("div", { className: "mp-card" },
						React.createElement("div", { className: "mp-card-head" },
							React.createElement("div", { className: "mp-head-title" }, t("environmentTitle")),
							React.createElement("p", { className: "mp-head-desc" }, t("environmentDesc")),
						),
						React.createElement("div", { className: "mp-fields mp-card-body" }, state.fields.map(renderField)),
					),
				);
			}

			/** One segment of the switcher; the active one carries a filled surface. */
			function segButton(id, label) {
				const active = state.tab === id;
				return React.createElement("button", {
					key: id,
					type: "button",
					role: "tab",
					"aria-selected": active,
					className: active ? "mp-seg-btn mp-seg-on" : "mp-seg-btn",
					onClick: () => setState((s) => ({ ...s, tab: id })),
				}, label);
			}

			return React.createElement("div", { className: "mp-root" },
				React.createElement("div", null,
					React.createElement("div", { className: "mp-head-title" }, t("title")),
					React.createElement("p", { className: "mp-head-desc" }, t("summary")),
				),
				// 账号在前、环境在后：账号是日常操作，环境是设置一次就不动的。
				React.createElement("div", { className: "mp-seg", role: "tablist" },
					segButton("accounts", t("tabAccounts")),
					segButton("environment", t("tabEnvironment")),
				),
				state.tab === "accounts" ? renderAccounts() : renderEnvironment(),
			);
		}

		/** Required client services. `slots.inject` waits for the declaring page, so ordering is safe. */
		const inject = ["slots", "locale"];

		/**
		 * A locale reader that cannot throw.
		 *
		 * The page must render even when a deployment's locale service behaves differently from the one it
		 * was written against, because an exception thrown while a plugin activates or renders reaches the
		 * operator only as the host's generic "the plugin could not handle this request; see the plugin
		 * log" — which names neither this plugin nor the cause.
		 *
		 * @param {any} ctx
		 */
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
					/* fall through to the key */
				}
				return String(key);
			};
		}

		/**
		 * Inject the stylesheet once, replacing any previous copy so a re-apply cannot stack duplicates.
		 * A bundle half has no `styles` builtin, so this goes straight into the document head.
		 * @returns {() => void} a disposer removing it.
		 */
		function injectStyles() {
			try {
				if (typeof document === "undefined" || !document.head) return () => {};
				const previous = document.getElementById("media-publish-settings-style");
				if (previous) previous.remove();
				const element = document.createElement("style");
				element.id = "media-publish-settings-style";
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
				// A host without a usable document: the page still renders, just unstyled.
			}
			return () => {};
		}

		/**
		 * Run one registration, reporting a failure instead of propagating it.
		 * @param {string} label
		 * @param {() => any} fn
		 */
		function guarded(label, fn) {
			try {
				return fn();
			} catch (error) {
				try {
					console.error(`media-publish: ${label} failed`, error);
				} catch {
					/* no console in this host */
				}
				return () => {};
			}
		}

		/**
		 * Register the four settings entry points, this page's dictionaries and its stylesheet.
		 * @param {any} ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = safeTranslate(ctx);
			guarded("dictionaries", () => ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				"media-publish: dictionaries",
			));
			guarded("stylesheet", () => ctx.effect(() => injectStyles(), "media-publish: stylesheet"));

			// `slots.inject(key, cb)` runs cb once the slot is declared and disposes it if the declaration
			// collapses, so the page never races the page that declares these slots.
			//
			// Four seats, because there are two distinct surfaces and the operator looks in both:
			//   * the Settings panel — a top-level page (`settings.section`) and a page inside its Plugins
			//     section (`settings.plugins.tab`); both are list slots keyed by `id`, and their owner props
			//     are trivial (`{close}` and `{}` respectively), so the same card serves them;
			//   * the sidebar Plugins page — the row's configure control and the bundle's own form.
			const seats = [
				{ slot: "settings.section", options: { id: ROW_ID, order: 30, label: () => t("title") }, note: "settings page" },
				{ slot: "settings.plugins.tab", options: { id: ROW_ID, order: 20, label: () => t("title") }, note: "settings plugins tab" },
				{ slot: "plugins.row.config", options: { key: `${BUNDLE}#${ROW_ID}` }, note: "row settings page" },
				{ slot: "plugins.bundle.config", options: { key: BUNDLE }, note: "bundle settings page" },
			];
			for (const seat of seats) {
				// Each seat is guarded on its own: one slot being absent in a given deployment must not cost
				// the operator the other three.
				guarded(seat.note, () => ctx.effect(
					() => ctx.slots.inject(seat.slot, () => ctx.slots.register({
						name: seat.slot,
						locale: NS,
						...seat.options,
					}, MediaPublishCard)),
					`media-publish: ${seat.note}`,
				));
			}
		}

		exports.NS = NS;
		exports.ROUTE = ROUTE;
		exports.ROW_CONFIG_KEY = `${BUNDLE}#${ROW_ID}`;
		exports.BUNDLE_CONFIG_KEY = BUNDLE;
		exports.STYLES = STYLES;
		// Exported for the static bundle check (tests/client-bundle-check.mjs); the module loader only
		// consumes apply/inject, so this costs nothing at runtime.
		exports.MediaPublishCard = MediaPublishCard;
		exports.dictionaries = { zh, en };
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map

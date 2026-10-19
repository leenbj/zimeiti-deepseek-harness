"""浏览器启动/上下文构建：代理、反检测、storage_state、每账号隔离（SPEC §4 §6）。

要点：
  * 统一注入**一个** init script（navigator.webdriver / chrome.runtime / plugins /
    languages / WebGL / Notification.permission），并让它与指纹自洽；
  * 启动参数**永远**包含 ``--disable-blink-features=AutomationControlled``；
  * ``channel`` 不设置（用 Playwright 自带 chromium），``headless=<参数>``；
  * 每账号一个独立 ``BrowserContext``（不共享 user_data_dir），
    需要持久化时走账号的 ``profile/``；
  * 按 headless 值缓存 Browser 实例，进程内可同时跑多个会话（含 headless + headed）。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import fingerprint as fp_mod
from . import paths
from .rpc import log
from .session import Session

if TYPE_CHECKING:  # pragma: no cover
    from playwright.async_api import Browser, BrowserContext, Playwright

__all__ = ["BrowserManager", "ANTI_DETECT_JS", "LAUNCH_ARGS", "init_script",
           "normalize_proxy"]

LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-features=Translate,TranslateUI,OptimizationHints,MediaRouter",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
]

# Chromium 默认**绕过** loopback（127.0.0.1 / localhost / ::1）直连。对本插件来说这
# 是实打实的 IP 泄漏：账号绑定的代理在本地地址上会静默失效（本地代理、抓包代理、
# 以及本机 e2e 测试都会误判「代理没生效」）。显式取反：连 loopback 也走代理。
# 这里选 context 级 ``proxy.bypass`` 而不是启动参数 ``--proxy-bypass-list``：
# 启动参数是**进程内全局**的，而本引擎按 headless 值缓存 Browser 并让多个账号共享，
# 全局 bypass 会污染直连会话；context 级选项才能做到「谁绑了代理谁生效」。
DEFAULT_PROXY_BYPASS = os.environ.get("MEDIA_PROXY_BYPASS", "<-loopback>")

ANTI_DETECT_JS = r"""
(() => {
  const FP = __FP__;
  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); }
    catch (e) {}
  };

  // 1) navigator.webdriver —— 自动化最直接的标志
  def(Navigator.prototype, 'webdriver', () => undefined);
  try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}

  // 2) 语言 / 平台 / 硬件 —— 必须与 fingerprint 一致
  def(navigator, 'languages', () => FP.languages.slice());
  def(navigator, 'language', () => FP.locale);
  def(navigator, 'platform', () => FP.platform);
  def(navigator, 'vendor', () => 'Google Inc.');
  def(navigator, 'hardwareConcurrency', () => FP.cores);
  def(navigator, 'deviceMemory', () => FP.memory);
  def(navigator, 'maxTouchPoints', () => 0);
  def(navigator, 'pdfViewerEnabled', () => true);

  // 3) plugins / mimeTypes —— headless 下为空数组是典型特征
  const mkPlugin = (name, filename, desc) => {
    const plugin = Object.create(Plugin.prototype || Object.prototype);
    const mime = Object.create(MimeType.prototype || Object.prototype);
    Object.defineProperties(mime, {
      type: { value: 'application/pdf', enumerable: true },
      suffixes: { value: 'pdf', enumerable: true },
      description: { value: 'Portable Document Format', enumerable: true },
      enabledPlugin: { value: plugin, enumerable: true },
    });
    Object.defineProperties(plugin, {
      name: { value: name, enumerable: true },
      filename: { value: filename, enumerable: true },
      description: { value: desc, enumerable: true },
      length: { value: 1, enumerable: true },
      0: { value: mime, enumerable: true },
      item: { value: (i) => (i === 0 ? mime : null) },
      namedItem: { value: (n) => (n === 'application/pdf' ? mime : null) },
    });
    return plugin;
  };
  const plugins = [
    mkPlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
    mkPlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
    mkPlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
  ];
  const pluginArray = Object.create(PluginArray.prototype || Object.prototype);
  plugins.forEach((p, i) => Object.defineProperty(pluginArray, i, { value: p, enumerable: true }));
  Object.defineProperties(pluginArray, {
    length: { value: plugins.length },
    item: { value: (i) => plugins[i] || null },
    namedItem: { value: (n) => plugins.find((p) => p.name === n) || null },
    refresh: { value: () => undefined },
  });
  def(navigator, 'plugins', () => pluginArray);
  def(navigator, 'mimeTypes', () => {
    const arr = Object.create(MimeTypeArray.prototype || Object.prototype);
    Object.defineProperties(arr, {
      length: { value: 1 },
      0: { value: plugins[0][0], enumerable: true },
      item: { value: (i) => (i === 0 ? plugins[0][0] : null) },
      namedItem: { value: (n) => (n === 'application/pdf' ? plugins[0][0] : null) },
    });
    return arr;
  });

  // 4) chrome.runtime / chrome.app —— headless 缺失
  if (!window.chrome) { window.chrome = {}; }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function () {}, sendMessage: function () {},
      id: undefined, OnInstalledReason: {}, PlatformArch: {}, PlatformOs: {},
    };
  }
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
  }
  if (!window.chrome.csi) {
    window.chrome.csi = function () {
      return { onloadT: Date.now(), startE: Date.now(), pageT: 1000, tran: 15 };
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function () {
      const t = Date.now() / 1000;
      return { requestTime: t, startLoadTime: t, commitLoadTime: t, finishDocumentLoadTime: t,
               finishLoadTime: t, firstPaintTime: t, firstPaintAfterLoadTime: 0,
               navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true,
               npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
               connectionInfo: 'h2' };
    };
  }

  // 5) Notification.permission + permissions.query 一致
  try {
    Object.defineProperty(Notification, 'permission', {
      get: () => 'default', configurable: true,
    });
  } catch (e) {}
  try {
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      const proto = Object.getPrototypeOf(window.navigator.permissions);
      proto.query = function (params) {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: 'default', onchange: null });
        }
        return origQuery.apply(this, arguments);
      };
    }
  } catch (e) {}

  // 6) WebGL vendor/renderer —— headless 常报 "Google Inc. (Google)" / "SwiftShader"
  const patchGL = (proto) => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    proto.getParameter = function (pname) {
      if (pname === 37445) return FP.gpuVendor;   // UNMASKED_VENDOR_WEBGL
      if (pname === 37446) return FP.gpuRenderer; // UNMASKED_RENDERER_WEBGL
      if (pname === 7936) return FP.gpuVendor;    // VENDOR
      if (pname === 7937) return FP.gpuRenderer;  // RENDERER
      return orig.apply(this, arguments);
    };
  };
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  try {
    if (window.WebGLRenderingContext) {
      const origExt = WebGLRenderingContext.prototype.getExtension;
      WebGLRenderingContext.prototype.getExtension = function (name) {
        const ext = origExt.apply(this, arguments);
        if (ext && name === 'WEBGL_debug_renderer_info') {
          return Object.assign({}, ext, {
            UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446,
          });
        }
        return ext;
      };
    }
  } catch (e) {}

  // 7) 一些 CDP 痕迹
  try { delete navigator.__proto__.webdriver; } catch (e) {}
  try {
    Object.defineProperty(window, 'cdc_adoQpoasnfa76pfcZLmcfl_Array',
      { get: () => undefined, configurable: true });
  } catch (e) {}
})();
"""


def init_script(fingerprint: dict) -> str:
    """生成与指纹自洽的反检测 init script。"""
    fp = fingerprint or {}
    viewport = fp.get("viewport") or {}
    payload = {
        "locale": fp.get("locale") or "zh-CN",
        "languages": fp.get("languages") or fp_mod.languages_for(fp.get("locale") or "zh-CN"),
        "platform": fp.get("platform") or "Win32",
        "cores": int(fp.get("hardware_concurrency") or 8),
        "memory": int(fp.get("device_memory") or 8),
        "gpuVendor": fp.get("gpu_vendor") or "Google Inc. (Intel)",
        "gpuRenderer": fp.get("gpu_renderer") or "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        "viewport": viewport,
    }
    return ANTI_DETECT_JS.replace("__FP__", json.dumps(payload, ensure_ascii=False))


def normalize_proxy(proxy: dict | None) -> dict | None:
    """Playwright 需要 ``server`` 带 scheme；空值剔除；并显式带上 bypass 规则。"""
    if not proxy:
        return None
    server = str(proxy.get("server") or "").strip()
    if not server:
        return None
    if "://" not in server:
        server = "http://" + server
    out: dict[str, Any] = {"server": server}
    if proxy.get("username"):
        out["username"] = str(proxy["username"])
    if proxy.get("password"):
        out["password"] = str(proxy["password"])
    bypass = str(proxy.get("bypass") or DEFAULT_PROXY_BYPASS).strip()
    if bypass:
        out["bypass"] = bypass
    return out


class BrowserManager:
    """进程内唯一的 Playwright 持有者；按 headless 缓存 Browser。"""

    def __init__(self) -> None:
        self._pw: "Playwright | None" = None
        self._browsers: dict[bool, "Browser"] = {}
        self._versions: dict[bool, str] = {}
        self._session_seq = 0
        self._closed = False

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """启动 playwright（幂等）。Browser 按需懒启动。"""
        if self._pw is not None:
            return
        from playwright.async_api import async_playwright

        self._pw = await async_playwright().start()
        log(f"playwright started (chromium={self.chromium_path()})")

    async def _browser(self, headless: bool) -> "Browser":
        await self.start()
        browser = self._browsers.get(bool(headless))
        if browser is not None and browser.is_connected():
            return browser
        assert self._pw is not None
        browser = await self._pw.chromium.launch(
            headless=bool(headless),   # channel 不设置 -> 用 Playwright 自带 chromium
            args=list(LAUNCH_ARGS),
        )
        self._browsers[bool(headless)] = browser
        self._versions[bool(headless)] = browser.version
        log(f"chromium launched headless={bool(headless)} version={browser.version}")
        return browser

    async def stop(self) -> None:
        self._closed = True
        for flag, browser in list(self._browsers.items()):
            try:
                await browser.close()
            except Exception as exc:  # pragma: no cover
                log(f"browser.close failed: {exc!r}", level="WARN")
            self._browsers.pop(flag, None)
        if self._pw is not None:
            try:
                await self._pw.stop()
            except Exception as exc:  # pragma: no cover
                log(f"playwright.stop failed: {exc!r}", level="WARN")
            self._pw = None

    def chromium_path(self) -> str | None:
        if self._pw is None:
            return None
        try:
            return str(self._pw.chromium.executable_path)
        except Exception:  # pragma: no cover
            return None

    def chromium_build(self) -> str | None:
        path = self.chromium_path() or ""
        m = re.search(r"chromium[_-](\d+)", path)
        return m.group(1) if m else None

    def browser_version(self, headless: bool = True) -> str | None:
        return self._versions.get(bool(headless))

    @property
    def started(self) -> bool:
        return self._pw is not None

    # -------------------------------------------------------------- session

    async def open_session(self, account: dict, *, proxy: dict | None,
                           fingerprint: dict, headless: bool,
                           interactive: bool = False) -> Session:
        """为**单个账号**建一个独立 context（不共享 user_data_dir）。"""
        code = str((account or {}).get("code") or "").strip()
        if not code:
            raise ValueError("account.code is required")
        if interactive:
            headless = False
        browser = await self._browser(bool(headless))

        fp = fp_mod.realign_user_agent(fingerprint or fp_mod.derive(code),
                                       browser.version)
        proxy_record = dict(proxy) if proxy else None      # 账号绑定记录（server/expiresAt/source）
        proxy = normalize_proxy(proxy)                     # Playwright 只接受 server/bypass/凭据
        state_path = paths.account_state_path(code)
        ctx_kwargs: dict[str, Any] = {
            "user_agent": fp["user_agent"],
            "locale": fp.get("locale") or "zh-CN",
            "timezone_id": fp.get("timezone_id") or "Asia/Shanghai",
            "viewport": dict(fp.get("viewport") or {"width": 1440, "height": 900}),
            "device_scale_factor": float(fp.get("device_scale_factor") or 1),
            "screen": dict(fp.get("viewport") or {"width": 1440, "height": 900}),
            "extra_http_headers": {"Accept-Language": fp_mod.accept_language(
                fp.get("locale") or "zh-CN"), **fp_mod.sec_ch_ua(fp)},
            "accept_downloads": True,
            "ignore_https_errors": False,
            "color_scheme": "light",
            "is_mobile": False,
            "has_touch": False,
        }
        if proxy:
            ctx_kwargs["proxy"] = proxy
            log(f"session proxy={proxy['server']} bypass={proxy.get('bypass')!r} "
                f"auth={'yes' if proxy.get('username') else 'no'}")
        warnings: list[str] = []
        if state_path.exists() and state_path.stat().st_size > 2:
            ctx_kwargs["storage_state"] = str(state_path)
        else:
            warnings.append(f"账号 {code} 无 storage_state（首次使用需 account.login）")

        self._session_seq += 1
        session_id = f"s{self._session_seq}"
        context = await browser.new_context(**ctx_kwargs)
        context.set_default_timeout(30000)
        context.set_default_navigation_timeout(60000)
        await context.add_init_script(init_script(fp))
        page = await context.new_page()
        page.set_default_timeout(30000)
        page.set_default_navigation_timeout(60000)

        session = Session(
            session_id=session_id,
            code=code,
            context=context,
            page=page,
            proxy=proxy_record,
            fingerprint=fp,
            headless=bool(headless),
            media=str((account or {}).get("media") or ""),
            account=str((account or {}).get("account") or ""),
            storage_state_path=state_path,
            interactive=bool(interactive),
            proxy_policy=str((account or {}).get("_proxy_policy") or "sticky"),
            warnings=warnings,
        )
        session.log_path = paths.account_logs_dir(code) / f"{paths.timestamp()}-{session_id}.jsonl"
        self._wire(session)
        session.note("session.open", {
            "accountCode": code,
            "headless": bool(headless),
            "proxy": (proxy_record or {}).get("server"),
            "proxyBypass": (proxy or {}).get("bypass"),
            "storageState": str(state_path) if state_path.exists() else None,
            "fingerprint": fp_mod.summary(fp),
        })
        return session

    def _wire(self, session: Session) -> None:
        page = session.page

        async def on_dialog(dialog) -> None:
            # 必须显式处理，否则原生弹窗会一直挂住页面
            session.note("dialog", {"type": dialog.type, "message": dialog.message[:300]})
            log(f"dialog [{dialog.type}] {dialog.message[:200]} -> dismissed", level="WARN")
            try:
                await dialog.dismiss()
            except Exception as exc:  # pragma: no cover
                log(f"dialog dismiss failed: {exc!r}", level="WARN")

        def on_page_error(err) -> None:
            session.warnings.append(f"pageerror: {str(err)[:200]}")

        def on_console(msg) -> None:
            if msg.type in ("error", "warning"):
                text = f"console.{msg.type}: {msg.text[:200]}"
                session.warnings.append(text)
                log(f"{session.session_id} {text}", level="DEBUG")

        def on_download(download) -> None:
            target = paths.account_downloads_dir(session.code)
            name = download.suggested_filename or f"{paths.timestamp()}-download"
            dest = target / name
            try:
                download.save_as(str(dest))
                session.note("download", {"path": str(dest)})
            except Exception as exc:  # pragma: no cover
                log(f"download save failed: {exc!r}", level="WARN")

        try:
            page.on("dialog", on_dialog)
            page.on("pageerror", on_page_error)
            page.on("console", on_console)
            page.on("download", on_download)
        except Exception as exc:  # pragma: no cover
            log(f"page event wiring failed: {exc!r}", level="WARN")

        # 弹窗（新标签页）自动并入同一 context，并切到最新标签
        def on_new_page(new_page) -> None:
            if new_page is page:
                return
            try:
                new_page.set_default_timeout(30000)
                session.page = new_page
                session.active_frame = None
                session.frame_path = []
                session.note("popup", {"url": new_page.url})
                log(f"{session.session_id} switched to popup {new_page.url[:120]}")
            except Exception as exc:  # pragma: no cover
                log(f"popup handling failed: {exc!r}", level="WARN")

        try:
            session.context.on("page", on_new_page)
        except Exception:  # pragma: no cover
            pass

    async def close_session(self, session: Session, save_state: bool = True) -> None:
        """保存 storage_state 后关闭 context（同账号的目录互不共享）。"""
        if session.closed:
            return
        saved: str | None = None
        if save_state:
            try:
                path = session.storage_state_path or paths.account_state_path(session.code)
                await session.context.storage_state(path=str(path))
                saved = str(path)
                session.note("session.close", {"savedState": saved})
            except Exception as exc:
                log(f"storage_state save failed for {session.code}: {exc!r}", level="WARN")
        try:
            await session.context.close()
        except Exception as exc:  # pragma: no cover
            log(f"context.close failed: {exc!r}", level="WARN")
        session.closed = True
        session.note("closed", {"savedState": saved})

    def info(self) -> dict:
        return {
            "started": self.started,
            "browsers": {("headless" if k else "headed"): v for k, v in self._versions.items()},
            "chromium": self.chromium_path(),
            "chromiumBuild": self.chromium_build(),
        }


def account_from_env(code: str) -> dict:  # pragma: no cover - 调试便利
    return {"code": code, "media": os.environ.get("MEDIA_MEDIA", "unknown"),
            "account": code}

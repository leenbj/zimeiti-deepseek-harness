#!/usr/bin/env python3
"""``python -m engine.sessiond`` —— 常驻 Python 浏览器引擎（NDJSON JSON-RPC over stdio）。

契约（SPEC §2 / §6）：
  * stdin 逐行读 NDJSON 请求；stdout **只**写协议帧；日志全部走 stderr；
  * 任何异常都变成 ``{"id":..,"ok":false,"error":{code,message,details}}``，绝不崩；
  * 同一进程内可并行多个会话；请求按「隔离键」保序（见 :class:`Engine`）；
  * ``--selftest`` 不开浏览器，跑纯逻辑自检并以退出码表示成败。
"""
from __future__ import annotations

import asyncio
import functools
import importlib
import inspect
import json
import os
import re
import shutil
import signal
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any

# --- --selftest 必须在 import paths 之前把数据目录指到临时目录 -----------------
# 用标记变量保证幂等：本模块可能被 `python -m` 与 importlib 各加载一次，
# 若每次都 mkdtemp，paths.DATA_DIR（首次绑定）与 env 就会指向两个不同目录。
_SELFTEST_MARK = "__MEDIA_SELFTEST_DIR__"
_SELFTEST_TMP: Path | None = None
if "--selftest" in sys.argv[1:]:
    if _SELFTEST_MARK not in os.environ:
        os.environ[_SELFTEST_MARK] = tempfile.mkdtemp(prefix="media-selftest-")
    _SELFTEST_TMP = Path(os.environ[_SELFTEST_MARK])
    os.environ["MEDIA_DATA_DIR"] = str(_SELFTEST_TMP)

try:  # python -m engine.sessiond
    from . import actions, browser, config_store, fingerprint, observe, paths
    from . import proxy_pool, rpc
    from .session import ActionError, Session
except ImportError:  # pragma: no cover - python engine/sessiond.py
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from engine import actions, browser, config_store, fingerprint, observe, paths
    from engine import proxy_pool, rpc
    from engine.session import ActionError, Session

VERSION = "1.0.0"

# 会改动「有哪些会话 / 会话是否还活着 / 账号配置」的方法，作为全局顺序屏障：
# 任何**在其之后**到达的请求都会等它完成，于是
# `Get-Content script.ndjson | python -m engine.sessiond` 这种一次性灌入也能按序执行。
# 账号增删改是毫秒级本地写，做成屏障可以避免「先 upsert 再 open」被并发打乱；
# 长时间操作（account.login / play.run / proxy.fetch）**不**做屏障，否则会拖住别的账号。
BARRIER_METHODS = {"session.open", "session.close", "account.upsert", "account.remove",
                   "account.bindProxy"}

# 平台登录配置：URL 与失败标记取自 media-publish-skill 的 login.py / setup_accounts.py
PLATFORMS: dict[str, dict[str, Any]] = {
    "sohu": {
        "label": "搜狐号",
        "login_url": "https://mp.sohu.com/mpfe/v4/login",
        "check_url": "https://mp.sohu.com/mpfe/v4/index",
        "success_url_contains": ["mp.sohu.com"],
        "fail_url_contains": ["mpfe/v4/login", "passport.sohu.com"],
        # 手机号/短信验证是登录流程里的**一步**，不是登录成功的标志。它通常仍在 mp.sohu.com 下，
        # 只按 URL 判定就会把「等待验证」误判成「已登录」，于是在用户还没验证完时保存并关窗
        # —— 实测踩过：登录 60 秒就返回成功，而窗口里正显示「输入手机号验证」。
        # 命中这些词即视为未登录，探测会继续等待；_verify_login 复用同一套规则，所以保存后的校验同样严格。
        # 「安全验证」这个纯文本标记**故意不在这里**：搜狐后台页面自身就常带这四个字
        # （安全设置入口、常驻的风控组件），把它当失败标记会让登录成功也永远判不通过。
        # 真正需要人操作的信号是**可见的**验证输入框（见 _verification_fields）。
        "fail_text_contains": ["请登录", "手机号验证", "手机验证", "短信验证",
                               "请输入验证码", "获取验证码", "请完成验证", "身份验证", "验证手机号"],
    },
    "toutiao": {
        "label": "头条号",
        "login_url": "https://mp.toutiao.com/profile_v4/index",
        "check_url": "https://mp.toutiao.com/profile_v4/index",
        "success_url_contains": ["mp.toutiao.com"],
        "fail_url_contains": ["sso.toutiao.com", "passport", "/login"],
        "fail_text_contains": ["扫码登录", "登录后继续", "手机号验证", "手机验证", "短信验证",
                               "请输入验证码", "获取验证码", "请完成验证", "身份验证"],
    },
    "csdn": {
        "label": "CSDN博客",
        "login_url": "https://passport.csdn.net/login?code=applets",
        "check_url": "https://mp.csdn.net/mp_blog/creation/editor",
        "success_url_contains": ["csdn.net"],
        "fail_url_contains": ["passport.csdn.net"],
        "fail_text_contains": ["请登录", "登录后", "手机号验证", "手机验证", "短信验证",
                               "请输入验证码", "获取验证码", "请完成验证", "身份验证"],
    },
}

# session.resume 认为「页面还不可用」的告警词
BLOCKING_ALERTS = {"安全验证", "验证码", "滑动验证", "滑块", "人机验证", "captcha",
                   "verify", "verification", "login-redirect", "重新登录", "请登录"}


# --------------------------------------------------------------------- 参数

_MISSING = object()


def _req(params: dict, key: str, default: Any = _MISSING) -> Any:
    if key in params and params[key] is not None:
        return params[key]
    if default is _MISSING:
        raise rpc.RpcError("PARAM_MISSING", f"missing required param {key!r}",
                           {"param": key, "got": sorted(params)[:30]})
    return default


def _p_str(params: dict, key: str, default: Any = _MISSING) -> str:
    val = _req(params, key, default)
    if not isinstance(val, str) or not val.strip():
        raise rpc.RpcError("BAD_REQUEST", f"param {key!r} must be a non-empty string",
                           {"param": key, "got": type(val).__name__})
    return val.strip()


def _p_opt_str(params: dict, key: str) -> str | None:
    val = params.get(key)
    if val is None:
        return None
    if not isinstance(val, str):
        raise rpc.RpcError("BAD_REQUEST", f"param {key!r} must be a string",
                           {"param": key, "got": type(val).__name__})
    return val


def _p_bool(params: dict, key: str, default: bool = False) -> bool:
    val = params.get(key, default)
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "yes", "on")
    return bool(val)


def _p_int(params: dict, key: str, default: int | None = None) -> int | None:
    val = params.get(key, default)
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        raise rpc.RpcError("BAD_REQUEST", f"param {key!r} must be an integer",
                           {"param": key, "got": val}) from None


def _session(engine: "Engine", params: dict) -> Session:
    sid = _p_str(params, "sessionId")
    session = engine.sessions.get(sid)
    if session is None:
        raise rpc.RpcError("SESSION_NOT_FOUND", f"no such session {sid!r}",
                           {"sessionId": sid, "sessions": sorted(engine.sessions)})
    return session


def _norm_server(server: str) -> str:
    s = str(server or "").strip()
    return s if "://" in s else "http://" + s


def _public_proxy(proxy: dict | None) -> dict | None:
    if not proxy:
        return None
    return {
        "server": proxy.get("server"),
        "username": proxy.get("username") or None,
        "hasPassword": bool(proxy.get("password")),
        "expiresAt": proxy.get("expiresAt"),
        "source": proxy.get("source"),
    }


def _public_fp(fp: dict) -> dict:
    out = dict(fingerprint.to_public(fp))
    out["ua_major"] = fp.get("chrome_major")
    vp = fp.get("viewport") or {}
    out["viewport_size"] = f"{vp.get('width')}x{vp.get('height')}"
    return out


def _resolve_proxy(code: str, policy: str) -> tuple[dict | None, list[str]]:
    """返回 (proxy|None, warnings)。未配置代理池时降级直连并**明确告警**。"""
    warnings: list[str] = []
    if policy == "direct":
        return None, warnings
    cfg = config_store.load_proxies()
    bound = config_store.load_account_proxy(code)
    usable = proxy_pool.extractor_candidates(cfg)
    if not usable and not bound:
        warnings.append("未绑定代理，且 proxies.yaml 没有可用提取器"
                        "（extractors.apipool.url 为空 / static 为空）→ 本次直连")
        return None, warnings
    try:
        proxy = proxy_pool.get_for_account(code, policy)
    except proxy_pool.ProxyUnavailable as exc:
        raise rpc.RpcError(
            "PROXY_UNAVAILABLE",
            f"代理不可用（这不是登录态失效）：{exc.message}",
            {"code": code, "policy": policy, "details": exc.details}) from exc
    if proxy is None:
        warnings.append("未绑定代理 → 直连（建议 account.bindProxy 绑定独立 IP）")
    return proxy, warnings


# -------------------------------------------------------------------- Engine

class Engine:
    """会话注册表 + 顺序控制。

    每个请求有一个「隔离键」（``session:<id>`` / ``account:<code>``）：
    同键请求按到达顺序串行，不同键请求并行。``session.open`` / ``session.close``
    额外充当全局屏障，保证「先 open 再用」的依赖在灌入式脚本里也成立。
    """

    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.bm = browser.BrowserManager()
        self.started_at = time.time()
        self._global: asyncio.Future | None = None
        self._keys: dict[str, asyncio.Future] = {}

    # ------------------------------------------------------------ ordering

    @staticmethod
    def _done() -> asyncio.Future:
        fut = asyncio.get_running_loop().create_future()
        fut.set_result(None)
        return fut

    @staticmethod
    def _key_for(method: str, params: dict) -> str | None:
        sid = params.get("sessionId")
        if isinstance(sid, str) and sid.strip():
            return f"session:{sid.strip()}"
        if method.split(".")[0] in ("account", "proxy"):
            code = params.get("code") or params.get("accountCode")
            if isinstance(code, str) and code.strip():
                return f"account:{code.strip()}"
        return None

    def reserve(self, method: str, params: dict) -> tuple[list[asyncio.Future], asyncio.Future]:
        """**同步**占位：必须在「收到该行」的当下调用（不能等任务真正开跑）。

        asyncio 的 ``Queue.get()`` 在队列非空时不一定会把控制权交回事件循环，所以一次性
        灌入的多行会在任何一个任务开始执行之前被全部 create_task；若把占位逻辑放进任务里，
        所有任务读到的都是同一个初始闸门，顺序就丢了。这里在到达顺序上同步占位。
        """
        waits = [self._global or self._done()]
        key = self._key_for(method, params)
        if key:
            waits.append(self._keys.get(key) or self._done())
        # 闸门必须是**未完成**的 future（_done() 造出来就已经 set_result 了 —— 用它当闸门
        # 等于序列化完全失效，后续请求会立刻放行）
        gate = asyncio.get_running_loop().create_future()
        if method in BARRIER_METHODS:
            self._global = gate
        if key:
            self._keys[key] = gate
            if len(self._keys) > 512:
                for k, f in list(self._keys.items()):
                    if f.done() and f is not gate:
                        self._keys.pop(k, None)
        return waits, gate

    async def run_reserved(self, method: str, params: dict,
                           waits: list[asyncio.Future], gate: asyncio.Future) -> Any:
        for fut in waits:
            if not fut.done():
                try:
                    await asyncio.shield(fut)
                except Exception:  # 前序请求失败不能阻塞后续请求
                    pass
        try:
            handler = HANDLERS.get(method)
            if handler is None:
                raise rpc.RpcError("UNKNOWN_METHOD", f"unknown method {method!r}",
                                   {"method": method, "known": sorted(HANDLERS)})
            return await handler(self, params)
        finally:
            if not gate.done():
                gate.set_result(None)

    async def dispatch(self, method: str, params: dict) -> Any:
        waits, gate = self.reserve(method, params)
        return await self.run_reserved(method, params, waits, gate)

    async def shutdown(self) -> None:
        for sid, session in list(self.sessions.items()):
            try:
                await self.bm.close_session(session, save_state=True)
            except Exception as exc:  # pragma: no cover
                rpc.log(f"shutdown: close {sid} failed: {exc!r}", level="WARN")
            self.sessions.pop(sid, None)
        await self.bm.stop()


# ------------------------------------------------------------------ handlers

def _playwright_version() -> str | None:
    try:
        from importlib.metadata import version
        return version("playwright")
    except Exception:
        try:
            import playwright
            return getattr(playwright, "__version__", None)
        except Exception:  # pragma: no cover
            return None


def _detect_chromium_path() -> str | None:
    """不启动 playwright 也能报出 chromium 可执行文件路径。"""
    roots: list[Path] = []
    env = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if env:
        roots.append(Path(env))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(Path(local) / "ms-playwright")
    roots.append(Path.home() / ".cache" / "ms-playwright")
    best: str | None = None
    for root in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.glob("chromium-*")):
            for rel in ("chrome-win64/chrome.exe", "chrome-win/chrome.exe",
                        "chrome-linux/chrome",
                        "chrome-mac/Chromium.app/Contents/MacOS/Chromium"):
                candidate = d / rel
                if candidate.exists():
                    best = str(candidate)
    return best


def _dependency_report() -> dict:
    """报出 PyYAML 的实际来源与版本。

    这条信息专为「引擎起不来」而存在：PyYAML 曾被一次运行时升级悄悄带走，操作者只拿到一句
    ``ENGINE_EXITED``，没有任何线索。现在 ``engine.status`` 会直说用的是随包副本还是解释器自带的。
    """
    import yaml

    location = Path(getattr(yaml, "__file__", "") or "")
    return {
        "yaml": {
            "version": getattr(yaml, "__version__", None),
            "module": str(location) or None,
            "bundled": "_vendor" in location.parts,
            "libyaml": bool(getattr(yaml, "__with_libyaml__", False)),
        },
        # requests 已经不是依赖项：代理抓取与健康检查改用标准库 urllib。
        "requests": {"required": False, "note": "replaced by the standard library (urllib.request)"},
    }


async def h_engine_status(engine: Engine, params: dict) -> dict:
    info = engine.bm.info()
    return {
        "version": VERSION,
        "dataDir": str(paths.DATA_DIR),
        "sessions": len(engine.sessions),
        "sessionIds": sorted(engine.sessions),
        "accounts": len(config_store.list_accounts()),
        "playwright": _playwright_version(),
        "chromium": info.get("chromium") or _detect_chromium_path(),
        "chromiumBuild": info.get("chromiumBuild"),
        "browserRunning": bool(info.get("started")),
        "browserVersions": info.get("browsers") or {},
        "python": sys.version.split()[0],
        "pid": os.getpid(),
        "uptimeSec": int(time.time() - engine.started_at),
        "protocol": "ndjson",
        "methods": len(HANDLERS),
        "recipes": len(config_store.list_recipes()),
        # 依赖来源：yaml 是随包分发还是解释器自带。这类信息在排查「引擎起不来」时最有用 ——
        # 之前 PyYAML 被运行时升级悄悄带走，界面上只看到一句 ENGINE_EXITED，没有任何线索。
        "dependencies": _dependency_report(),
    }


async def h_session_open(engine: Engine, params: dict) -> dict:
    code = _p_str(params, "accountCode")
    account = config_store.get_account(code)
    if account is None:
        raise rpc.RpcError("BAD_REQUEST",
                           f"unknown account code {code!r}（先调用 account.upsert）",
                           {"accountCode": code,
                            "known": [a.get("code") for a in config_store.list_accounts()][:50]})
    headless = _p_bool(params, "headless", True)
    interactive = _p_bool(params, "interactive", False)
    policy = (_p_opt_str(params, "proxyPolicy") or "sticky").lower()
    if policy not in ("sticky", "rotate", "direct"):
        raise rpc.RpcError("BAD_REQUEST", f"bad proxyPolicy {policy!r}",
                           {"allowed": ["sticky", "rotate", "direct"]})

    fp = fingerprint.derive(code)
    viewport = params.get("viewport")
    if viewport is not None:
        if not isinstance(viewport, dict):
            raise rpc.RpcError("BAD_REQUEST", "'viewport' must be an object",
                               {"got": type(viewport).__name__})
        try:
            fp["viewport"] = {"width": int(viewport.get("width")),
                              "height": int(viewport.get("height"))}
        except (TypeError, ValueError):
            raise rpc.RpcError("BAD_REQUEST", "viewport needs integer width/height",
                               {"viewport": viewport}) from None
    locale = _p_opt_str(params, "locale")
    if locale:
        fp["locale"] = locale
        fp["languages"] = fingerprint.languages_for(locale)
        fp["accept_language"] = fingerprint.accept_language(locale)
    tz = _p_opt_str(params, "timezoneId")
    if tz:
        fp["timezone_id"] = tz
    ua = _p_opt_str(params, "userAgent")
    if ua:
        fp["user_agent"] = ua

    proxy, warnings = _resolve_proxy(code, policy)
    session = await engine.bm.open_session(
        {**account, "_proxy_policy": policy}, proxy=proxy, fingerprint=fp,
        headless=headless, interactive=interactive)
    session.warnings.extend(warnings)
    engine.sessions[session.session_id] = session
    return {
        "sessionId": session.session_id,
        "accountCode": session.code,
        "media": session.media,
        "proxy": _public_proxy(session.proxy),
        "proxyPolicy": policy,
        "storageStatePath": str(session.storage_state_path or ""),
        "storageStateExists": bool(session.storage_state_path
                                   and session.storage_state_path.exists()),
        "fingerprint": _public_fp(session.fingerprint),
        "headless": session.headless,
        "interactive": session.interactive,
        "logPath": str(session.log_path or ""),
        "warnings": session.warnings,
    }


async def h_session_close(engine: Engine, params: dict) -> dict:
    session = _session(engine, params)
    save = _p_bool(params, "saveState", True)
    await engine.bm.close_session(session, save_state=save)
    engine.sessions.pop(session.session_id, None)
    saved = str(session.storage_state_path) if (save and session.storage_state_path) else None
    return {"ok": True, "sessionId": session.session_id, "savedStatePath": saved,
            "warnings": session.warnings}


async def h_session_list(engine: Engine, params: dict) -> dict:
    return {"sessions": [s.list_item() for s in engine.sessions.values()]}


async def h_session_state(engine: Engine, params: dict) -> dict:
    session = _session(engine, params)
    return await session.state()


async def h_session_handoff(engine: Engine, params: dict) -> dict:
    session = _session(engine, params)
    reason = _p_opt_str(params, "reason") or "manual"
    hint = _p_opt_str(params, "hint") or "请在浏览器窗口中完成人工操作（验证码/扫码），然后调用 session.resume"
    session.handed_off = True
    session.note("handoff", {"reason": reason, "hint": hint, "url": session.safe_url()})
    rpc.emit_frame(rpc.encode_event("handoff", {
        "sessionId": session.session_id, "reason": reason, "hint": hint,
        "url": session.safe_url(), "headless": session.headless,
    }))
    brought = False
    try:
        await session.page.bring_to_front()
        brought = True
    except Exception as exc:
        rpc.log(f"bring_to_front failed: {exc!r}", level="WARN")
    return {"ok": True, "hint": hint, "reason": reason, "url": session.safe_url(),
            "broughtToFront": brought, "headless": session.headless}


async def h_session_resume(engine: Engine, params: dict) -> dict:
    session = _session(engine, params)
    timeout_ms = _p_int(params, "timeoutMs", 300000) or 300000
    deadline = time.perf_counter() + max(1, timeout_ms) / 1000
    started = time.perf_counter()
    last: dict[str, Any] = {}
    while True:
        url = session.safe_url()
        ready = ""
        text = ""
        title = ""
        try:
            ready = str(await session.page.evaluate("() => document.readyState"))
        except Exception:
            ready = "unknown"
        try:
            title = await session.page.title()
        except Exception:
            title = ""
        try:
            text = str(await session.page.evaluate(
                "() => (document.body && document.body.innerText || '').slice(0, 20000)"))
        except Exception:
            text = ""
        alerts = observe.detect_alerts(url, title, text)
        blocking = [a for a in alerts if a in BLOCKING_ALERTS]
        last = {"url": url, "readyState": ready, "alerts": alerts, "blocking": blocking}
        if ready in ("interactive", "complete") and not blocking:
            session.handed_off = False
            waited = int((time.perf_counter() - started) * 1000)
            session.note("resume", {"url": url, "waitedMs": waited})
            return {"ok": True, "url": url, "waitedMs": waited, "readyState": ready,
                    "title": title}
        if time.perf_counter() >= deadline:
            raise rpc.RpcError(
                "TIMEOUT",
                f"session.resume 超时（{timeout_ms} ms）：页面仍不可用"
                "（可能还在验证码/登录页）",
                {"sessionId": session.session_id, "timeoutMs": timeout_ms, **last,
                 "hint": "人工处理完成后重新调用 session.resume"})
        await asyncio.sleep(1.0)


async def h_session_snapshot(engine: Engine, params: dict) -> dict:
    session = _session(engine, params)
    return await observe.snapshot(session,
                                  max_elements=_p_int(params, "maxElements", 120) or 120,
                                  include_text=_p_bool(params, "includeText", True))


async def h_session_screenshot(engine: Engine, params: dict) -> dict:
    session = _session(engine, params)
    return await observe.screenshot(session, full_page=_p_bool(params, "fullPage", False),
                                    label=_p_opt_str(params, "label") or "shot")


# ------------------------------------------------------------------ act.*

async def _act(engine: Engine, params: dict, _type: str) -> dict:
    session = _session(engine, params)
    step = {k: v for k, v in params.items()
            if k not in ("sessionId", "dryRun", "params")}
    step["type"] = _type
    p = params.get("params")
    if isinstance(p, dict):
        step["_params"] = p
    try:
        return await actions.execute(session, step,
                                     dry_run=_p_bool(params, "dryRun", False))
    except ActionError as exc:
        raise rpc.RpcError(exc.code, exc.message, exc.details) from exc


# ------------------------------------------------------------------ account

async def h_account_list(engine: Engine, params: dict) -> dict:
    check = _p_bool(params, "checkHealth", False)
    out = []
    for acc in config_store.list_accounts():
        code = str(acc.get("code") or "")
        state = paths.account_state_path(code)
        proxy = proxy_pool.describe(code)
        if check and proxy.get("bound"):
            health = await asyncio.to_thread(proxy_pool.health, code)
            proxy["healthy"] = bool(health.get("ok"))
            proxy["ip"] = health.get("ip")
        item = {
            "code": code,
            "media": acc.get("media"),
            "account": acc.get("account"),
            "note": acc.get("note") or "",
            "hasState": state.exists() and state.stat().st_size > 2,
            "statePath": str(state),
            "proxy": proxy,
            "hasSession": any(s.code == code for s in engine.sessions.values()),
        }
        if acc.get("lastRunAt"):
            item["lastRunAt"] = acc["lastRunAt"]
        out.append(item)
    return {"accounts": out}


async def h_account_upsert(engine: Engine, params: dict) -> dict:
    code = _p_str(params, "code")
    media = _p_str(params, "media")
    account = _p_opt_str(params, "account") or ""
    note = _p_opt_str(params, "note") or ""
    entry = config_store.upsert_account(code, media, account, note)
    return {"ok": True, "account": entry}


async def h_account_remove(engine: Engine, params: dict) -> dict:
    code = _p_str(params, "code")
    purge = _p_bool(params, "purgeState", False)
    closed = []
    for sid, session in list(engine.sessions.items()):
        if session.code == code:
            try:
                await engine.bm.close_session(session, save_state=False)
            except Exception as exc:  # pragma: no cover
                rpc.log(f"close {sid} failed: {exc!r}", level="WARN")
            engine.sessions.pop(sid, None)
            closed.append(sid)
    config_store.remove_account(code, purge_state=purge)
    return {"ok": True, "code": code, "purged": purge, "closedSessions": closed}


async def h_account_bind_proxy(engine: Engine, params: dict) -> dict:
    code = _p_str(params, "code")
    if config_store.get_account(code) is None:
        raise rpc.RpcError("BAD_REQUEST", f"unknown account code {code!r}",
                           {"accountCode": code})
    proxy = params.get("proxy")
    if proxy is None:
        proxy_pool.bind(code, None)
        return {"ok": True, "code": code, "proxy": proxy_pool.describe(code),
                "detail": "已解绑（直连）"}
    if not isinstance(proxy, dict):
        raise rpc.RpcError("BAD_REQUEST", "'proxy' must be an object or null",
                           {"got": type(proxy).__name__})
    server = _norm_server(_p_str(proxy, "server"))
    payload = {"server": server, "username": _p_opt_str(proxy, "username"),
               "password": _p_opt_str(proxy, "password"),
               "source": "manual", "boundAt": None}
    proxy_pool.bind(code, payload)
    return {"ok": True, "code": code, "proxy": proxy_pool.describe(code),
            "detail": "密码已写入 secrets.yaml（未写入 accounts.yaml / proxy.json）"}


async def _collect_page_text(page) -> str:
    """主文档 + **每个 iframe** 的文本。

    为什么必须扫 frame：验证码/手机验证组件几乎总是放在 iframe 里，而 `page.content()` 只返回主文档。
    实测后果很严重 —— 手机号验证页明明显示着，探测却看不到任何「验证」字样，于是判定登录成功、
    一两秒内就保存并关窗，用户根本没机会输入验证码。截断上限也一并放大：搜狐后台是大型 SPA，
    原先 2 万字符的窗口会把弹层内容直接截掉。
    """
    parts: list[str] = []
    try:
        parts.append((await page.content())[:400000])
    except Exception:
        pass
    for frame in list(page.frames):
        if frame is page.main_frame:
            continue
        try:
            parts.append((await frame.content())[:200000])
        except Exception:
            continue
    return "\n".join(parts)


async def _verification_fields(page) -> list[str]:
    """任何 frame 里**可见**的验证输入框，都说明验证还没走完。

    只统计可见元素，这一点是必需的：后台页面常驻着隐藏的表单 DOM（绑定手机、安全设置等），
    用 count() 会把它们当成「需要验证」—— 实测后果是登录明明已经进了内容管理页，判定却永远
    不通过，窗口一直开着，还连带禁用了其他账号的登录按钮。
    """
    selectors = ('input[placeholder*="验证码"]', 'input[placeholder*="手机号"]',
                 'input[placeholder*="手机"]', 'input[placeholder*="短信"]')
    hits: list[str] = []
    for frame in list(page.frames):
        for sel in selectors:
            try:
                locator = frame.locator(sel)
                if await locator.count() > 0 and await locator.first.is_visible():
                    hits.append(sel)
            except Exception:
                continue
    return hits


async def _login_probe(session: Session, cfg: dict, signal: dict) -> dict:
    page = session.page
    url = session.safe_url()
    html = await _collect_page_text(page)
    title = ""
    try:
        title = await page.title()
    except Exception:
        pass
    fail_urls = list(signal.get("failUrlContains") or cfg["fail_url_contains"])
    fail_texts = list(signal.get("failTextContains") or cfg["fail_text_contains"])
    success_urls = list(signal.get("successUrlContains") or cfg["success_url_contains"])
    reasons: list[str] = []
    if not any(s in url for s in success_urls):
        reasons.append(f"URL 未命中成功域名 {success_urls}")
    hit = [f for f in fail_urls if f in url]
    if hit:
        reasons.append(f"URL 命中失败标记 {hit}")
    hit_text = [t for t in fail_texts if t in html]
    if hit_text:
        reasons.append(f"页面文本命中失败标记 {hit_text}")
    fields = await _verification_fields(page)
    if fields:
        reasons.append(f"检测到可见的验证输入框 {fields[:3]}")
    # 被风控拦下时，后台路径拿得到，但**正文是空的**（内容根本没渲染）。用正文字数把这种
    # 「看着像后台、其实被拦住」的状态区分出来，否则它会伪装成登录成功。
    body_len = 0
    try:
        body_len = int(await page.evaluate(
            "() => (document.body ? document.body.innerText.trim().length : 0)"))
    except Exception:
        body_len = 0
    # `extra` must exist before anything writes into it. It used to be declared further down, so the
    # line below raised `UnboundLocalError` on every probe — which made a sign-in window close itself a
    # couple of seconds after opening and reported the failure as an opaque INTERNAL error.
    extra: dict[str, Any] = {}
    extra["bodyTextLength"] = body_len
    if not reasons and body_len < 40:
        reasons.append(f"后台页面正文为空（{body_len} 字符），可能被风控拦截")
    if signal.get("urlContains") and str(signal["urlContains"]) not in url:
        reasons.append(f"URL 未包含 {signal['urlContains']!r}")
    if signal.get("selector"):
        try:
            count = await page.locator(str(signal["selector"])).count()
            extra["selectorCount"] = count
            if count <= 0:
                reasons.append(f"选择器未出现 {signal['selector']!r}")
        except Exception as exc:
            reasons.append(f"selector 检测失败：{exc!r}")
    if signal.get("text") and str(signal["text"]) not in html:
        reasons.append(f"页面未出现文本 {signal['text']!r}")
    return {"loggedIn": not reasons, "url": url, "title": title,
            "reasons": reasons[:5], **extra}


async def _verify_login(session: Session, cfg: dict, signal: dict) -> dict:
    page = session.page
    check_url = str(signal.get("checkUrl") or cfg["check_url"])
    try:
        await page.goto(check_url, wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3.0)
    except Exception as exc:
        return {"ok": False, "loggedIn": False, "url": session.safe_url(),
                "title": "", "reasons": [f"打开校验页失败：{exc!r}"],
                "detail": f"打开校验页失败：{exc!r}", "checkUrl": check_url}
    probe = await _login_probe(session, cfg, signal)
    probe["ok"] = bool(probe.get("loggedIn"))
    probe["checkUrl"] = check_url
    probe["detail"] = "登录态有效" if probe["ok"] else "；".join(
        probe.get("reasons") or ["未知原因"])
    return probe


async def h_account_login(engine: Engine, params: dict) -> dict:
    """打开有头浏览器 → 等人工扫码（或调用方给的信号）→ 保存 storage_state。"""
    code = _p_str(params, "code")
    account = config_store.get_account(code)
    if account is None:
        raise rpc.RpcError("BAD_REQUEST", f"unknown account code {code!r}",
                           {"accountCode": code})
    media = str(account.get("media") or "").lower()
    cfg = PLATFORMS.get(media)
    if cfg is None:
        raise rpc.RpcError("UNSUPPORTED", f"media {media!r} 没有内置登录配置",
                           {"media": media, "known": sorted(PLATFORMS)})
    signal = params.get("signal") if isinstance(params.get("signal"), dict) else {}
    headless = _p_bool(params, "headless", False)
    # 十分钟而不是五分钟：扫码之后常常还要过一道手机号/短信验证。
    timeout_ms = _p_int(params, "timeoutMs", 600000) or 600000
    policy = (_p_opt_str(params, "proxyPolicy")
              or proxy_pool.resolve_policy(code)).lower()
    proxy, warnings = _resolve_proxy(code, policy)
    hint = (f"请在弹出的浏览器窗口登录{cfg['label']}（扫码或账密）。"
            f"若窗口里出现手机号 / 短信验证，请在那里完成并输入验证码 —— "
            f"**验证通过前我不会关闭窗口**；你也可以随时自己关闭窗口来结束（我会保存当时的状态并提示未校验）。"
            f"最长等待 {timeout_ms // 1000}s")
    session = await engine.bm.open_session({**account, "_proxy_policy": policy},
                                          proxy=proxy,
                                          fingerprint=fingerprint.derive(code),
                                          headless=headless, interactive=True)
    session.warnings.extend(warnings)
    engine.sessions[session.session_id] = session
    started = time.perf_counter()
    try:
        rpc.emit_frame(rpc.encode_event("progress", {
            "method": "account.login", "code": code, "status": "waiting",
            "loginUrl": cfg["login_url"], "hint": hint, "sessionId": session.session_id}))
        try:
            await session.page.goto(cfg["login_url"], wait_until="domcontentloaded",
                                    timeout=90000)
        except Exception as exc:
            rpc.log(f"login page goto failed: {exc!r}", level="WARN")
        deadline = time.perf_counter() + max(1, timeout_ms) / 1000
        state_path = paths.account_state_path(code)
        last: dict[str, Any] = {}
        logged_in = False
        closed_by_user = False
        saved_at: float | None = None
        next_save = 0.0
        while time.perf_counter() < deadline:
            # 用户手动关掉窗口＝他结束了这次登录（可能已完成验证，也可能想放弃）。系统不再替他决定，
            # 只保存「当时」的状态，并如实标注是否校验过。
            if session.page.is_closed():
                closed_by_user = True
                rpc.log(f"login window closed by the operator (code={code})", level="INFO")
                break
            last = await _login_probe(session, cfg, signal)
            if last.get("loggedIn"):
                logged_in = True
                break
            # 等待期间周期性落盘：窗口一关，context 就取不到 storage_state 了，所以不能只在最后保存。
            now = time.perf_counter()
            if now >= next_save:
                next_save = now + 5.0
                try:
                    await session.context.storage_state(path=str(state_path))
                    saved_at = now
                except Exception as exc:
                    rpc.log(f"periodic storage_state save failed: {exc!r}", level="WARN")
            await asyncio.sleep(2.0)
        waited_ms = int((time.perf_counter() - started) * 1000)
        if not logged_in and not closed_by_user:
            raise rpc.RpcError(
                "TIMEOUT",
                f"登录超时（{timeout_ms} ms）：未检测到登录成功信号",
                {"code": code, "media": media, "timeoutMs": timeout_ms,
                 "loginUrl": cfg["login_url"], "url": last.get("url"),
                 "reasons": last.get("reasons"), "hint": hint})
        # 尽力做最终保存；context 可能已随窗口关闭而失效，那就用周期的最后一次落盘结果。
        try:
            await session.context.storage_state(path=str(state_path))
            saved_at = time.perf_counter()
        except Exception as exc:
            if saved_at is None:
                raise rpc.RpcError("INTERNAL", f"无法保存登录态：{exc!r}",
                                   {"code": code, "statePath": str(state_path)})
            rpc.log(f"final storage_state save skipped ({exc!r}); using the periodic copy", level="WARN")
        session.note("login", {"code": code, "statePath": str(state_path),
                               "closedByUser": closed_by_user})
        state_bytes = state_path.stat().st_size if state_path.exists() else 0
        # 窗口已被你手动关闭时无法再导航校验，此刻如实标注「未校验」，而不是谎报有效。
        if session.page.is_closed():
            return {"ok": True, "code": code, "media": media, "label": cfg["label"],
                    "statePath": str(state_path), "stateBytes": state_bytes,
                    "url": last.get("url"), "title": last.get("title"),
                    "detail": (f"窗口由你手动关闭，已保存当时的状态（{state_bytes} 字节），"
                               f"未做校验 —— 建议用 media_account check 复核"),
                    "waitedMs": waited_ms, "closedByUser": True, "verified": False,
                    "proxy": _public_proxy(proxy), "warnings": warnings}
        verify = await _verify_login(session, cfg, signal)
        if not verify.get("ok"):
            raise rpc.RpcError("LOGIN_REQUIRED", "登录态校验未通过（可能未完成登录）",
                               {"code": code, "statePath": str(state_path),
                                "url": verify.get("url"), "detail": verify.get("detail"),
                                "reasons": verify.get("reasons")})
        return {"ok": True, "code": code, "media": media, "label": cfg["label"],
                "statePath": str(state_path), "stateBytes": state_bytes,
                "url": verify.get("url"), "title": verify.get("title"),
                "detail": verify.get("detail"), "waitedMs": waited_ms,
                "closedByUser": False, "verified": True,
                "proxy": _public_proxy(proxy), "warnings": warnings}
    finally:
        engine.sessions.pop(session.session_id, None)
        try:
            await engine.bm.close_session(session, save_state=False)
        except Exception as exc:  # pragma: no cover
            rpc.log(f"login session close failed: {exc!r}", level="WARN")


async def h_account_check_login(engine: Engine, params: dict) -> dict:
    code = _p_str(params, "code")
    account = config_store.get_account(code)
    if account is None:
        raise rpc.RpcError("BAD_REQUEST", f"unknown account code {code!r}",
                           {"accountCode": code})
    media = str(account.get("media") or "").lower()
    cfg = PLATFORMS.get(media)
    if cfg is None:
        raise rpc.RpcError("UNSUPPORTED", f"media {media!r} 没有内置登录配置",
                           {"media": media, "known": sorted(PLATFORMS)})
    state = paths.account_state_path(code)
    if not (state.exists() and state.stat().st_size > 2):
        return {"ok": False, "status": "unknown", "url": None,
                "detail": f"无登录态文件：{state}，请先 account.login"}
    policy = (_p_opt_str(params, "proxyPolicy")
              or proxy_pool.resolve_policy(code)).lower()
    proxy, warnings = _resolve_proxy(code, policy)
    session = await engine.bm.open_session(account, proxy=proxy,
                                          fingerprint=fingerprint.derive(code),
                                          headless=True)
    try:
        session.page.set_default_navigation_timeout(60000)
        verify = await _verify_login(session, cfg, {})
        return {"ok": bool(verify.get("ok")),
                "status": "valid" if verify.get("ok") else "invalid",
                "url": verify.get("url"), "title": verify.get("title"),
                "detail": verify.get("detail"), "reasons": verify.get("reasons"),
                "warnings": warnings, "proxy": _public_proxy(proxy)}
    finally:
        try:  # 只读校验：不回写 storage_state，避免污染
            await engine.bm.close_session(session, save_state=False)
        except Exception as exc:  # pragma: no cover
            rpc.log(f"checkLogin close failed: {exc!r}", level="WARN")


# -------------------------------------------------------------------- proxy

async def h_proxy_fetch(engine: Engine, params: dict) -> dict:
    code = _p_opt_str(params, "code")
    force = _p_bool(params, "force", False)
    try:
        proxy = await asyncio.to_thread(proxy_pool.fetch_proxy, code, force)
    except proxy_pool.ProxyUnavailable as exc:
        raise rpc.RpcError("PROXY_UNAVAILABLE", exc.message, exc.details) from exc
    return {"server": proxy.get("server"), "username": proxy.get("username") or None,
            "hasPassword": bool(proxy.get("password")),
            "expiresAt": proxy.get("expiresAt"), "source": proxy.get("source"),
            "ip": proxy.get("ip"), "extractor": proxy.get("extractor")}


async def h_proxy_test(engine: Engine, params: dict) -> dict:
    proxy = params.get("proxy")
    if proxy is not None:
        if not isinstance(proxy, dict) or not str(proxy.get("server") or "").strip():
            raise rpc.RpcError("BAD_REQUEST", "'proxy' needs at least 'server'",
                               {"proxy": proxy})
        payload = dict(proxy)
        payload["server"] = _norm_server(payload["server"])
        if payload.get("username") and not payload.get("password"):
            payload["password"] = config_store.get_proxy_secret(payload["server"],
                                                                payload["username"])
        return await asyncio.to_thread(proxy_pool.test, payload)
    code = _p_opt_str(params, "code")
    if not code:
        raise rpc.RpcError("PARAM_MISSING", "proxy.test needs 'code' or 'proxy'", {})
    if config_store.load_account_proxy(code) is None:
        return {"ok": False, "ip": None, "latencyMs": None, "bound": False,
                "detail": f"账号 {code} 未绑定代理（直连）"}
    return await asyncio.to_thread(proxy_pool.health, code)


async def h_proxy_rotate(engine: Engine, params: dict) -> dict:
    code = _p_str(params, "code")
    try:
        proxy = await asyncio.to_thread(proxy_pool.rotate, code)
    except proxy_pool.ProxyUnavailable as exc:
        raise rpc.RpcError("PROXY_UNAVAILABLE", exc.message, exc.details) from exc
    return {"ok": True, "code": code, "server": proxy.get("server"),
            "username": proxy.get("username") or None,
            "hasPassword": bool(proxy.get("password")),
            "expiresAt": proxy.get("expiresAt"), "source": proxy.get("source"),
            "ip": proxy.get("ip")}


# ------------------------------------------------------- record.* / play.*

def _optional_module(name: str):
    pkg = __package__ or "engine"
    try:
        return importlib.import_module(f".{name}", pkg)
    except Exception as exc:
        rpc.log(f"optional module {name} unavailable: {exc!r}", level="DEBUG")
        return None


def _unsupported(what: str, module: str) -> rpc.RpcError:
    return rpc.RpcError("UNSUPPORTED",
                        f"{what} 暂不可用：engine/{module}.py 未就绪",
                        {"module": f"engine/{module}.py"})


async def _maybe_await(fn, *args, **kwargs) -> Any:
    result = fn(*args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


async def h_record_start(engine: Engine, params: dict) -> dict:
    mod = _optional_module("record")
    if mod is None or not hasattr(mod, "start"):
        raise _unsupported("record.start", "record")
    session = _session(engine, params)
    return await _maybe_await(mod.start, session, _p_str(params, "recipeId"),
                              _p_str(params, "media"))


async def h_record_status(engine: Engine, params: dict) -> dict:
    mod = _optional_module("record")
    if mod is None or not hasattr(mod, "status"):
        raise _unsupported("record.status", "record")
    return await _maybe_await(mod.status, _session(engine, params))


async def h_record_note(engine: Engine, params: dict) -> dict:
    mod = _optional_module("record")
    if mod is None or not hasattr(mod, "note"):
        raise _unsupported("record.note", "record")
    return await _maybe_await(mod.note, _session(engine, params),
                              _p_str(params, "text"))


async def h_record_undo(engine: Engine, params: dict) -> dict:
    mod = _optional_module("record")
    if mod is None or not hasattr(mod, "undo"):
        raise _unsupported("record.undo", "record")
    return await _maybe_await(mod.undo, _session(engine, params),
                              _p_int(params, "count", 1) or 1)


async def h_record_save(engine: Engine, params: dict) -> dict:
    mod = _optional_module("record")
    if mod is None or not hasattr(mod, "save"):
        raise _unsupported("record.save", "record")
    session = _session(engine, params)
    kwargs: dict[str, Any] = {}
    for src, dst in (("recipeId", "recipe_id"), ("media", "media"), ("label", "label"),
                     ("params", "params"), ("sessionCheck", "session_check"),
                     ("verify", "verify"), ("accountCodes", "account_codes")):
        if src in params and params[src] is not None:
            kwargs[dst] = params[src]
    return await _maybe_await(mod.save, session,
                              overwrite=_p_bool(params, "overwrite", False), **kwargs)


def _load_recipe_params(params: dict) -> tuple[dict, Path | None]:
    path = _p_opt_str(params, "recipePath")
    if path:
        p = Path(path).expanduser()
        if not p.is_file():
            raise rpc.RpcError("RECIPE_INVALID", f"recipe file not found: {p}",
                               {"recipePath": str(p)})
        import yaml
        try:
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except Exception as exc:
            raise rpc.RpcError("RECIPE_INVALID", f"invalid recipe YAML: {exc}",
                               {"recipePath": str(p)}) from exc
        if not isinstance(data, dict):
            raise rpc.RpcError("RECIPE_INVALID", "recipe must be a mapping",
                               {"recipePath": str(p)})
        return data, p
    rid = _p_str(params, "recipeId")
    try:
        data, p = config_store.load_recipe(rid)
    except config_store.RecipeNotFound as exc:
        raise rpc.RpcError("RECIPE_INVALID", f"recipe not found: {rid}",
                           {"recipeId": rid, "searched": exc.searched}) from exc
    except config_store.ConfigError as exc:
        raise rpc.RpcError("RECIPE_INVALID", str(exc), {"recipeId": rid}) from exc
    return data, p


async def h_play_validate(engine: Engine, params: dict) -> dict:
    mod = _optional_module("play")
    if mod is None or not hasattr(mod, "validate"):
        raise _unsupported("play.validate", "play")
    recipe, path = _load_recipe_params(params)
    result = await _maybe_await(mod.validate, recipe)
    if isinstance(result, dict):
        result.setdefault("recipePath", str(path) if path else None)
    return result


async def h_play_run(engine: Engine, params: dict) -> dict:
    mod = _optional_module("play")
    if mod is None or not hasattr(mod, "run"):
        raise _unsupported("play.run", "play")
    recipe, path = _load_recipe_params(params)
    account_code = _p_str(params, "accountCode")
    run_params = params.get("params") or {}
    if not isinstance(run_params, dict):
        raise rpc.RpcError("BAD_REQUEST", "'params' must be an object",
                           {"got": type(run_params).__name__})

    def on_progress(*args, **kwargs) -> None:
        data: dict[str, Any] = {"method": "play.run"}
        payload = kwargs.get("data")
        if args and isinstance(args[0], dict):
            payload = args[0]
        elif args:
            data.update({"index": args[0],
                         "type": args[1] if len(args) > 1 else None,
                         "status": args[2] if len(args) > 2 else None})
        if isinstance(payload, dict):
            data.update(payload)
        rpc.emit_frame(rpc.encode_event("progress", data))

    result = await _maybe_await(
        mod.run, recipe, account_code=account_code, params=run_params,
        dry_run=_p_bool(params, "dryRun", False),
        headless=params.get("headless") if "headless" in params else None,
        stop_on_error=_p_bool(params, "stopOnError", True),
        heal=_p_bool(params, "heal", True),
        proxy_policy=(_p_opt_str(params, "proxyPolicy") or "sticky"),
        on_progress=on_progress)
    if isinstance(result, dict):
        result.setdefault("recipePath", str(path) if path else None)
    return result


async def h_play_backfill(engine: Engine, params: dict) -> dict:
    """审核后回查正式链接（搜狐/头条提交时拿不到链接，只能事后回查）。"""
    mod = _optional_module("play")
    if mod is None or not hasattr(mod, "backfill"):
        raise _unsupported("play.backfill", "play")
    recipe, path = _load_recipe_params(params)
    kwargs: dict[str, Any] = {
        "account_code": _p_str(params, "accountCode"),
        "title": _p_str(params, "title"),
        "headless": _p_bool(params, "headless", True),
    }
    policy = _p_opt_str(params, "proxyPolicy")
    if policy and policy != "sticky":
        try:
            accepted = inspect.signature(mod.backfill).parameters
        except (TypeError, ValueError):
            accepted = {}
        if "proxy_policy" in accepted:
            kwargs["proxy_policy"] = policy
        else:
            rpc.log("play.backfill does not accept proxyPolicy yet; using its default",
                    level="WARN")
    result = await _maybe_await(mod.backfill, recipe, **kwargs)
    if isinstance(result, dict):
        result.setdefault("recipePath", str(path) if path else None)
    return result


# --------------------------------------------------------------- method table

HANDLERS: dict[str, Any] = {
    "engine.status": h_engine_status,
    "session.open": h_session_open,
    "session.close": h_session_close,
    "session.list": h_session_list,
    "session.state": h_session_state,
    "session.handoff": h_session_handoff,
    "session.resume": h_session_resume,
    "session.snapshot": h_session_snapshot,
    "session.screenshot": h_session_screenshot,
    "account.list": h_account_list,
    "account.upsert": h_account_upsert,
    "account.remove": h_account_remove,
    "account.bindProxy": h_account_bind_proxy,
    "account.login": h_account_login,
    "account.checkLogin": h_account_check_login,
    "proxy.fetch": h_proxy_fetch,
    "proxy.test": h_proxy_test,
    "proxy.rotate": h_proxy_rotate,
    "record.start": h_record_start,
    "record.status": h_record_status,
    "record.note": h_record_note,
    "record.undo": h_record_undo,
    "record.save": h_record_save,
    "play.validate": h_play_validate,
    "play.run": h_play_run,
    "play.backfill": h_play_backfill,
}
for _t in actions.ACTION_TYPES:
    HANDLERS[f"act.{_t}"] = functools.partial(_act, _type=_t)


# ------------------------------------------------------------------ runtime

def _emit_error(req_id: Any, exc: BaseException, method: str | None = None) -> None:
    if isinstance(exc, rpc.RpcError):
        rpc.emit_frame(rpc.encode_error(req_id, exc.code, exc.message, exc.details))
        return
    if isinstance(exc, ActionError):
        rpc.emit_frame(rpc.encode_error(req_id, exc.code, exc.message, exc.details))
        return
    if isinstance(exc, proxy_pool.ProxyUnavailable):
        rpc.emit_frame(rpc.encode_error(req_id, "PROXY_UNAVAILABLE", exc.message,
                                        exc.details))
        return
    if isinstance(exc, config_store.RecipeNotFound):
        rpc.emit_frame(rpc.encode_error(req_id, "RECIPE_INVALID",
                                        f"recipe not found: {exc.recipe_id}",
                                        {"searched": exc.searched}))
        return
    timeoutish = isinstance(exc, asyncio.TimeoutError) or type(exc).__name__ == "TimeoutError"
    code = "TIMEOUT" if timeoutish else "INTERNAL"
    rpc.log("unhandled error: " + "".join(
        traceback.format_exception(type(exc), exc, exc.__traceback__)), level="ERROR")
    rpc.emit_frame(rpc.encode_error(
        req_id, code, f"{type(exc).__name__}: {exc}",
        {"method": method, "traceback": traceback.format_exc()[-2000:]}))


async def run_request(engine: Engine, req_id: Any, method: str, params: dict,
                      waits: list[asyncio.Future], gate: asyncio.Future) -> None:
    """执行一个已占位的请求并把结果/错误写成协议帧。"""
    try:
        result = await engine.run_reserved(method, params, waits, gate)
        rpc.emit_frame(rpc.encode_response(req_id, result))
    except Exception as exc:  # 顶层兜底：任何异常都不能让引擎退出
        _emit_error(req_id, exc, method)


async def handle_line(engine: Engine, line: str) -> None:
    """解码单行 → 占位 → 执行（供自检/嵌入式调用；serve() 走同样的三步）。"""
    text = (line or "").strip()
    if not text:
        return
    try:
        req_id, method, params = rpc.decode_request(text)
    except rpc.RpcError as exc:
        rpc.emit_frame(rpc.encode_error(None, exc.code, exc.message, exc.details))
        return
    waits, gate = engine.reserve(method, params)
    await run_request(engine, req_id, method, params, waits, gate)


async def serve(engine: Engine) -> int:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def reader() -> None:
        try:
            for raw in iter(sys.stdin.buffer.readline, b""):
                if not raw:
                    break
                loop.call_soon_threadsafe(queue.put_nowait, raw)
        except Exception as exc:  # pragma: no cover
            rpc.log(f"stdin reader failed: {exc!r}", level="ERROR")
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=reader, name="stdin-reader", daemon=True).start()

    def _on_signal(signum, _frame) -> None:
        rpc.log(f"signal {signum} received → graceful shutdown")
        loop.call_soon_threadsafe(queue.put_nowait, None)

    for sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None)):
        if sig is None:
            continue
        try:
            signal.signal(sig, _on_signal)
        except Exception:  # pragma: no cover
            pass

    tasks: set[asyncio.Task] = set()
    while True:
        item = await queue.get()
        if item is None:
            break
        line = item.decode("utf-8", "replace")
        if not line.strip():
            continue
        # 解码 + 顺序占位必须在**收到该行的当下**同步完成：队列非空时 Queue.get() 不一定
        # 让出事件循环，等任务真正开跑时再占位，先后顺序就已经丢了。
        try:
            req_id, method, params = rpc.decode_request(line)
        except rpc.RpcError as exc:
            rpc.emit_frame(rpc.encode_error(None, exc.code, exc.message, exc.details))
            continue
        waits, gate = engine.reserve(method, params)
        if os.environ.get("MEDIA_DEBUG_ORDER"):
            rpc.log(f"reserve #{req_id} {method} waits={len(waits)} "
                    f"global_pending={not (waits[0].done() if waits else True)}")
        task = asyncio.create_task(
            run_request(engine, req_id, method, params, waits, gate))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    rpc.log(f"stdin closed; finishing {len(tasks)} in-flight request(s)")
    if tasks:
        await asyncio.gather(*list(tasks), return_exceptions=True)
    await engine.shutdown()
    return 0


# ------------------------------------------------------------------ selftest

def _check(checks: list[dict], name: str, fn) -> None:
    started = time.perf_counter()
    try:
        detail = fn()
        checks.append({"name": name, "ok": True,
                       "ms": int((time.perf_counter() - started) * 1000),
                       "detail": detail})
    except Exception as exc:
        checks.append({"name": name, "ok": False,
                       "ms": int((time.perf_counter() - started) * 1000),
                       "error": f"{type(exc).__name__}: {exc}",
                       "traceback": traceback.format_exc()[-1500:]})


def _expect(cond: Any, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _stub_session(refs: dict) -> Any:
    class _Stub:
        pass

    stub = _Stub()
    stub.refs = refs
    return stub


def run_selftest() -> int:
    """不开浏览器，验证纯逻辑；stdout 输出 JSON 摘要，退出码 0/1。"""
    checks: list[dict] = []
    started = time.time()

    def c_imports() -> dict:
        core = ["paths", "config_store", "fingerprint", "proxy_pool", "browser",
                "session", "actions", "observe", "rpc", "sessiond"]
        pkg = __package__ or "engine"
        loaded = {n: bool(importlib.import_module(f".{n}", pkg)) for n in core}
        _expect(all(loaded.values()), f"core modules failed to import: {loaded}")
        optional = {}
        for n in ("record", "play"):
            try:
                importlib.import_module(f".{n}", pkg)
                optional[n] = True
            except Exception:
                optional[n] = False
        return {"core": core, "optionalPresent": optional}

    def c_paths() -> dict:
        _expect(paths.DATA_DIR.resolve() == Path(os.environ["MEDIA_DATA_DIR"]).resolve(),
                f"DATA_DIR must honor MEDIA_DATA_DIR ({paths.DATA_DIR} vs "
                f"{os.environ['MEDIA_DATA_DIR']})")
        _expect(str(paths.DATA_DIR).startswith(str(_SELFTEST_TMP)), "temp data dir")
        paths.ensure_dirs()
        for d in (paths.ACCOUNTS_DIR, paths.RECIPES_DIR, paths.RUNS_DIR,
                  paths.TRACES_DIR, paths.DATA_DIR):
            _expect(d.is_dir(), f"{d} should exist")
        gi = paths.GITIGNORE.read_text(encoding="utf-8")
        _expect("secrets.yaml" in gi, ".gitignore must list secrets.yaml")
        _expect("accounts/*/proxy.json" in gi, ".gitignore must list accounts/*/proxy.json")
        _expect(re.fullmatch(r"\d{8}-\d{6}", paths.timestamp()),
                f"timestamp format: {paths.timestamp()}")
        slug = paths.safe_slug("sohu/标题:测试?")
        _expect(slug == "sohu_标题_测试", f"safe_slug got {slug!r}")
        _expect(paths.safe_slug("") == "unnamed", "empty slug")
        run_a = paths.new_run_dir("sohu__publish-article", "a-1")
        run_b = paths.new_run_dir("sohu__publish-article", "a-1")
        _expect(run_a != run_b, "new_run_dir must be unique")
        _expect((run_a / "shots").is_dir(), "run dir has shots/")
        return {"dataDir": str(paths.DATA_DIR), "slug": slug,
                "runDir": run_a.name, "runDir2": run_b.name}

    def c_config() -> dict:
        config_store.upsert_account("sel-1", "sohu", "测试账号", note="selftest")
        got = config_store.get_account("sel-1")
        _expect(got and got["media"] == "sohu" and got["account"] == "测试账号",
                f"account round-trip: {got}")
        config_store.upsert_account("sel-1", "sohu", "测试账号2")
        _expect(config_store.get_account("sel-1")["account"] == "测试账号2", "upsert in place")
        text = paths.ACCOUNTS_YAML.read_text(encoding="utf-8")
        _expect("password" not in text.lower(), "accounts.yaml must not hold passwords")
        config_store.set_proxy_secret("http://1.2.3.4:8080", "u", "p@ss")
        _expect(config_store.get_proxy_secret("http://1.2.3.4:8080", "u") == "p@ss",
                "secret round-trip")
        config_store.save_account_proxy("sel-1", {
            "server": "http://1.2.3.4:8080", "username": "u", "password": "p@ss",
            "expiresAt": "2030-01-01T00:00:00", "source": "manual"})
        raw = paths.account_proxy_path("sel-1").read_text(encoding="utf-8")
        _expect("password" not in raw, "proxy.json must not hold the password")
        _expect(json.loads(raw)["server"] == "http://1.2.3.4:8080", "proxy.json server")
        _expect(config_store.get_proxy_secret("http://1.2.3.4:8080", "u") == "p@ss",
                "password readable from secrets.yaml")
        proxies = config_store.load_proxies()
        _expect(proxies["default_policy"] == "sticky", "default proxy policy")
        _expect("apipool" in proxies["extractors"], "default extractor present")
        cfg_copy = json.loads(json.dumps(proxies))
        cfg_copy["sticky_ttl_minutes"] = 15
        config_store.save_proxies(cfg_copy)
        _expect(config_store.load_proxies()["sticky_ttl_minutes"] == 15, "proxies round-trip")
        config_store.save_proxies(json.loads(json.dumps(config_store.DEFAULT_PROXIES)))
        try:
            config_store.load_recipe("__definitely_missing__")
        except config_store.RecipeNotFound:
            pass
        else:
            raise AssertionError("RecipeNotFound expected")
        _expect(isinstance(config_store.list_recipes(), list), "list_recipes returns a list")
        config_store.remove_account("sel-1")
        _expect(config_store.get_account("sel-1") is None, "account removed")
        return {"accountsYaml": str(paths.ACCOUNTS_YAML),
                "statePath": str(paths.account_state_path("a-1"))}

    def c_fingerprint() -> dict:
        a = fingerprint.derive("a-1")
        b = fingerprint.derive("a-1")
        c = fingerprint.derive("b-1")
        _expect(a == b, "fingerprint must be deterministic")
        for key in ("user_agent", "locale", "timezone_id", "viewport",
                    "device_scale_factor", "platform"):
            _expect(key in a, f"missing fingerprint key {key}")
        _expect(1200 <= a["viewport"]["width"] <= 2600, "viewport width sane")
        _expect(a["languages"][0] == a["locale"] and "zh" in a["locale"],
                "languages must be consistent with locale")
        _expect("zh" in fingerprint.accept_language(a["locale"]), "accept-language")
        # 同一前缀的相邻账号必须拿到不同的档案/UA（这是 SPEC §4.1 的硬要求）
        for prefix in ("smoke-", "a-", "c-", "acc-"):
            uas = [fingerprint.derive(f"{prefix}{i}")["user_agent"] for i in (1, 2)]
            _expect(uas[0] != uas[1],
                    f"{prefix}1/{prefix}2 share one UA: {uas[0]}")
        slots = [fingerprint.profile_slot(f"x-{i}") for i in range(1, len(fingerprint.PROFILES) + 1)]
        _expect(sorted(slots) == list(range(len(fingerprint.PROFILES))),
                f"staggered assignment must cover every profile once: {slots}")
        _expect(len({p["major"] for p in fingerprint.PROFILES}) >= 2,
                "the profile pool should span more than one Chrome major")
        diff = (a["user_agent"] != c["user_agent"] or a["viewport"] != c["viewport"]
                or a["timezone_id"] != c["timezone_id"] or a["platform"] != c["platform"])
        _expect(diff, "two accounts must not share the whole fingerprint")
        realigned = fingerprint.realign_user_agent(a, "153.0.8010.12")
        _expect("Chrome/" in realigned["user_agent"], "UA realignment keeps a version")
        _expect(realigned["user_agent"] == a["user_agent"], "near-version UA is preserved")
        far = fingerprint.realign_user_agent({**a, "chrome_major": 120,
                                             "user_agent": "Chrome/120.0.0.0"},
                                             "153.0.8010.12")
        _expect("Chrome/153" in far["user_agent"], "far-off UA is realigned")
        hints = fingerprint.sec_ch_ua(a)
        _expect(f'v="{a["chrome_major"]}"' in hints["sec-ch-ua"],
                f"client hints must match the UA major: {hints}")
        uas = {fingerprint.derive(f"acc-{i}")["user_agent"] for i in range(24)}
        _expect(len(uas) >= 3, f"24 accounts should not all share one UA: {len(uas)}")
        sigs = {json.dumps([f["platform"], f["viewport"], f["timezone_id"],
                            f["device_scale_factor"], f["gpu_renderer"]],
                           sort_keys=True)
                for f in (fingerprint.derive(f"acc-{i}") for i in range(24))}
        _expect(len(sigs) >= 8,
                f"24 accounts should spread across fingerprints, got {len(sigs)}")
        return {"a-1": fingerprint.summary(a), "b-1": fingerprint.summary(c),
                "distinctUAs": len(uas), "distinctSignatures": len(sigs),
                "profilePool": len(fingerprint.PROFILES)}

    def c_proxy_extractors() -> dict:
        cfg = {"default_policy": "sticky", "sticky_ttl_minutes": 30,
               "health_check": {"url": "http://127.0.0.1:1/x", "timeout_ms": 500},
               "static": [], "account_policy": {}, "whitelist": []}
        fields = {"server": "{ip}:{port}", "username": "{user}", "password": "{pass}"}
        field_map = {"ip": "ip", "port": "port", "user": "user", "pass": "pass"}
        proxy_pool.reset_cache()
        calls: list[str] = []

        def json_fetcher(url, method, headers, timeout_ms):
            calls.append(url)
            return json.dumps({"data": {"list": [
                {"ip": "1.2.3.4", "port": 8080, "user": "uu", "pass": "pp"}]}})

        base = {"type": "http", "url": "http://fake/api", "method": "GET", "parse": "json",
                "json_path": "data.list", "fields": fields, "field_map": field_map,
                "cooldown_seconds": 0}
        p = proxy_pool.fetch_from_extractor("fake", base, cfg=cfg, fetcher=json_fetcher)
        _expect(p["server"] == "http://1.2.3.4:8080", f"json parse: {p}")
        _expect(p["username"] == "uu" and p["password"] == "pp", "fields templating")
        _expect(calls == ["http://fake/api"], f"fetcher called once: {calls}")

        text_ext = {**base, "parse": "text", "separator": ":", "field_map": None}
        p2 = proxy_pool.fetch_from_extractor("t", text_ext, cfg=cfg,
                                             fetcher=lambda *a: "5.6.7.8:3128:usr:pwd\n")
        _expect(p2["server"] == "http://5.6.7.8:3128", f"text parse: {p2}")
        _expect(p2["username"] == "usr" and p2["password"] == "pwd", "text positional fields")

        rex = {**base, "parse": "regex", "field_map": None,
               "text_regex": r"(?P<ip>[\d.]+):(?P<port>\d+):(?P<user>[^:]+):(?P<pass>.+)"}
        p3 = proxy_pool.fetch_from_extractor("r", rex, cfg=cfg,
                                             fetcher=lambda *a: "9.9.9.9:1080:u2:p2\n")
        _expect(p3["server"] == "http://9.9.9.9:1080" and p3["password"] == "p2",
                f"regex parse: {p3}")

        clock = [1000.0]
        proxy_pool._clock = lambda: clock[0]
        try:
            counter = [0]

            def counting(url, method, headers, timeout_ms):
                counter[0] += 1
                return json.dumps({"data": {"list": [
                    {"ip": f"10.0.0.{counter[0]}", "port": 80, "user": "a", "pass": "b"}]}})

            cd = {**base, "cooldown_seconds": 60}
            p4 = proxy_pool.fetch_from_extractor("cd", cd, cfg=cfg, fetcher=counting)
            p5 = proxy_pool.fetch_from_extractor("cd", cd, cfg=cfg, fetcher=counting)
            _expect(p4["server"] == p5["server"] and counter[0] == 1,
                    "cooldown_seconds must serve the cached proxy")
            clock[0] += 61
            p6 = proxy_pool.fetch_from_extractor("cd", cd, cfg=cfg, fetcher=counting)
            _expect(counter[0] == 2 and p6["server"] != p4["server"],
                    "after cooldown a new proxy must be fetched")
        finally:
            proxy_pool._clock = time.monotonic

        try:
            proxy_pool.fetch_from_extractor(
                "wl", {**base, "respect_whitelist": True}, cfg={**cfg, "whitelist": ["9.9.9.9"]},
                fetcher=json_fetcher)
        except proxy_pool.ProxyUnavailable as exc:
            _expect("whitelist" in exc.message, f"whitelist error message: {exc.message}")
        else:
            raise AssertionError("respect_whitelist should reject an out-of-list IP")

        ok_wl = proxy_pool.fetch_from_extractor(
            "wl2", {**base, "respect_whitelist": True},
            cfg={**cfg, "whitelist": ["1.2.3.4"]}, fetcher=json_fetcher)
        _expect(ok_wl["server"] == "http://1.2.3.4:8080", "whitelisted IP accepted")

        static_cfg = {**cfg, "static": [
            {"server": "7.7.7.7:8888", "username": "su", "password": "sp", "note": "n"}]}
        p7 = proxy_pool.fetch_from_extractor("static", {"type": "static"}, cfg=static_cfg)
        _expect(p7["server"] == "http://7.7.7.7:8888" and p7["source"] == "static",
                f"static extractor: {p7}")
        try:
            proxy_pool.fetch_from_extractor("bad", {**base, "parse": "json"},
                                            cfg=cfg, fetcher=lambda *a: "not json")
        except proxy_pool.ProxyUnavailable:
            pass
        else:
            raise AssertionError("invalid JSON must raise ProxyUnavailable")
        return {"json": p["server"], "text": p2["server"], "regex": p3["server"],
                "cooldownCalls": 2, "static": p7["server"]}

    def c_proxy_binding() -> dict:
        proxy_pool.reset_cache()
        cfg = json.loads(json.dumps(config_store.DEFAULT_PROXIES))
        cfg["static"] = [{"server": "6.6.6.6:8000", "username": "u6", "password": "p6"}]
        config_store.save_proxies(cfg)
        try:
            p = proxy_pool.get_for_account("bind-1", "sticky")
            _expect(p and p["server"] == "http://6.6.6.6:8000", f"static sticky fetch: {p}")
            bound = config_store.load_account_proxy("bind-1")
            _expect(bound and bound["server"] == "http://6.6.6.6:8000", f"bound: {bound}")
            _expect("password" not in json.dumps(bound), "proxy.json has no password")
            _expect(config_store.get_proxy_secret("http://6.6.6.6:8000", "u6") == "p6",
                    "static password stored in secrets.yaml")
            again = proxy_pool.get_for_account("bind-1", "sticky")
            _expect(again["server"] == p["server"], "sticky binding must be reused")
            _expect(proxy_pool.get_for_account("bind-1", "direct") is None,
                    "policy=direct → no proxy")
            config_store.save_account_proxy("bind-1", {**bound,
                                                      "expiresAt": "2000-01-01T00:00:00"})
            refreshed = proxy_pool.get_for_account("bind-1", "sticky")
            _expect(refreshed["server"] == "http://6.6.6.6:8000", "expired binding refreshed")
            proxy_pool.rotate("bind-1")
            _expect(config_store.load_account_proxy("bind-1") is not None, "rotate rebinds")
            proxy_pool.bind("bind-1", None)
            _expect(config_store.load_account_proxy("bind-1") is None, "unbind")
        finally:
            config_store.save_proxies(json.loads(json.dumps(config_store.DEFAULT_PROXIES)))
        _expect(proxy_pool.extractor_candidates(config_store.load_proxies()) == [],
                "shipped proxies.yaml must have no enabled extractor (placeholder)")
        # 手动绑定的代理必须在**没有提取器**时也能被 fetch_proxy 解析回来（回归：曾抛
        # PROXY_UNAVAILABLE），并保留真实 source；force=True 才去问提取器。
        proxy_pool.bind("bind-2", {"server": "http://127.0.0.1:9", "username": "u9",
                                   "password": "p9", "source": "manual",
                                   "expiresAt": "2035-01-01T00:00:00"})
        got = proxy_pool.fetch_proxy("bind-2")
        _expect(got["server"] == "http://127.0.0.1:9" and got["source"] == "manual",
                f"fetch_proxy must reuse the bound proxy: {got}")
        _expect(got.get("password") == "p9", "bound password resolved from secrets.yaml")
        described = proxy_pool.describe("bind-2")
        _expect(described["bound"] is True and described["hasPassword"] is True
                and "password" not in described, f"describe: {described}")
        _expect(proxy_pool.describe("ghost-1")["bound"] is False,
                "describe on an unbound account is consistent")
        try:
            proxy_pool.fetch_proxy("bind-2", force=True)
        except proxy_pool.ProxyUnavailable:
            pass
        else:
            raise AssertionError("force=True with no extractor must raise ProxyUnavailable")
        proxy_pool.bind("bind-2", None)
        try:
            proxy_pool.get_for_account("nobody", "sticky")
        except proxy_pool.ProxyUnavailable:
            raise AssertionError(
                "unconfigured pool must degrade to direct (None), not raise") from None
        _expect(proxy_pool.get_for_account("nobody", "sticky") is None,
                "no binding + no extractor → None (caller warns and runs direct)")
        # 配了却拿不到（绑定已过期 + 无提取器）仍然是显式失败
        config_store.save_account_proxy("stale-1", {
            "server": "http://127.0.0.1:9", "username": "u",
            "expiresAt": "2000-01-01T00:00:00"})
        try:
            proxy_pool.get_for_account("stale-1", "sticky")
        except proxy_pool.ProxyUnavailable:
            pass
        else:
            raise AssertionError("expired binding + no extractor must raise ProxyUnavailable")
        proxy_pool.bind("stale-1", None)
        # 代理不可达：必须是「代理问题」，措辞不得像登录问题，且绝不回传密码
        bad = proxy_pool.test({"server": "http://127.0.0.1:9", "username": "u9",
                               "password": "p9"})
        _expect(bad["ok"] is False, f"unreachable proxy must be ok=false: {bad}")
        _expect(not re.search(r"登录|login", json.dumps(bad), re.I),
                f"proxy failure must not read like a login problem: {bad}")
        _expect("p9" not in json.dumps(bad) and "u9:***" not in json.dumps(bad),
                f"proxy.test must not leak credentials: {bad}")
        proxy, warnings = _resolve_proxy("nobody", "sticky")
        _expect(proxy is None and any("未绑定代理" in w for w in warnings),
                f"no binding + no extractor → direct + warning: {warnings}")
        return {"stickyReused": True, "fetchReusedBinding": got["server"],
                "directFallbackWarnings": warnings, "proxyTestDetail": bad["detail"]}

    def c_rpc() -> dict:
        rid, method, params = rpc.decode_request(
            '{"id":17,"method":"act.click","params":{"a":1}}')
        _expect(rid == 17 and method == "act.click" and params == {"a": 1}, "decode ok")
        rid2, method2, params2 = rpc.decode_request('{"method":"engine.status"}')
        _expect(rid2 is None and params2 == {} and method2 == "engine.status", "id optional")
        for bad in ("", "   ", "{", "[]", '{"id":1}', '{"method":"x","params":[]}'):
            try:
                rpc.decode_request(bad)
            except rpc.RpcError as exc:
                _expect(exc.code == "BAD_REQUEST", f"code for {bad!r}: {exc.code}")
            else:
                raise AssertionError(f"decode_request should reject {bad!r}")
        frame = json.loads(rpc.encode_response(3, {"ms": 1}))
        _expect(frame == {"id": 3, "ok": True, "result": {"ms": 1}}, f"response: {frame}")
        err = json.loads(rpc.encode_error(4, "TIMEOUT", "x", {"y": object()}))
        _expect(err["ok"] is False and err["error"]["code"] == "TIMEOUT", "error frame")
        _expect(isinstance(err["error"]["details"]["y"], str), "details scrubbed")
        event = json.loads(rpc.encode_event("handoff", {"sessionId": "s1"}))
        _expect("id" not in event and event["event"] == "handoff"
                and event["data"]["sessionId"] == "s1", "event frame")
        _expect("你好" in rpc.encode_response(1, {"t": "你好"}), "UTF-8 not escaped")
        _expect(all(code in rpc.ERROR_CODES for code in
                    ("BAD_REQUEST", "UNKNOWN_METHOD", "SESSION_NOT_FOUND",
                     "TARGET_NOT_FOUND", "TIMEOUT", "PROXY_UNAVAILABLE",
                     "LOGIN_REQUIRED", "RECIPE_INVALID", "PARAM_MISSING",
                     "UNSUPPORTED", "INTERNAL")), "error code set")
        return {"roundTrip": True, "errorCodes": len(rpc.ERROR_CODES)}

    def c_actions_pure() -> dict:
        os.environ["MEDIA_SELFTEST_ENV"] = "ENV!"
        out = actions.resolve_params(
            {"a": "{{x}}", "b": ["{{env:MEDIA_SELFTEST_ENV}}", "pre-{{x}}-post"],
             "c": {"d": "{{x}}"}, "n": "{{num}}"},
            {"x": "值", "num": 7})
        _expect(out["a"] == "值", f"param replace: {out}")
        _expect(out["b"] == ["ENV!", "pre-值-post"], f"list/env: {out['b']}")
        _expect(out["c"]["d"] == "值", "nested dict")
        _expect(out["n"] == 7, "full-placeholder keeps the original type")
        _expect(actions.resolve_params("{{a}}", {"a": "{{b}}", "b": "ok"}) == "ok",
                "nested placeholder")
        try:
            actions.resolve_params("{{missing}}", {})
        except ActionError as exc:
            _expect(exc.code == "PARAM_MISSING", f"missing param code: {exc.code}")
        else:
            raise AssertionError("PARAM_MISSING expected")
        desc = {"kind": "selector", "value": "#b", "selector": "#b", "role": "button",
                "text": "发布", "nth": 0, "tag": "button", "visible": True,
                "inFrame": "main", "box": [1, 2, 3, 4]}
        norm = actions.normalize_target(_stub_session({"e12": desc}), {"ref": "e12"})
        _expect(norm == {"selector": "#b"},
                f"ref → durable target: {norm}")
        no_selector = actions.normalize_target(
            _stub_session({"e13": {"role": "button", "text": "发布", "nth": 0}}),
            {"ref": "e13"})
        _expect(no_selector == {"role": "button", "text": "发布"},
                f"ref without a css path falls back to role+text: {no_selector}")
        _expect(actions.normalize_target(_stub_session({}), {"text": "发布"}) == {"text": "发布"},
                "text target kept")
        spec_actions = {"goto", "click", "dispatch", "type", "press", "upload", "select",
                        "check", "scroll", "waitFor", "frame", "eval", "extract"}
        _expect(spec_actions <= set(actions.ACTION_TYPES),
                f"missing act types: {sorted(spec_actions - set(actions.ACTION_TYPES))}")

        alerts_hit = observe.detect_alerts("https://x/y", "验证码", "")
        _expect("验证码" in alerts_hit, f"alert hit: {alerts_hit}")
        _expect(observe.detect_alerts("https://mp.sohu.com/mpfe/v4/index", "搜狐号",
                                      "创作中心 发布内容") == [], "clean page has no alerts")
        _expect("captcha" in observe.detect_alerts("https://x/captcha", "t", ""),
                "captcha url")
        _expect("login-redirect" in observe.detect_alerts("https://mpfe/v4/login", "", ""),
                "login redirect")

        js = browser.init_script({"locale": "zh-CN", "languages": ["zh-CN", "zh", "en"],
                                 "platform": "Win32", "gpu_vendor": "V", "gpu_renderer": "R",
                                 "viewport": {"width": 1440, "height": 900}})
        for token in ("webdriver", "chrome.runtime", "plugins", "languages", "gpuRenderer",
                      "Notification", "getParameter"):
            _expect(token in js, f"anti-detect script missing {token}")
        _expect("__FP__" not in js, "init script placeholder must be substituted")
        _expect("--disable-blink-features=AutomationControlled" in browser.LAUNCH_ARGS,
                "launch args must disable AutomationControlled")
        _expect(browser.normalize_proxy({"server": "1.2.3.4:80"})["server"] == "http://1.2.3.4:80",
                "proxy scheme added")
        _expect(browser.normalize_proxy(None) is None, "no proxy → None")
        _expect(observe.INTERACTIVE_SELECTOR.count(",") > 5, "interactive selector list")
        # 文本定位优先级：短动作词必须优先落在可交互元素上（精确 > 子串，交互 > 任意）
        _expect(observe.TEXT_TIERS == ("interactive-exact", "any-exact",
                                       "interactive-substring", "any-substring"),
                f"text tier order: {observe.TEXT_TIERS}")
        for token in ("interactive-exact", "any-exact", "interactive-substring",
                      "any-substring", "innerMost", "inViewport"):
            _expect(token in observe.TEXT_RESOLVE_JS, f"resolver JS missing {token}")
        _expect("button" in observe.TEXT_INTERACTIVE_SELECTOR
                and "[role=button]" in observe.TEXT_INTERACTIVE_SELECTOR,
                "interactive text scope must include buttons")
        return {"params": True, "normTarget": norm, "alerts": alerts_hit,
                "initScriptBytes": len(js), "textTiers": list(observe.TEXT_TIERS)}

    def c_stdout_discipline() -> dict:
        # 只检查本 agent 负责的模块（record.py / play.py 由另一个 agent 实现）
        mine = ("paths.py", "config_store.py", "fingerprint.py", "proxy_pool.py",
                "browser.py", "session.py", "actions.py", "observe.py", "rpc.py",
                "sessiond.py", "__init__.py")
        # 关键字在运行时拼出来，免得自检代码自己被自己命中
        pat = re.compile(r"(?<![\w.])" + "pri" + r"nt\s*\(")
        stdout_write = "sys.stdout" + ".write"
        stdout_flush = "sys.stdout" + ".flush"
        bad: list[str] = []
        others: list[str] = []
        for f in sorted(Path(__file__).parent.glob("*.py")):
            for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
                if line.strip().startswith("#"):
                    continue
                hits = bool(pat.search(line))
                hits = hits or stdout_write in line or stdout_flush in line
                if not hits:
                    continue
                if f.name not in mine:
                    others.append(f"{f.name}:{i}")
                    continue
                if f.name != "rpc.py" and (stdout_write in line or stdout_flush in line):
                    bad.append(f"{f.name}:{i}:stdout-write")
                elif pat.search(line):
                    bad.append(f"{f.name}:{i}:print")
        _expect(not bad, f"stdout discipline violated: {bad}")
        return {"checked": len(mine), "violations": bad,
                "otherAgentsModulesWithPrint": others}

    def c_snapshot_element_shape() -> dict:
        """回归检查：元素描述符组装必须**永远**满足 SPEC §2.2 的键集合。

        包括最恶劣的输入：空 dict、缺 enabled/box/selector/inFrame、box 是非数字。
        """
        samples = [
            {},                                                     # 完全空
            {"tag": "button"},                                      # 只有 tag
            {"tag": "button", "text": "发布", "selector": "#b",
             "inFrame": "main", "nth": 0},                           # 缺 enabled/box
            {"tag": "input", "text": "", "selector": "", "role": "textbox",
             "visible": False, "enabled": False, "box": "oops", "inFrame": None},
            {"tag": "a", "text": "链接", "selector": "a:nth-of-type(2)",
             "visible": True, "enabled": True, "box": [1, 2, 3],
             "inFrame": "f1", "likelySubmit": True},
        ]
        for raw in samples:
            desc = observe.describe_element(raw)
            item = observe.public_element(desc)
            for key in observe.ELEMENT_KEYS:
                _expect(key in item, f"public_element({raw!r}) missing {key!r}")
            _expect(isinstance(item["box"], list) and len(item["box"]) == 4,
                    f"box must be 4 ints: {item['box']!r}")
            _expect(all(isinstance(v, int) for v in item["box"]),
                    f"box must be ints: {item['box']!r}")
            _expect(isinstance(item["visible"], bool) and isinstance(item["enabled"], bool),
                    f"flags must be bool: {item}")
            _expect(isinstance(item["text"], str) and isinstance(item["role"], str)
                    and isinstance(item["selector"], str) and isinstance(item["inFrame"], str),
                    f"strings: {item}")
        bare = observe.public_element({})
        # 未知元素不谎报可见：宁可 visible=false（附 hidden:true）也不假装看得见
        _expect(bare["enabled"] is True and bare["inFrame"] == "main"
                and bare["box"] == [0, 0, 0, 0] and bare["visible"] is False
                and bare["hidden"] is True,
                f"bare element defaults: {bare}")
        _expect(observe.public_element({"tag": "button"}, "e7")["ref"] == "e7", "ref passed")
        # 描述符本身也要带全部键（ref 注册表上游）
        desc = observe.describe_element({"selector": "#x", "tag": "div"})
        for key in ("selector", "role", "text", "inFrame", "box", "nth", "kind", "value"):
            _expect(key in desc, f"descriptor missing {key!r}: {sorted(desc)}")
        _expect(observe.ELEMENT_KEYS == ("ref", "tag", "role", "text", "selector",
                                        "visible", "enabled", "box", "inFrame"),
                "ELEMENT_KEYS must match SPEC §2.2")
        return {"samples": len(samples), "keys": list(observe.ELEMENT_KEYS),
                "bare": bare}

    def c_ref_durability() -> dict:
        """ref 的两半契约，明确写下来并强制：

        1. `session.refs[ref]` 保存**富描述符**（selector/role/text/nth/box/inFrame）——
           失效时靠它降级重定位（自愈的基础）；
        2. `act.*` 返回的、能进 recipe 的 `step.target` 里**不能出现 ref**（ref 只在下一次
           snapshot 前有效）；有 CSS 路径就用 `{selector}`（跨调用/跨会话稳定），
           没有才退化成 `{role,text}`。这就是「durable target」的含义。
        """
        rich = {"kind": "selector", "value": "#b", "selector": "#b", "role": "button",
                "text": "发布", "nth": 0, "tag": "button", "visible": True,
                "inFrame": "main", "box": [1, 2, 3, 4]}
        registry = _stub_session({"e12": rich})
        durable = actions.normalize_target(registry, {"ref": "e12"})
        _expect("ref" not in durable, f"a recipe step must never carry a ref: {durable}")
        _expect(durable == {"selector": "#b"},
                f"a selector-bearing ref must degrade to its css path: {durable}")
        # 富描述符仍然完整保留（第 1 条），供失败时的候选/自愈使用
        for key in ("selector", "role", "text", "nth", "inFrame", "box", "visible"):
            _expect(key in rich, f"ref registry descriptor must keep {key}")
        # 没有 CSS 路径时才退化到 role+text
        fallback = actions.normalize_target(
            _stub_session({"e9": {"role": "button", "text": "发布", "nth": 2}}),
            {"ref": "e9"})
        _expect(fallback == {"role": "button", "text": "发布"}, f"fallback: {fallback}")
        # within / nth 也要一起降级，且不引入任何 session 作用域的键
        nested = actions.normalize_target(
            _stub_session({"e1": {"selector": "#box"}, "e2": {"selector": "#ok"}}),
            {"ref": "e2", "within": {"ref": "e1"}})
        _expect(nested == {"selector": "#ok", "within": {"selector": "#box"}},
                f"nested within must degrade too: {nested}")
        return {"durable": durable, "fallback": fallback, "nested": nested}

    def c_recipe_precedence() -> dict:
        """回归：用户录制的 recipe 必须压过同 id 的内置 recipe（SPEC §6「用户目录优先」）。

        record.save 写的是 ``recipes/<media>/<id>.yaml``（比内置 ``recipes/<id>.yaml`` 深一层），
        一旦「先平铺、后递归」分成两段快路径，内置就会抢先命中，用户录的东西静默失效。
        """
        import shutil
        import tempfile

        real_builtin = paths.BUILTIN_RECIPES_DIR
        fake_builtin = Path(tempfile.mkdtemp(prefix="media-builtin-"))
        user_path: Path | None = None
        try:
            (fake_builtin / "collide__recipe.yaml").write_text(
                "id: collide__recipe\nmedia: builtin\nsteps: []\n", encoding="utf-8")
            paths.BUILTIN_RECIPES_DIR = fake_builtin
            data, found = config_store.load_recipe("collide__recipe")
            _expect(found.parent == fake_builtin and data["media"] == "builtin",
                    f"builtin-only lookup: {found}")
            _expect(config_store.recipe_source(found) == "builtin", "source builtin")

            user_path = config_store.save_recipe(
                {"id": "collide__recipe", "media": "shadow", "steps": [{"type": "goto"}]})
            _expect(user_path.parent != fake_builtin, "save_recipe must write into the user dir")
            data2, found2 = config_store.load_recipe("collide__recipe")
            _expect(found2 == user_path and data2["media"] == "shadow",
                    f"a user recording must shadow the builtin: got {found2}")
            _expect(config_store.recipe_source(found2) == "user",
                    f"source must be 'user': {config_store.recipe_source(found2)}")
            entry = next((r for r in config_store.list_recipes()
                          if r["id"] == "collide__recipe"), None)
            _expect(entry and Path(entry["path"]) == user_path and entry["source"] == "user",
                    f"list_recipes must agree with load_recipe: {entry}")
        finally:
            paths.BUILTIN_RECIPES_DIR = real_builtin
        try:
            # 真实内置（用户流程用的 id）也必须能被用户录制覆盖
            builtin_entry = next((r for r in config_store.list_recipes()
                                  if r["source"] == "builtin"), None)
            _expect(builtin_entry is not None, "engine/recipes 下应有内置 recipe")
            rid = builtin_entry["id"]
            shadow = config_store.save_recipe({"id": rid, "media": "shadow",
                                              "steps": [{"type": "goto"}]})
            data3, found3 = config_store.load_recipe(rid)
            _expect(found3 == shadow and config_store.recipe_source(found3) == "user",
                    f"user recording must win for the real builtin id {rid!r}: {found3}")
            listed3 = next(r for r in config_store.list_recipes() if r["id"] == rid)
            _expect(listed3["source"] == "user", f"list source: {listed3['source']}")
            shadow.unlink()
            data4, found4 = config_store.load_recipe(rid)
            _expect(config_store.recipe_source(found4) == "builtin",
                    f"after removing the override the builtin is back: {found4}")
        finally:
            if user_path is not None:
                user_path.unlink(missing_ok=True)
            shadow_dir = paths.RECIPES_DIR / "shadow"
            if shadow_dir.is_dir() and not any(shadow_dir.iterdir()):
                shutil.rmtree(shadow_dir, ignore_errors=True)
            shutil.rmtree(fake_builtin, ignore_errors=True)
        return {"collision": "collide__recipe", "realBuiltinId": rid,
                "userWinsOverBuiltin": True}

    async def c_request_ordering() -> dict:
        """请求顺序契约（不开浏览器）：同键串行、屏障阻断后续、异键并行、失败不阻塞。

        这一条直接盯住「闸门」实现：如果闸门是已完成的 future（曾经就是），同键串行与
        屏障会同时失效，而所有功能测试仍然全绿 —— 只有这种顺序断言能抓住它。
        """
        engine = Engine()
        order: list[str] = []
        real_close = HANDLERS["session.close"]

        async def slow(engine_, params) -> dict:
            tag = str(params.get("tag") or "?")
            order.append(f"start:{tag}")
            await asyncio.sleep(float(params.get("sleep") or 0.02))
            order.append(f"end:{tag}")
            if params.get("boom"):
                raise rpc.RpcError("INTERNAL", "intentional failure for the ordering test")
            return {"tag": tag}

        async def barrier(engine_, params) -> dict:
            order.append("start:BARRIER")
            await asyncio.sleep(0.02)
            order.append("end:BARRIER")
            return {"barrier": True}

        def spawn(method: str, params: dict) -> asyncio.Task:
            waits, gate = engine.reserve(method, params)  # 到达顺序上同步占位
            return asyncio.create_task(engine.run_reserved(method, params, waits, gate))

        HANDLERS["test.slow"] = slow
        HANDLERS["session.close"] = barrier
        try:
            a = spawn("test.slow", {"sessionId": "s1", "tag": "a"})
            b = spawn("test.slow", {"sessionId": "s1", "tag": "b"})
            c = spawn("session.close", {"sessionId": "s1", "tag": "barrier"})
            d = spawn("test.slow", {"sessionId": "s2", "tag": "d"})
            e = spawn("test.slow", {"sessionId": "s2", "tag": "e"})
            await asyncio.gather(a, b, c, d, e)
            _expect(order.index("end:a") < order.index("start:b"),
                    f"same-key requests must be serialized: {order}")
            _expect(order.index("end:BARRIER") < order.index("start:d"),
                    f"a barrier must block later requests: {order}")
            _expect(order.index("start:d") < order.index("end:d")
                    and order.index("start:e") < order.index("end:e"),
                    f"independent requests should run to completion: {order}")
            _expect(order.index("start:e") < order.index("end:e"), "d/e complete")
            # 失败不阻塞同键后续请求
            order.clear()
            f1 = spawn("test.slow", {"sessionId": "s3", "tag": "boom", "boom": True})
            f2 = spawn("test.slow", {"sessionId": "s3", "tag": "after"})
            results = await asyncio.gather(f1, f2, return_exceptions=True)
            _expect(isinstance(results[0], rpc.RpcError), f"first request should fail: {results}")
            _expect(results[1] == {"tag": "after"},
                    f"a failed request must not block its successor: {results}")
            _expect(order.index("end:boom") < order.index("start:after"),
                    f"ordering survives a failure: {order}")
        finally:
            HANDLERS.pop("test.slow", None)
            HANDLERS["session.close"] = real_close
        await engine.shutdown()
        return {"sequence": order}

    def c_method_table() -> dict:
        spec_methods = {
            "engine.status", "session.open", "session.close", "session.list",
            "session.handoff", "session.resume", "session.state", "session.snapshot",
            "session.screenshot", "account.list", "account.upsert", "account.remove",
            "account.bindProxy", "account.login", "account.checkLogin", "proxy.fetch",
            "proxy.test", "proxy.rotate", "record.start", "record.status", "record.note",
            "record.undo", "record.save", "play.validate", "play.run", "play.backfill",
        }
        missing = spec_methods - set(HANDLERS)
        _expect(not missing, f"missing handlers: {sorted(missing)}")

        # 直接从 docs/SPEC.md §2.1 的**方法表行**解析方法名（只认首列是 `x.y` 的表格行；
        # 散文里的 `session.trace` / `record.py` 之类点号 token 一律忽略）：
        # 兄弟模块实现了但没注册（例如曾经的 play.backfill）会立刻暴露。
        spec_path = Path(__file__).resolve().parent.parent / "docs" / "SPEC.md"
        from_spec: set[str] = set()
        if spec_path.is_file():
            for line in spec_path.read_text(encoding="utf-8", errors="replace").splitlines():
                stripped = line.lstrip()
                if not stripped.startswith("|"):
                    continue
                first_cell = stripped[1:].split("|")[0].strip()
                m = re.fullmatch(r"`((?:session|act|record|play|account|proxy|engine)"
                                 r"\.[A-Za-z]+)`", first_cell)
                if m:
                    from_spec.add(m.group(1))
        _expect(len(from_spec) >= 25,
                f"SPEC §2.1 method table parse produced too few names: {sorted(from_spec)}")
        _expect(from_spec >= {t for t in ("session.open", "session.snapshot", "act.click",
                                         "account.login", "proxy.rotate", "play.run")},
                f"SPEC table parse looks wrong: {sorted(from_spec)}")
        not_registered = {m for m in from_spec if m not in HANDLERS}
        _expect(not not_registered,
                f"methods in the docs/SPEC.md §2.1 method table but not registered: "
                f"{sorted(not_registered)}")
        _expect(not any(name.endswith((".py", ".js")) for name in from_spec),
                f"prose leaked into the method parse: {sorted(from_spec)}")
        for t in actions.ACTION_TYPES:
            _expect(f"act.{t}" in HANDLERS, f"missing act.{t}")
        _expect({"act." + t for t in actions.RECIPE_ACTIONS} <= set(HANDLERS),
                "every SPEC act.* type needs a handler")
        _expect(BARRIER_METHODS <= set(HANDLERS), "barriers must be real methods")
        _expect(PLATFORMS["sohu"]["check_url"].endswith("/mpfe/v4/index"), "sohu check url")
        _expect(PLATFORMS["toutiao"]["check_url"] == "https://mp.toutiao.com/profile_v4/index",
                "toutiao check url")
        _expect(PLATFORMS["csdn"]["check_url"].startswith("https://mp.csdn.net"),
                "csdn check url")
        _expect(PLATFORMS["csdn"]["login_url"].startswith("https://passport.csdn.net/login"),
                "csdn login url")
        return {"handlers": len(HANDLERS), "actTypes": len(actions.ACTION_TYPES),
                "platforms": sorted(PLATFORMS), "methodsFromSpec": len(from_spec)}

    async def c_protocol() -> dict:
        """跑真实 dispatch 路径（不启动浏览器）。"""
        engine = Engine()
        status = await engine.dispatch("engine.status", {})
        _expect(Path(status["dataDir"]).resolve()
                == Path(os.environ["MEDIA_DATA_DIR"]).resolve(), "status dataDir")
        _expect(status["sessions"] == 0 and "version" in status and "playwright" in status,
                f"status shape: {sorted(status)}")
        _expect(engine.bm.started is False, "engine.status must not start playwright")
        _expect(status["chromium"] and "chromium" in str(status["chromium"]).lower(),
                f"chromium path should be detected: {status['chromium']}")
        listed = await engine.dispatch("session.list", {})
        _expect(listed == {"sessions": []}, f"session.list: {listed}")

        async def expect_err(method, params, code):
            try:
                await engine.dispatch(method, params)
            except rpc.RpcError as exc:
                _expect(exc.code == code, f"{method} → {exc.code} (want {code}): {exc.message}")
                return exc
            raise AssertionError(f"{method} should fail with {code}")

        await expect_err("nope.nope", {}, "UNKNOWN_METHOD")
        await expect_err("session.open", {"accountCode": "__missing__"}, "BAD_REQUEST")
        await expect_err("session.snapshot", {"sessionId": "s99"}, "SESSION_NOT_FOUND")
        await expect_err("act.click", {"sessionId": "s99", "target": {"text": "x"}},
                         "SESSION_NOT_FOUND")
        await expect_err("act.click", {}, "PARAM_MISSING")
        await expect_err("proxy.test", {}, "PARAM_MISSING")
        await expect_err("proxy.fetch", {}, "PROXY_UNAVAILABLE")
        await expect_err("proxy.rotate", {"code": "ghost"}, "PROXY_UNAVAILABLE")
        await expect_err("account.login", {"code": "__missing__"}, "BAD_REQUEST")

        await engine.dispatch("account.upsert", {"code": "sel-2", "media": "csdn",
                                                "account": "b"})
        accounts = await engine.dispatch("account.list", {})
        _expect(any(a["code"] == "sel-2" for a in accounts["accounts"]),
                f"upsert visible in list: {accounts}")
        bound = await engine.dispatch("account.bindProxy", {
            "code": "sel-2", "proxy": {"server": "1.1.1.1:8080", "username": "u",
                                       "password": "pw"}})
        _expect(bound["proxy"]["bound"] is True and bound["proxy"]["hasPassword"] is True,
                f"bindProxy: {bound}")
        raw = paths.account_proxy_path("sel-2").read_text(encoding="utf-8")
        _expect("pw" not in raw, "password must not land in proxy.json")
        _expect(config_store.get_proxy_secret("http://1.1.1.1:8080", "u") == "pw",
                "password stored under the normalized server key")
        unbound = await engine.dispatch("account.bindProxy", {"code": "sel-2", "proxy": None})
        _expect(unbound["proxy"]["bound"] is False, "unbind works")
        removed = await engine.dispatch("account.remove",
                                       {"code": "sel-2", "purgeState": True})
        _expect(removed["purged"] is True
                and not (paths.ACCOUNTS_DIR / "sel-2").exists(), "purgeState removes the dir")
        # record.* / play.* 在对方模块就绪时应可用，否则必须是 UNSUPPORTED（不能崩）
        for method, params in (("record.start", {"sessionId": "s1", "recipeId": "r",
                                                 "media": "sohu"}),
                               ("play.validate", {"recipeId": "r"})):
            try:
                await engine.dispatch(method, params)
            except rpc.RpcError as exc:
                _expect(exc.code in ("UNSUPPORTED", "SESSION_NOT_FOUND", "RECIPE_INVALID"),
                        f"{method} → {exc.code}")
            # 成功也 OK（说明 record.py/play.py 已就绪）
        await engine.shutdown()
        _expect(engine.bm.started is False, "shutdown must not need a browser")
        return {"methods": len(HANDLERS), "statusKeys": sorted(status)}

    # ------------------------------------------------------------------ run
    _check(checks, "imports", c_imports)
    _check(checks, "paths_and_dirs", c_paths)
    _check(checks, "config_store_roundtrip", c_config)
    _check(checks, "fingerprint_determinism", c_fingerprint)
    _check(checks, "proxy_extractors", c_proxy_extractors)
    _check(checks, "proxy_binding_and_policy", c_proxy_binding)
    _check(checks, "rpc_protocol_codec", c_rpc)
    _check(checks, "pure_logic_actions_observe_browser", c_actions_pure)
    _check(checks, "snapshot_element_shape_spec_2_2", c_snapshot_element_shape)
    _check(checks, "ref_durability_contract", c_ref_durability)
    _check(checks, "recipe_precedence_user_over_builtin", c_recipe_precedence)
    _check(checks, "stdout_discipline", c_stdout_discipline)
    _check(checks, "method_table_completeness", c_method_table)
    try:
        detail = asyncio.run(c_protocol())
        checks.append({"name": "engine_dispatch_without_browser", "ok": True,
                       "ms": 0, "detail": detail})
    except Exception as exc:
        checks.append({"name": "engine_dispatch_without_browser", "ok": False, "ms": 0,
                       "error": f"{type(exc).__name__}: {exc}",
                       "traceback": traceback.format_exc()[-1500:]})
    try:
        detail = asyncio.run(c_request_ordering())
        checks.append({"name": "request_ordering_contract", "ok": True, "ms": 0,
                       "detail": detail})
    except Exception as exc:
        checks.append({"name": "request_ordering_contract", "ok": False, "ms": 0,
                       "error": f"{type(exc).__name__}: {exc}",
                       "traceback": traceback.format_exc()[-1500:]})

    failed = [c for c in checks if not c["ok"]]
    duration_ms = int((time.time() - started) * 1000)
    summary = {
        "selftest": True,
        "ok": not failed,
        "version": VERSION,
        "python": sys.version.split()[0],
        "playwright": _playwright_version(),
        "dataDir": str(_SELFTEST_TMP),
        "chromium": _detect_chromium_path(),
        "checks": checks,
        "passed": len(checks) - len(failed),
        "failed": len(failed),
        "total": len(checks),
        "durationMs": duration_ms,
        "ms": duration_ms,
        "note": "selftest 不打开浏览器；只验证纯逻辑与协议分发",
    }
    rpc.emit_frame(rpc.dumps(summary))
    if not failed and _SELFTEST_TMP and "--keep-tmp" not in sys.argv[1:]:
        shutil.rmtree(_SELFTEST_TMP, ignore_errors=True)
    return 1 if failed else 0


# --------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    rpc.configure_stdio()
    if "--selftest" in argv:
        return run_selftest()
    if "--version" in argv:
        rpc.emit_frame(rpc.dumps({"version": VERSION, "dataDir": str(paths.DATA_DIR),
                                  "playwright": _playwright_version()}))
        return 0
    try:
        paths.ensure_dirs()
        if not paths.PROXIES_YAML.exists():
            # 首次运行落一份可编辑的 proxies.yaml（占位 extractor 默认禁用 + 可用 static 列表）
            config_store.save_proxies(json.loads(json.dumps(config_store.DEFAULT_PROXIES)))
            rpc.log(f"wrote default proxies.yaml → {paths.PROXIES_YAML}")
        if not paths.ACCOUNTS_YAML.exists():
            config_store.save_accounts({"accounts": []})
    except Exception as exc:
        rpc.emit_frame(rpc.encode_error(None, "INTERNAL",
                                        f"cannot prepare data dir: {exc}",
                                        {"dataDir": str(paths.DATA_DIR)}))
        return 1
    engine = Engine()
    rpc.log(f"engine {VERSION} starting · dataDir={paths.DATA_DIR} · pid={os.getpid()} · "
            f"methods={len(HANDLERS)} · chromium={_detect_chromium_path()}")
    code = 0
    try:
        code = asyncio.run(serve(engine))
    except KeyboardInterrupt:  # pragma: no cover
        rpc.log("KeyboardInterrupt → shutdown")
    except Exception as exc:  # pragma: no cover
        rpc.log("fatal: " + traceback.format_exc(), level="ERROR")
        try:
            asyncio.run(engine.shutdown())
        except Exception:
            pass
        code = 1
    rpc.log(f"engine stopped (exit {code})")
    return code


if __name__ == "__main__":
    sys.exit(main())

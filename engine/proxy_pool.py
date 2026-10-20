"""代理池：可配置提取器 + 粘性绑定 + 健康探测（SPEC §4.2 / §6）。

设计要点
  * 提取器类型 ``http`` / ``static``；解析模式 ``json`` / ``text`` / ``regex``；
    ``fields`` 模板拼装 ``server/username/password``；``json_path`` 支持点号路径；
    ``separator`` 用于 text 模式；``cooldown_seconds`` 限制同一提取器的调用频率；
    ``respect_whitelist`` 时只用白名单内的 IP。
  * HTTP 抓取函数通过 :func:`fetch_from_extractor` 的 ``fetcher`` 参数注入，
    因此解析/拼装逻辑可以在**无网络**下被完整单测。
  * 绑定写 ``accounts/<code>/proxy.json``（无密码），密码写 ``secrets.yaml``。
  * 密码永不进 ``accounts.yaml``。
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta
from typing import Any, Callable

from . import config_store, paths

__all__ = [
    "ProxyUnavailable", "fetch_proxy", "get_for_account", "bind", "rotate",
    "test", "health", "fetch_from_extractor", "parse_extractor_payload",
    "build_proxy", "is_expired", "resolve_policy", "auth_url",
    "extractor_candidates", "reset_cache",
]

Fetcher = Callable[[str, str, dict, int], str]

_DEFAULT_FIELD_ORDER = ("ip", "port", "user", "pass")
_REQUIRED_FIELDS = ("server",)

_last_call: dict[str, float] = {}
_cache: dict[str, dict] = {}
_clock: Callable[[], float] = time.monotonic
_rotate_counter: dict[str, int] = {}


class ProxyUnavailable(Exception):
    """代理池没有任何可用条目（**不是**登录态失效）。"""

    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


def reset_cache() -> None:
    """单测/强制换 IP 时清空进程内缓存。"""
    _last_call.clear()
    _cache.clear()


# ------------------------------------------------------------------- 工具

def resolve_policy(code: str | None, policy: str | None = None) -> str:
    cfg = config_store.load_proxies()
    if policy:
        return str(policy)
    if code:
        per = (cfg.get("account_policy") or {}).get(str(code))
        if per:
            return str(per)
    return str(cfg.get("default_policy") or "sticky")


def is_expired(proxy: dict | None, now: float | None = None) -> bool:
    if not proxy:
        return True
    exp = proxy.get("expiresAt")
    if not exp:
        return False
    try:
        dt = datetime.fromisoformat(str(exp))
    except ValueError:
        return True
    if now is None:
        return dt <= datetime.now()
    return dt.timestamp() <= now


def _now_iso(ttl_minutes: int | None) -> str | None:
    if not ttl_minutes:
        return None
    return (datetime.now() + timedelta(minutes=int(ttl_minutes))).isoformat(timespec="seconds")


def auth_url(server: str, username: str | None = None, password: str | None = None) -> str:
    """把 ``server``（无 scheme）拼成带认证的 URL，供 requests 使用。"""
    s = str(server or "").strip()
    if not s:
        return ""
    if "://" not in s:
        s = "http://" + s
    if username:
        from urllib.parse import quote
        userinfo = quote(str(username), safe="")
        if password:
            userinfo += ":" + quote(str(password), safe="")
        scheme, _, rest = s.partition("://")
        s = f"{scheme}://{userinfo}@{rest}"
    return s


def _safe_format(template: str, record: dict) -> str:
    class _D(dict):
        def __missing__(self, key):  # noqa: D105
            return ""

    try:
        return str(template).format_map(_D({k: ("" if v is None else v)
                                           for k, v in record.items()}))
    except (ValueError, IndexError, KeyError):
        return str(template)


def _dig(data: Any, dotted_path: str) -> Any:
    cur = data
    for part in [p for p in str(dotted_path or "").split(".") if p]:
        if isinstance(cur, dict):
            if part not in cur:
                return None
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


def _as_items(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        # 常见返回：{"data": {"list": [...]}} 已由 json_path 处理；
        # 这里再兜一层 —— 若字典里只有一个 list 值，取它
        lists = [v for v in value.values() if isinstance(v, list)]
        if len(lists) == 1:
            return lists[0]
        return [value]
    return []


# ------------------------------------------------------------- 解析 / 拼装

def parse_extractor_payload(raw: str, extractor: dict) -> tuple[list[dict], list[str]]:
    """把提取器原始响应解析成 ``[{ip,port,user,pass}, ...]`` 与白名单。

    返回 ``(records, whitelist)``；解析不了就抛 :class:`ProxyUnavailable`。
    """
    mode = str(extractor.get("parse") or "json").lower()
    field_map = extractor.get("field_map") or {}
    field_map = {str(k): str(v) for k, v in field_map.items()} or {
        k: k for k in _DEFAULT_FIELD_ORDER}
    whitelist: list[str] = []
    items: list[Any] = []
    text = raw or ""

    if mode == "json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProxyUnavailable(f"extractor returned invalid JSON: {exc.msg}",
                                   {"parse": "json", "sample": text[:200]}) from exc
        wl = _dig(data, "whitelist") or _dig(data, "data.whitelist")
        if isinstance(wl, list):
            whitelist = [str(x.get("ip") if isinstance(x, dict) else x) for x in wl]
        jp = str(extractor.get("json_path") or "").strip()
        node = _dig(data, jp) if jp else data
        if node is None and jp:
            node = _dig(data, "data") if jp.startswith("data.") else data
        items = _as_items(node)
        if not items:
            raise ProxyUnavailable("extractor JSON had no proxy entries",
                                   {"json_path": jp, "sample": text[:200]})
        iv = extractor.get("item_path")
        if iv:
            out = []
            for it in items:
                sub = _dig(it, str(iv))
                out.extend(_as_items(sub) if sub is not None else [it])
            items = out
    elif mode == "text":
        sep = str(extractor.get("separator") or ":")
        order = [str(k) for k in (extractor.get("field_map") or {k: k for k in _DEFAULT_FIELD_ORDER})]
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(sep)
            if len(parts) < 2:
                continue
            rec: dict[str, Any] = {}
            for i, key in enumerate(order):
                rec[key] = parts[i] if i < len(parts) else ""
            if len(parts) > len(order):
                rec[order[-1]] = sep.join(parts[len(order) - 1:])
            items.append(rec)
        if not items:
            raise ProxyUnavailable("extractor text had no parsable lines",
                                   {"separator": sep, "sample": text[:200]})
    elif mode == "regex":
        pattern = str(extractor.get("text_regex") or "").strip()
        if not pattern:
            raise ProxyUnavailable("parse=regex but text_regex is empty")
        try:
            rx = re.compile(pattern)
        except re.error as exc:
            raise ProxyUnavailable(f"bad text_regex: {exc}") from exc
        found = 0
        for m in rx.finditer(text):
            groups = m.groupdict()
            items.append({k: (v if v is not None else "") for k, v in groups.items()})
            found += 1
        if not found:
            raise ProxyUnavailable("text_regex matched nothing",
                                   {"text_regex": pattern, "sample": text[:200]})
    else:
        raise ProxyUnavailable(f"unsupported parse mode {mode!r}")

    records: list[dict] = []
    for it in items:
        if isinstance(it, dict):
            rec = {}
            for our_key, src_key in field_map.items():
                val = _dig(it, str(src_key))
                if val is None and str(src_key) in it:
                    val = it[str(src_key)]
                rec[our_key] = "" if val is None else val
            # 直接就是 {ip,port,user,pass} 的情况
            for k in _DEFAULT_FIELD_ORDER:
                if not rec.get(k) and isinstance(it.get(k), (str, int)):
                    rec[k] = it.get(k)
            if any(str(v or "").strip() for v in rec.values()):
                records.append(rec)
        elif isinstance(it, str):
            sep = str(extractor.get("separator") or ":")
            parts = it.split(sep)
            order = list(field_map.keys())
            rec = {k: (parts[i] if i < len(parts) else "") for i, k in enumerate(order)}
            if rec:
                records.append(rec)
    if not records:
        raise ProxyUnavailable("extractor produced no usable records",
                               {"sample": text[:200]})
    return records, whitelist


def build_proxy(record: dict, extractor: dict, *, source: str, ttl_minutes: int | None) -> dict:
    """``fields`` 模板 -> ``{server, username, password, ...}``。"""
    fields = extractor.get("fields") or {}
    if not fields:
        fields = {"server": "{ip}:{port}", "username": "{user}", "password": "{pass}"}
    resolved = {k: _safe_format(v, record) for k, v in fields.items()}
    server = str(resolved.get("server") or "").strip()
    if not server:
        raise ProxyUnavailable("extractor fields produced an empty server",
                               {"fields": fields, "record": record})
    if "://" not in server:
        server = "http://" + server
    username = str(resolved.get("username") or "").strip()
    password = str(resolved.get("password") or "")
    return {
        "server": server,
        "username": username or None,
        "password": password or None,
        "ip": str(record.get("ip") or "").strip() or None,
        "expiresAt": _now_iso(ttl_minutes),
        "source": source,
        "boundAt": datetime.now().isoformat(timespec="seconds"),
    }


def _http_fetcher(url: str, method: str, headers: dict, timeout_ms: int) -> str:
    """用标准库抓取提取器响应。

    这里原先是 ``import requests``。requests 不是标准库，宿主运行时也不保证提供它：实测 DSH
    运行时升级后 requests 与 PyYAML 一起消失，引擎在 import 阶段就崩。一个「带 headers 与超时的
    GET/POST」用 ``urllib.request`` 就够，所以这个依赖被**彻底去掉**，而不是再打包一份 requests。

    失败一律抛异常（由上层转成 PROXY_UNAVAILABLE），绝不假装拿到了空响应。
    """
    import urllib.error
    import urllib.request

    request = urllib.request.Request(
        str(url),
        method=str(method or "GET").upper(),
        headers={str(k): str(v) for k, v in (headers or {}).items()},
    )
    timeout = max(1.0, int(timeout_ms) / 1000.0)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} {exc.reason}") from exc


# --------------------------------------------------------------- 提取器调用

def extractor_candidates(cfg: dict) -> list[tuple[str, dict]]:
    """可用的取 IP 来源，按顺序：先 http 提取器（配好 url 且未禁用），再 static 列表。

    ``static`` 是**一等来源**：即使 ``extractors`` 全空/全禁用，只要 static 里有条目，
    ``fetch_proxy`` 就能工作（用户还没拿到提取链接时的默认姿势）。
    """
    out: list[tuple[str, dict]] = []
    for name, ext in (cfg.get("extractors") or {}).items():
        if not isinstance(ext, dict):
            continue
        if ext.get("enabled") is False:
            continue
        if str(ext.get("type") or "http").lower() == "http" and not str(ext.get("url") or "").strip():
            continue  # 占位提取器：没填 url 就跳过
        out.append((str(name), ext))
    if cfg.get("static"):
        out.append(("static", {"type": "static",
                               "fields": {"server": "{server}", "username": "{username}",
                                          "password": "{password}"}}))
    return out


def fetch_from_extractor(name: str, extractor: dict, *, cfg: dict | None = None,
                         fetcher: Fetcher | None = None, force: bool = False,
                         now: float | None = None) -> dict:
    """调用单个提取器并返回一条可用代理（含密码）。无网络依赖（可注入 fetcher）。"""
    cfg = cfg or config_store.load_proxies()
    ttl = cfg.get("sticky_ttl_minutes", 30)
    kind = str(extractor.get("type") or "http").lower()
    now = _clock() if now is None else now

    if kind == "static":
        entries = [e for e in (cfg.get("static") or []) if isinstance(e, dict) and e.get("server")]
        if not entries:
            raise ProxyUnavailable("proxies.yaml static list is empty")
        idx = _rotate_counter.get("static", 0) % len(entries)
        _rotate_counter["static"] = idx + 1
        if force:
            idx = (idx + 1) % len(entries)
        entry = dict(entries[idx])
        server = str(entry.get("server"))
        if "://" not in server:
            server = "http://" + server
        return {
            "server": server,
            "username": entry.get("username") or None,
            "password": entry.get("password") or None,
            "ip": server.split("://", 1)[-1].split(":")[0],
            "expiresAt": None,
            "source": "static",
            "boundAt": datetime.now().isoformat(timespec="seconds"),
            "note": entry.get("note"),
        }

    if kind != "http":
        raise ProxyUnavailable(f"unsupported extractor type {kind!r}")

    cooldown = float(extractor.get("cooldown_seconds") or 0)
    last = _last_call.get(name)
    if not force and cooldown > 0 and last is not None and (now - last) < cooldown:
        cached = _cache.get(name)
        if cached:
            return dict(cached)
        raise ProxyUnavailable(
            f"extractor {name!r} in cooldown ({cooldown}s), no cached proxy",
            {"cooldown_seconds": cooldown, "elapsed": round(now - last, 3)})

    url = str(extractor.get("url") or "").strip()
    if not url:
        raise ProxyUnavailable(f"extractor {name!r} has no url configured")
    method = str(extractor.get("method") or "GET").upper()
    headers = extractor.get("headers") or {}
    timeout_ms = int((cfg.get("health_check") or {}).get("timeout_ms") or 15000)
    fetch = fetcher or _http_fetcher
    try:
        raw = fetch(url, method, headers, timeout_ms)
    except ProxyUnavailable:
        raise
    except Exception as exc:
        raise ProxyUnavailable(f"extractor {name!r} request failed: {exc}",
                               {"url": url, "method": method}) from exc
    _last_call[name] = now

    records, resp_whitelist = parse_extractor_payload(raw, extractor)
    allowed: list[str] = []
    for src in (cfg.get("whitelist") or [], resp_whitelist):
        for item in src or []:
            if isinstance(item, dict):
                ip = item.get("ip")
            else:
                ip = item
            if ip:
                allowed.append(str(ip).strip())
    if extractor.get("respect_whitelist"):
        if allowed:
            records = [r for r in records if str(r.get("ip") or "").strip() in allowed]
            if not records:
                raise ProxyUnavailable("all extracted proxies are outside the whitelist",
                                       {"whitelist": allowed[:20]})
        # 没有白名单信息时按容错处理（只记 warning，不阻断）
    proxy = build_proxy(records[0], extractor, source="api",
                        ttl_minutes=int(ttl) if ttl else None)
    proxy["extractor"] = name
    if extractor.get("respect_whitelist") and not allowed:
        proxy["warning"] = "respect_whitelist=true but no whitelist available; accepted anyway"
    _cache[name] = dict(proxy)
    return proxy


# ------------------------------------------------------------------ 对外 API

def fetch_proxy(code: str | None = None, force: bool = False) -> dict:
    """取一条代理：**先用账号已有的未过期绑定**，否则依次尝试可用提取器。

    只有 ``force=True``（rotate / 用户显式要求换 IP）才会跳过已有绑定。
    全部失败抛 :class:`ProxyUnavailable`。
    """
    bound: dict | None = None
    if code and not force:
        bound = config_store.load_account_proxy(code)
        if bound and not is_expired(bound):
            proxy = _hydrate(bound)
            proxy["source"] = bound.get("source") or "sticky"
            return proxy

    cfg = config_store.load_proxies()
    candidates = extractor_candidates(cfg)
    if not candidates:
        if bound:
            raise ProxyUnavailable(
                f"账号 {code} 的代理绑定已过期，且 proxies.yaml 没有可用提取器"
                "（extractors 全禁用/无 url，static 为空）",
                {"code": code, "boundServer": bound.get("server"),
                 "expiresAt": bound.get("expiresAt"), "tried": []})
        raise ProxyUnavailable(
            "no usable proxy extractor (proxies.yaml extractors are disabled/empty and "
            "'static' is empty)",
            {"tried": []})
    errors: list[dict] = []
    for name, ext in candidates:
        try:
            proxy = fetch_from_extractor(name, ext, cfg=cfg, force=force)
        except ProxyUnavailable as exc:
            errors.append({"extractor": name, "error": exc.message})
            continue
        if proxy.get("password") and proxy.get("username"):
            config_store.set_proxy_secret(proxy["server"], proxy["username"],
                                          proxy["password"])
        return proxy
    raise ProxyUnavailable("all proxy extractors failed", {"tried": errors})


def bind(code: str, proxy: dict | None) -> None:
    """绑定/解绑（``None`` = 直连）；密码进 secrets.yaml，proxy.json 只留 server/username。"""
    config_store.save_account_proxy(code, proxy)


def _hydrate(bound: dict) -> dict:
    out = dict(bound)
    out["password"] = config_store.get_proxy_secret(bound.get("server", ""),
                                                   bound.get("username"))
    return out


def get_for_account(code: str, policy: str = "sticky",
                    force_rotate: bool = False) -> dict | None:
    """返回该账号当前应使用的代理；``None`` 表示直连。

    只有「代理功能确实配了却拿不到」才抛 :class:`ProxyUnavailable`；完全没配置
    （既无绑定、也无可用提取器）返回 ``None``，由调用方直连并告警。
    """
    eff = resolve_policy(code, policy)
    if eff == "direct":
        return None
    cfg = config_store.load_proxies()
    ttl = int(cfg.get("sticky_ttl_minutes") or 0)
    bound = config_store.load_account_proxy(code)
    if eff == "sticky" and bound and not force_rotate and not is_expired(bound):
        return _hydrate(bound)
    if not bound and not extractor_candidates(cfg):
        return None  # 未配置代理池 ≠ 代理不可用
    proxy = fetch_proxy(code, force=force_rotate or bool(bound))
    if ttl:
        proxy["expiresAt"] = _now_iso(ttl)
    bind(code, proxy)
    return proxy


def rotate(code: str) -> dict:
    """强制换 IP 并重新绑定。"""
    reset_cache()
    proxy = fetch_proxy(code, force=True)
    cfg = config_store.load_proxies()
    ttl = int(cfg.get("sticky_ttl_minutes") or 0)
    if ttl:
        proxy["expiresAt"] = _now_iso(ttl)
    bind(code, proxy)
    return proxy


def _redact(text: str, proxy: dict) -> str:
    """错误文本里可能出现带凭据的代理 URL —— 出口必须抹掉密码。"""
    out = str(text)
    for secret in (proxy.get("password"), proxy.get("username")):
        if secret:
            out = out.replace(str(secret), "***")
    return out


def test(proxy: dict, *, fetcher: Fetcher | None = None) -> dict:
    """通过该代理访问 health_check.url，返回出口 IP 与延迟。

    失败时 ``ok=false`` 且 detail 明确是**代理**问题（绝不提登录），也绝不回传密码。
    """
    import urllib.request

    cfg = config_store.load_proxies()
    hc = cfg.get("health_check") or {}
    url = str(hc.get("url") or "https://api.ipify.org?format=json")
    timeout_ms = int(hc.get("timeout_ms") or 15000)
    server = str((proxy or {}).get("server") or "").strip()
    if not server:
        return {"ok": False, "ip": None, "latencyMs": None, "detail": "no proxy server given"}
    proxy_url = auth_url(server, proxy.get("username"), proxy.get("password"))
    # 标准库实现：ProxyHandler 对 https 目标会自动改用 CONNECT 隧道，行为与 requests 一致。
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
    started = time.time()
    try:
        with opener.open(url, timeout=max(1.0, timeout_ms / 1000.0)) as response:
            status = int(getattr(response, "status", 0) or 0)
            body = response.read().decode("utf-8", "replace")
        latency = int((time.time() - started) * 1000)
        ip = None
        try:
            parsed = json.loads(body)
            ip = parsed.get("ip") or parsed.get("origin") or parsed.get("query")
        except json.JSONDecodeError:
            ip = body.strip().splitlines()[0][:64] if body.strip() else None
        return {"ok": True, "ip": ip, "latencyMs": latency, "detail": f"HTTP {status}"}
    except Exception as exc:
        latency = int((time.time() - started) * 1000)
        detail = _redact(f"{type(exc).__name__}: {exc}", proxy or {})[:300]
        return {"ok": False, "ip": None, "latencyMs": latency,
                "detail": f"代理不可达/不可用（不是登录态问题）：{detail}"}


def health(code: str) -> dict:
    bound = config_store.load_account_proxy(code)
    if not bound:
        return {"ok": False, "ip": None, "latencyMs": None, "detail": "未绑定代理（直连）",
                "bound": False, "server": None, "username": None, "hasPassword": False,
                "expiresAt": None, "source": None}
    result = test(_hydrate(bound))
    result.update({"bound": True, "server": bound.get("server"),
                   "username": bound.get("username") or None,
                   "hasPassword": bool(config_store.get_proxy_secret(
                       bound.get("server", ""), bound.get("username"))),
                   "expiresAt": bound.get("expiresAt"),
                   "source": bound.get("source")})
    return result


def describe(code: str) -> dict:
    """给 account.list / session.open / bindProxy 用的代理摘要（永不含密码）。"""
    bound = config_store.load_account_proxy(code)
    if not bound:
        return {"bound": False, "server": None, "username": None, "hasPassword": False,
                "expiresAt": None, "source": None}
    return {
        "bound": True,
        "server": bound.get("server"),
        "username": bound.get("username") or None,
        "hasPassword": bool(config_store.get_proxy_secret(bound.get("server", ""),
                                                          bound.get("username"))),
        "expiresAt": bound.get("expiresAt"),
        "source": bound.get("source"),
    }

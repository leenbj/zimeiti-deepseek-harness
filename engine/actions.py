"""``act.*`` 动作实现（SPEC §2.1 §6）：唯一真正执行浏览器动作的地方。

每个动作返回 ``{"ms": int, "step": normalized_step, "data": {...}}``；失败统一抛
:class:`ActionError`。``step`` 是可直接写进 recipe 的规范化步骤（参数已替换、
``ref`` 已降级为可持久化的 selector/role+text）。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from . import observe
from .rpc import log
from .session import ActionError, Session

__all__ = ["execute", "resolve_params", "ActionError", "normalize_target",
           "ACTION_TYPES"]

_PLACEHOLDER = re.compile(r"\{\{([^{}]+)\}\}")
_MAX_PARAM_DEPTH = 5


# ------------------------------------------------------------------ 参数替换

def resolve_params(value: Any, params: dict[str, Any]) -> Any:
    """递归替换 ``{{name}}`` / ``{{env:NAME}}``；缺参抛 PARAM_MISSING。"""
    return _resolve(value, params or {}, 0)


def _resolve(value: Any, params: dict[str, Any], depth: int) -> Any:
    if depth > _MAX_PARAM_DEPTH:
        return value
    if isinstance(value, str):
        return _resolve_str(value, params, depth)
    if isinstance(value, list):
        return [_resolve(v, params, depth + 1) for v in value]
    if isinstance(value, tuple):
        return [_resolve(v, params, depth + 1) for v in value]
    if isinstance(value, dict):
        return {k: _resolve(v, params, depth + 1) for k, v in value.items()}
    return value


def _lookup(key: str, params: dict[str, Any]) -> Any:
    if key.startswith("env:"):
        return os.environ.get(key[4:].strip(), "")
    if key in params:
        return params[key]
    raise ActionError("PARAM_MISSING", f"missing recipe param {key!r}",
                      {"name": key, "available": sorted(map(str, params))[:40]})


def _resolve_str(text: str, params: dict[str, Any], depth: int) -> Any:
    m = _PLACEHOLDER.fullmatch(text.strip())
    if m:
        val = _lookup(m.group(1).strip(), params)
        if isinstance(val, str) and _PLACEHOLDER.search(val) and depth < _MAX_PARAM_DEPTH:
            return _resolve_str(val, params, depth + 1)
        return val

    def repl(match: re.Match) -> str:
        val = _lookup(match.group(1).strip(), params)
        if isinstance(val, (dict, list)):
            return json.dumps(val, ensure_ascii=False)
        if val is None:
            return ""
        if isinstance(val, str) and _PLACEHOLDER.search(val) and depth < _MAX_PARAM_DEPTH:
            return str(_resolve_str(val, params, depth + 1))
        return str(val)

    return _PLACEHOLDER.sub(repl, text)


# -------------------------------------------------------------------- helpers

ACTION_TYPES = (
    "goto", "click", "dispatch", "type", "press", "upload", "select", "check",
    "scroll", "waitFor", "frame", "eval", "extract", "screenshot", "snapshot",
    "sleep", "note",
)

# SPEC §2.1 的 act.* 全集：只有这些才值得进 trace 的「规范化步骤」（可选步骤不污染 recipe）
RECIPE_ACTIONS = (
    "goto", "click", "dispatch", "type", "press", "upload", "select", "check",
    "scroll", "waitFor", "frame", "eval", "extract",
)


def normalize_target(session: Session, target: dict | None) -> dict:
    """把 ``{ref}`` 降级为可持久化的 target（selector，其次 role+text）。

    SPEC §2.1 要求 ``act.*`` 返回的 ``step`` 能**直接进 recipe**；而 ``ref`` 只在下一次
    snapshot 前有效，写进 recipe 就是死引用，所以这里必须降级。
    """
    t = dict(target or {})
    if not t:
        return {}
    within = t.get("within")
    if isinstance(within, dict) and within:
        t["within"] = normalize_target(session, within)
    ref = t.pop("ref", None)
    keep = {"selector", "text", "role", "nth", "exact", "within"}
    t = {k: v for k, v in t.items() if k in keep}
    if not ref:
        return t
    extra = {k: v for k, v in t.items() if k in ("within", "exact")}
    desc = (getattr(session, "refs", None) or {}).get(str(ref)) or {}
    out: dict[str, Any] = {}
    if desc.get("selector"):
        out["selector"] = desc["selector"]
        if desc.get("nth"):
            out["nth"] = desc["nth"]
        out.update(extra)
        return out
    if desc.get("role") and desc.get("text"):
        out["role"] = desc["role"]
        out["text"] = desc["text"]
    elif desc.get("text"):
        out["text"] = desc["text"]
    if not out:
        out = {"text": str(desc.get("text") or "")}
    out.update(extra)
    return out


def _norm_step(step: dict) -> dict:
    out = dict(step)
    out.pop("_params", None)
    return out


class _Timer:
    def __init__(self) -> None:
        self._t0 = time.perf_counter()

    @property
    def ms(self) -> int:
        return int((time.perf_counter() - self._t0) * 1000)


async def execute(session: Session, step: dict, *, dry_run: bool = False) -> dict:
    """执行一个步骤。``step["type"]`` 对应 RPC 方法名后半段。"""
    if not isinstance(step, dict):
        raise ActionError("BAD_REQUEST", "step must be an object",
                          {"got": type(step).__name__})
    step = dict(step)
    params = step.pop("_params", None)
    if params is not None:
        step = resolve_params(step, params)
    kind = str(step.get("type") or "").strip()
    if not kind:
        raise ActionError("BAD_REQUEST", "step.type is required", {"step": step})
    if kind not in ACTION_TYPES:
        raise ActionError("UNSUPPORTED", f"unsupported action type {kind!r}",
                          {"type": kind, "known": list(ACTION_TYPES)})
    if dry_run and step.get("submit"):
        # dryRun 的语义：填表/截图，但不点提交。之后的步骤天然依赖提交结果
        # （等跳转 /list、提取正式链接），必须宽容处理，否则 dryRun 必然失败。
        session.dry_run_after_submit = True
        session.after_submit = True
        return {"ms": 0, "step": _norm_step(step),
                "data": {"skipped": True, "reason": "dryRun submit step skipped"}}

    handler = _HANDLERS[kind]
    timer = _Timer()
    session.last_target_info = None
    err: ActionError | None = None
    try:
        result = await handler(session, step)
    except ActionError as exc:
        err = exc
    except PlaywrightTimeoutError as exc:
        err = ActionError("TIMEOUT", f"{kind} timed out: {_first_line(exc)}",
                          {"type": kind, "step": _norm_step(step)})
    except PlaywrightError as exc:
        err = ActionError("INTERNAL", f"{kind} failed: {_first_line(exc)}",
                          {"type": kind, "step": _norm_step(step)})
    except asyncio.TimeoutError as exc:
        err = ActionError("TIMEOUT", f"{kind} timed out",
                          {"type": kind, "step": _norm_step(step)})
    except Exception as exc:  # noqa: BLE001 - 任何异常都必须变成可回传的错误
        err = ActionError("INTERNAL",
                          f"{kind} failed: {type(exc).__name__}: {_first_line(exc)}",
                          {"type": kind, "step": _norm_step(step)})
    if err is not None:
        if dry_run and session.dry_run_after_submit:
            log(f"dryRun: tolerating {kind} failure after the skipped submit step "
                f"({err.code}: {err.message})", level="WARN")
            return {"ms": timer.ms, "step": _norm_step(step),
                    "data": {"skipped": True, "dryRunTolerated": True,
                             "reason": f"dryRun: {err.code} after skipped submit",
                             "error": {"code": err.code, "message": err.message,
                                       "details": err.details}}}
        raise err

    ms = timer.ms
    data = result if isinstance(result, dict) else {"result": result}
    if kind == "extract" and isinstance(data.get("values"), dict):
        # 扁平化：agent / recipe 直接读 data.title，同时保留 data.values 结构化形式
        data = {**data["values"], **data}
    data.setdefault("ms", ms)
    info = session.last_target_info
    if isinstance(info, dict) and info.get("tier"):
        data["matchTier"] = info.get("tier")
        if info.get("ambiguous"):
            # 同一层有多个匹配：agent 需要知道「我可能点错了」
            data["ambiguous"] = True
            data["candidates"] = info.get("candidates") or []
            data["matchCount"] = info.get("matchCount")
            log(f"{kind}: text target ambiguous ({info.get('matchCount')} matches, "
                f"tier={info.get('tier')}, picked={info.get('candidates', [{}])[0].get('selector') if info.get('candidates') else None})",
                level="WARN")
    session.note("action", {"type": kind, "ms": ms,
                            "target": step.get("target") or step.get("url") or None,
                            "ok": True})
    normed = _norm_step(step)
    target = normed.get("target")
    if isinstance(target, dict) and target.get("ref"):
        resolved = normalize_target(session, target)
        data["resolvedTarget"] = dict(resolved)
        normed["target"] = resolved
    if step.get("submit"):
        # 提交动作本身；之后的「观察类」步骤（等跳转 / 提取正式链接）天然是条件性的：
        # 平台可能不跳转、可能开新标签、dryRun 更是根本不提交。标 optional 让回放
        # 只告警不判失败（SPEC §3 的 optional 语义），否则 dryRun 永远无法「完成」。
        session.after_submit = True
    elif session.after_submit and kind in ("waitFor", "extract"):
        normed["optional"] = True
        data.setdefault("optional", True)
        session.after_submit = False
    if session.recording and kind in RECIPE_ACTIONS:
        # record.py 只认 {"kind":"step","step":{...}}；只在录制态追加，避免普通交互
        # 会话把动作混进 recipe（record.start 之前的动作也不该被编译进去）。
        session.add_step(normed, ms=ms)
    return {"ms": ms, "step": normed, "data": data}


def _first_line(exc: Any) -> str:
    msg = str(exc).strip().splitlines()
    return (msg[0] if msg else type(exc).__name__)[:400]


def _target(step: dict) -> dict:
    target = step.get("target")
    if not isinstance(target, dict) or not target:
        raise ActionError("BAD_REQUEST", f"{step.get('type')} requires a target",
                          {"step": _norm_step(step)})
    return target


async def _located(session: Session, step: dict, *, single: bool = True):
    return await session.locate(_target(step), single=single)


async def _element_handle(session: Session, loc):
    handle = await loc.element_handle()
    if handle is None:
        raise ActionError("TARGET_NOT_FOUND", "element disappeared before acting", {})
    return handle


# -------------------------------------------------------------------- actions

async def _act_goto(session: Session, step: dict) -> dict:
    url = str(step.get("url") or "").strip()
    if not url:
        raise ActionError("BAD_REQUEST", "goto requires 'url'", {"step": _norm_step(step)})
    wait_until = str(step.get("waitUntil") or "domcontentloaded")
    if wait_until not in ("commit", "domcontentloaded", "load", "networkidle"):
        raise ActionError("BAD_REQUEST", f"bad waitUntil {wait_until!r}",
                          {"allowed": ["commit", "domcontentloaded", "load", "networkidle"]})
    timeout = int(step.get("timeoutMs") or 45000)
    resp = None
    try:
        resp = await session.page.goto(url, wait_until=wait_until, timeout=timeout)
    except PlaywrightTimeoutError:
        # 超时但页面往往已经可用：只有完全没内容才算失败
        try:
            body = await session.page.evaluate("() => (document.body && document.body.innerText || '').length")
        except Exception:
            body = 0
        if not body:
            raise
        log(f"goto {url} timed out on waitUntil={wait_until} but page has content; continuing",
            level="WARN")
    except PlaywrightError as exc:
        message = str(exc)
        # 这些平台在首屏之后会**客户端自发**跳转（登录重定向、路由 push），Playwright 于是报
        # 「Navigation to X is interrupted by another navigation to Y」。这是平台自己的行为、
        # 不是我们的失败：重试一次；仍失败时归类为 NAVIGATION_FAILED 并带上 URL，
        # 而不是让它冒成 INTERNAL —— 调用方看到无信息量的内部错误是没法排查的
        # （实测：搜狐未登录时就是这样，唯一线索只有那句 interrupt）。
        if "interrupted by another navigation" in message:
            log(f"goto {url} interrupted by a client-side navigation; retrying once", level="WARN")
            await asyncio.sleep(0.5)
            try:
                resp = await session.page.goto(url, wait_until=wait_until, timeout=timeout)
            except PlaywrightError as retry_exc:
                try:
                    body = await session.page.evaluate(
                        "() => (document.body && document.body.innerText || '').length")
                except Exception:
                    body = 0
                if not body:
                    raise ActionError(
                        "NAVIGATION_FAILED",
                        f"goto {url} 被平台的客户端跳转打断，重试后仍无内容：{retry_exc}",
                        {"requestedUrl": url, "finalUrl": session.page.url,
                         "reason": "interrupted-by-client-navigation",
                         "step": _norm_step(step)}) from retry_exc
                log(f"goto {url} retry still interrupted but the page has content; continuing",
                    level="WARN")
        else:
            raise ActionError(
                "NAVIGATION_FAILED",
                f"goto {url} 失败：{message}",
                {"requestedUrl": url, "finalUrl": session.page.url,
                 "step": _norm_step(step)}) from exc
    session.last_url = session.page.url
    return {"url": session.page.url, "requestedUrl": url, "waitUntil": wait_until,
            "status": (resp.status if resp is not None else None)}


async def _act_click(session: Session, step: dict) -> dict:
    target = _target(step)
    loc = await session.locate(target)
    timeout = int(step.get("timeoutMs") or 15000)
    force = bool(step.get("force", False))
    button = str(step.get("button") or "left")
    data: dict[str, Any] = {"via": "playwright"}
    try:
        await loc.click(timeout=timeout, force=force, button=button)
    except PlaywrightTimeoutError:
        # 中文站大量组件对真实鼠标事件不响应（搜狐 radio/li 按钮），必须保留 JS 兜底
        handle = await _element_handle(session, loc)
        try:
            await handle.evaluate("(el) => { el.scrollIntoView({block:'center'}); el.click(); }")
            data = {"via": "js-fallback", "reason": "playwright click timed out"}
            log("click fell back to JS click", level="WARN")
        finally:
            await handle.dispose()
    return data


async def _act_dispatch(session: Session, step: dict) -> dict:
    event = str(step.get("event") or "click")
    if event not in ("click", "input", "change", "mousedown", "mouseup", "blur", "focus"):
        raise ActionError("BAD_REQUEST", f"bad dispatch event {event!r}",
                          {"allowed": ["click", "input", "change", "mousedown",
                                       "mouseup", "blur", "focus"]})
    detail = step.get("detail")
    loc = await session.locate(_target(step))
    handle = await _element_handle(session, loc)
    try:
        events = await handle.evaluate(
            """(el, args) => {
                const seq = args.event === 'click'
                    ? ['mousedown', 'mouseup', 'click', 'change']
                    : (args.event === 'input' ? ['input', 'change'] : [args.event]);
                const out = [];
                el.scrollIntoView({block: 'center'});
                for (const name of seq) {
                    let ev;
                    if (name === 'click' || name === 'mousedown' || name === 'mouseup'
                        || name === 'dblclick') {
                        ev = new MouseEvent(name, {bubbles: true, cancelable: true,
                                                   view: window, button: 0});
                    } else {
                        ev = new Event(name, {bubbles: true, cancelable: true});
                    }
                    el.dispatchEvent(ev);
                    out.push(name);
                }
                if (el.tagName === 'LABEL') {
                    const inp = el.querySelector('input');
                    if (inp) {
                        inp.checked = true;
                        inp.dispatchEvent(new Event('input', {bubbles: true}));
                        inp.dispatchEvent(new Event('change', {bubbles: true}));
                        out.push('label->input:change');
                    }
                }
                return out;
            }""",
            {"event": event, "detail": detail},
        )
    finally:
        await handle.dispose()
    return {"events": events, "event": event}


async def _act_type(session: Session, step: dict) -> dict:
    loc = await session.locate(_target(step))
    text = step.get("text")
    if text is None:
        raise ActionError("BAD_REQUEST", "type requires 'text'", {"step": _norm_step(step)})
    text = str(text)
    mode = str(step.get("mode") or "fill")
    clear = bool(step.get("clear", True))
    delay = int(step.get("delayMs") or 0)
    timeout = int(step.get("timeoutMs") or 15000)
    if mode not in ("fill", "type", "insertText"):
        raise ActionError("BAD_REQUEST", f"bad type mode {mode!r}",
                          {"allowed": ["fill", "type", "insertText"]})

    if mode == "fill":
        value = text
        if not clear:
            try:
                current = await loc.input_value(timeout=timeout)
                value = f"{current}{text}"
            except PlaywrightError:
                pass
        await loc.fill(value, timeout=timeout)
        return {"mode": mode, "chars": len(text), "clear": clear}

    await loc.click(timeout=timeout)
    if mode == "insertText":
        await session.page.keyboard.insert_text(text)
        return {"mode": mode, "chars": len(text)}

    lines = text.split("\n")
    typed = 0
    for i, line in enumerate(lines):
        if line:
            await loc.press_sequentially(line, delay=delay)
            typed += len(line)
        if i < len(lines) - 1:
            await session.page.keyboard.press("Enter")
    return {"mode": mode, "chars": typed, "paragraphs": len(lines)}


async def _act_press(session: Session, step: dict) -> dict:
    key = str(step.get("key") or "").strip()
    if not key:
        raise ActionError("BAD_REQUEST", "press requires 'key'", {"step": _norm_step(step)})
    times = max(1, int(step.get("times") or 1))
    target = step.get("target")
    if target:
        loc = await session.locate(target)
        for _ in range(times):
            await loc.press(key, timeout=int(step.get("timeoutMs") or 15000))
    else:
        for _ in range(times):
            await session.page.keyboard.press(key)
    return {"key": key, "times": times}


async def _act_upload(session: Session, step: dict) -> dict:
    raw = step.get("paths")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        raise ActionError("BAD_REQUEST", "upload requires 'paths' (list)",
                          {"step": _norm_step(step)})
    files = [str(Path(str(p)).expanduser()) for p in raw]
    missing = [p for p in files if not Path(p).exists()]
    if missing:
        raise ActionError("BAD_REQUEST", "upload file(s) not found", {"missing": missing})
    target = _target(step)
    loc = await session.locate(target)
    try:
        await loc.set_input_files(files, timeout=int(step.get("timeoutMs") or 30000))
    except (PlaywrightError, ActionError):
        # 目标不是 input[type=file]（常见：隐藏 input 在容器里）
        alt = session.current_frame().locator("input[type=file]").first
        await alt.set_input_files(files, timeout=int(step.get("timeoutMs") or 30000))
        return {"files": files, "via": "input[type=file] fallback"}
    return {"files": files}


async def _act_select(session: Session, step: dict) -> dict:
    loc = await session.locate(_target(step))
    kwargs: dict[str, Any] = {}
    if step.get("value") is not None:
        kwargs["value"] = str(step["value"])
    if step.get("label") is not None:
        kwargs["label"] = str(step["label"])
    if step.get("index") is not None:
        kwargs["index"] = int(step["index"])
    if not kwargs:
        raise ActionError("BAD_REQUEST", "select needs value/label/index",
                          {"step": _norm_step(step)})
    values = await loc.select_option(**kwargs)
    return {"selected": values, "by": sorted(kwargs)}


async def _act_check(session: Session, step: dict) -> dict:
    loc = await session.locate(_target(step))
    want = bool(step.get("checked", True))
    try:
        if want:
            await loc.check(timeout=int(step.get("timeoutMs") or 10000))
        else:
            await loc.uncheck(timeout=int(step.get("timeoutMs") or 10000))
        return {"checked": want, "via": "playwright"}
    except PlaywrightTimeoutError:
        handle = await _element_handle(session, loc)
        try:
            await handle.evaluate(
                "(el, v) => { el.checked = v;"
                " el.dispatchEvent(new Event('input', {bubbles:true}));"
                " el.dispatchEvent(new Event('change', {bubbles:true})); }", want)
        finally:
            await handle.dispose()
        return {"checked": want, "via": "js-fallback"}


async def _act_scroll(session: Session, step: dict) -> dict:
    if step.get("target"):
        loc = await session.locate(_target(step))
        await loc.scroll_into_view_if_needed(timeout=int(step.get("timeoutMs") or 15000))
        return {"via": "scroll-into-view"}
    delta_y = int(step.get("deltaY") or 600)
    delta_x = int(step.get("deltaX") or 0)
    frame = session.current_frame()
    try:
        await frame.evaluate("(d) => window.scrollBy(d.x, d.y)",
                             {"x": delta_x, "y": delta_y})
        return {"deltaY": delta_y, "deltaX": delta_x, "via": "window.scrollBy"}
    except Exception:
        await session.page.mouse.wheel(delta_x, delta_y)
        return {"deltaY": delta_y, "deltaX": delta_x, "via": "mouse.wheel"}


async def _act_waitfor(session: Session, step: dict) -> dict:
    spec = step.get("for") or {}
    if not isinstance(spec, dict):
        raise ActionError("BAD_REQUEST", "waitFor 'for' must be an object",
                          {"step": _norm_step(step)})
    timeout = int(spec.get("timeoutMs") or step.get("timeoutMs") or 30000)
    optional = bool(step.get("optional", False))
    frame = session.current_frame()
    waited: list[str] = []
    try:
        if spec.get("selector"):
            await frame.locator(str(spec["selector"])).first.wait_for(
                state="visible", timeout=timeout)
            waited.append(f"selector:{spec['selector']}")
        if spec.get("text"):
            await frame.get_by_text(str(spec["text"])).first.wait_for(
                state="visible", timeout=timeout)
            waited.append(f"text:{spec['text']}")
        if spec.get("urlContains"):
            needle = str(spec["urlContains"])
            deadline = time.perf_counter() + timeout / 1000
            while needle not in session.page.url:
                if time.perf_counter() > deadline:
                    raise PlaywrightTimeoutError(f"url does not contain {needle!r}")
                await asyncio.sleep(0.2)
            waited.append(f"urlContains:{needle}")
        if spec.get("loadState"):
            await session.page.wait_for_load_state(str(spec["loadState"]), timeout=timeout)
            waited.append(f"loadState:{spec['loadState']}")
    except PlaywrightTimeoutError as exc:
        if optional:
            log(f"optional waitFor missed: {exc}", level="WARN")
            return {"ok": False, "waited": waited, "optional": True,
                    "warning": f"optional waitFor not satisfied: {spec}"}
        raise ActionError("TIMEOUT", f"waitFor not satisfied: {spec}",
                          {"for": spec, "waited": waited, "url": session.safe_url(),
                           "candidates": await session.candidates({"text": str(
                               spec.get("text") or spec.get("selector") or "")})}) from exc
    if not waited:
        ms = int(spec.get("timeoutMs") or 0)
        if ms:
            await asyncio.sleep(ms / 1000)
        return {"ok": True, "waited": ["sleep"], "ms": ms}
    return {"ok": True, "waited": waited}


async def _act_frame(session: Session, step: dict) -> dict:
    spec = step.get("frame")
    if spec in (None, "main", "top"):
        session.set_frame(None, [])
        return {"frame": "main", "url": session.page.main_frame.url}
    if isinstance(spec, str):
        spec = {"name": spec}
    if not isinstance(spec, dict):
        raise ActionError("BAD_REQUEST", "frame must be 'main' or an object",
                          {"step": _norm_step(step)})
    timeout_ms = int(step.get("timeoutMs") or 15000)
    deadline = time.perf_counter() + timeout_ms / 1000
    target_frame = None
    while target_frame is None:
        frames = list(session.page.frames)
        if spec.get("urlContains"):
            needle = str(spec["urlContains"])
            target_frame = next((f for f in frames if needle in (f.url or "")), None)
        elif spec.get("name"):
            name = str(spec["name"])
            target_frame = next((f for f in frames if (f.name or "") == name), None)
        elif spec.get("index") is not None:
            idx = int(spec["index"])
            target_frame = frames[idx] if 0 <= idx < len(frames) else None
        elif spec.get("selector"):
            loc = session.current_frame().locator(str(spec["selector"])).first
            if await loc.count() > 0:
                handle = await loc.element_handle()
                target_frame = await handle.content_frame() if handle else None
        else:
            raise ActionError("BAD_REQUEST",
                              "frame needs one of urlContains/name/selector/index",
                              {"frame": spec})
        if target_frame is None:
            if time.perf_counter() > deadline:
                raise ActionError("TARGET_NOT_FOUND", f"frame not found: {spec}",
                                  {"frame": spec,
                                   "frames": [{"url": f.url, "name": f.name}
                                              for f in session.page.frames][:10]})
            await asyncio.sleep(0.2)
    try:
        idx = list(session.page.frames).index(target_frame)
        path = "main" if idx == 0 else f"f{idx}"
    except ValueError:
        path = "f?"
    session.set_frame(target_frame, [path])
    return {"frame": path, "url": target_frame.url}


async def _act_eval(session: Session, step: dict) -> dict:
    expression = step.get("expression")
    if not isinstance(expression, str) or not expression.strip():
        raise ActionError("BAD_REQUEST", "eval requires 'expression'",
                          {"step": _norm_step(step)})
    frame = session.current_frame()
    arg = step.get("arg")
    try:
        result = await frame.evaluate(expression, arg)
    except PlaywrightError as exc:
        raise ActionError("INTERNAL", f"eval failed: {_first_line(exc)}",
                          {"expression": expression[:300], "purpose": step.get("purpose")}) from exc
    serializable = True
    try:
        json.dumps(result)
    except (TypeError, ValueError):
        serializable = False
        result = repr(result)[:2000]
    return {"result": result, "serializable": serializable,
            "purpose": step.get("purpose"), "escapeHatch": True}


async def _act_extract(session: Session, step: dict) -> dict:
    spec = step.get("spec")
    if not isinstance(spec, list) or not spec:
        raise ActionError("BAD_REQUEST", "extract requires a non-empty 'spec' list",
                          {"step": _norm_step(step)})
    values: dict[str, Any] = {}
    for item in spec:
        if not isinstance(item, dict) or not item.get("name"):
            raise ActionError("BAD_REQUEST", "each extract spec item needs 'name'",
                              {"item": item})
        name = str(item["name"])
        src = item.get("from") or {}
        if not isinstance(src, dict):
            raise ActionError("BAD_REQUEST", "'from' must be an object", {"item": item})
        all_matches = bool(item.get("all"))
        if src.get("url"):
            values[name] = session.page.url
            continue
        if src.get("eval"):
            values[name] = await session.current_frame().evaluate(str(src["eval"]))
            continue
        locator_src = {k: src[k] for k in ("selector", "text", "role", "nth", "exact",
                                           "ref", "within") if k in src}
        if not locator_src:
            raise ActionError("BAD_REQUEST",
                              "extract 'from' needs selector/text/role/url/eval",
                              {"item": item})
        loc = await session.locate(locator_src, single=not all_matches)
        count = await loc.count()
        if count == 0:
            if item.get("optional"):
                values[name] = None
                continue
            raise ActionError("TARGET_NOT_FOUND", f"extract {name!r}: nothing matched",
                              {"from": locator_src,
                               "candidates": await session.candidates(locator_src)})
        picks = range(min(count, 50)) if all_matches else range(1)
        collected: list[Any] = []
        for i in picks:
            node = loc if (not all_matches and count == 1) else loc.nth(i)
            if src.get("attr"):
                val = await node.get_attribute(str(src["attr"]))
            elif src.get("value"):
                try:
                    val = await node.input_value()
                except PlaywrightError:
                    val = await node.get_attribute("value")
            else:
                val = (await node.inner_text()).strip()
            collected.append(val)
        values[name] = collected if all_matches else collected[0]
    return {"values": values}


async def _act_screenshot(session: Session, step: dict) -> dict:
    return await observe.screenshot(session, full_page=bool(step.get("fullPage", False)),
                                    label=str(step.get("label") or "shot"))


async def _act_snapshot(session: Session, step: dict) -> dict:
    return await observe.snapshot(session, max_elements=int(step.get("maxElements") or 120),
                                  include_text=bool(step.get("includeText", True)))


async def _act_sleep(session: Session, step: dict) -> dict:
    ms = int(step.get("ms") or step.get("timeoutMs") or 1000)
    await asyncio.sleep(max(0, ms) / 1000)
    return {"ms": ms}


async def _act_note(session: Session, step: dict) -> dict:
    text = str(step.get("text") or "")
    session.note("note", {"text": text})
    session.notes.append({"ts": time.time(), "text": text})
    return {"text": text}


_HANDLERS = {
    "goto": _act_goto,
    "click": _act_click,
    "dispatch": _act_dispatch,
    "type": _act_type,
    "press": _act_press,
    "upload": _act_upload,
    "select": _act_select,
    "check": _act_check,
    "scroll": _act_scroll,
    "waitFor": _act_waitfor,
    "frame": _act_frame,
    "eval": _act_eval,
    "extract": _act_extract,
    "screenshot": _act_screenshot,
    "snapshot": _act_snapshot,
    "sleep": _act_sleep,
    "note": _act_note,
}

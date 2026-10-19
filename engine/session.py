"""会话对象：ref 注册表、frame 栈、trace 追加、target 解析与自愈（SPEC §2.1 §2.2 §6）。

``resolve_target`` 同时满足「同步拿到 Locator」与「严格校验失败时抛
TARGET_NOT_FOUND + details.candidates」两个要求：它返回一个薄代理，
同步用就是 Locator（属性透传），``await`` 它才做存在性校验。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:  # pragma: no cover
    from playwright.async_api import BrowserContext, Frame, Locator, Page

__all__ = ["Session", "ActionError", "ResolvedTarget"]


class ActionError(Exception):
    """动作层错误：``code`` 必须是 SPEC §2 的错误码之一。"""

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = str(code or "INTERNAL")
        self.message = str(message)
        self.details = details or {}

    def to_error(self) -> dict:
        return {"code": self.code, "message": self.message, "details": self.details}


def _now() -> str:
    return datetime.now().isoformat(timespec="milliseconds")


class ResolvedTarget:
    """Locator 的薄代理：同步即用，``await`` 则严格校验（含 candidates）。"""

    __slots__ = ("_session", "_target", "_locator")

    def __init__(self, session: "Session", target: dict, locator: "Locator"):
        self._session = session
        self._target = dict(target or {})
        self._locator = locator

    def __getattr__(self, item: str) -> Any:
        return getattr(self._locator, item)

    def __await__(self):
        return self._session.locate(self._target, single=True).__await__()

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ResolvedTarget {self._target!r}>"


@dataclass
class Session:
    session_id: str
    code: str
    context: "BrowserContext"
    page: "Page"
    proxy: dict | None
    fingerprint: dict
    headless: bool
    refs: dict[str, dict] = field(default_factory=dict)
    frame_path: list[str] = field(default_factory=list)
    trace: list[dict] = field(default_factory=list)
    recording: bool = False
    log_path: Path | None = None

    # --- 扩展字段（SPEC 允许内部自由拆分）---
    media: str = ""
    account: str = ""
    storage_state_path: Path | None = None
    interactive: bool = False
    created_at: str = field(default_factory=_now)
    active_frame: "Frame | None" = None
    frame_names: list[str] = field(default_factory=list)
    trace_path: Path | None = None
    recipe_id: str | None = None
    notes: list[dict] = field(default_factory=list)
    step_count: int = 0
    closed: bool = False
    handed_off: bool = False
    run_dir: Path | None = None
    warnings: list[str] = field(default_factory=list)
    last_url: str = ""
    proxy_policy: str = "sticky"
    submits: list[dict] = field(default_factory=list)
    dry_run_after_submit: bool = False
    after_submit: bool = False
    ref_seq: int = 0
    last_target_info: dict | None = None
    _ref_by_selector: dict[str, str] = field(default_factory=dict, repr=False)

    # ------------------------------------------------------------- frame

    def current_frame(self) -> "Frame":
        return self.active_frame or self.page.main_frame

    def set_frame(self, frame: "Frame | None", names: list[str] | None = None) -> None:
        self.active_frame = frame
        if names is not None:
            self.frame_names = list(names)
        self.frame_path = [] if frame is None or frame == self.page.main_frame else list(self.frame_names)

    # --------------------------------------------------------------- refs

    def next_ref(self) -> str:
        self.ref_seq += 1
        return f"e{self.ref_seq}"

    def reset_refs(self) -> None:
        self.refs.clear()
        self._ref_by_selector.clear()
        self.ref_seq = 0

    def register_ref(self, descriptor: dict) -> str:
        """登记一个 ref 描述符；同一个 selector 复用同一个 ref（快照内稳定）。"""
        sel = str(descriptor.get("selector") or "")
        if sel and sel in self._ref_by_selector:
            ref = self._ref_by_selector[sel]
            self.refs[ref] = dict(descriptor)
            return ref
        ref = self.next_ref()
        self.refs[ref] = dict(descriptor)
        if sel:
            self._ref_by_selector[sel] = ref
        return ref

    # ---------------------------------------------------------------- trace

    def note(self, kind: str, payload: dict) -> None:
        """追加一条 trace（内存）并落盘 JSONL（``trace_path`` 优先，其次 ``log_path``）。"""
        entry = {"ts": _now(), "kind": str(kind)}
        entry.update(payload or {})
        self.trace.append(entry)
        if kind in ("step", "action"):
            self.step_count += 1
        target = self.trace_path or self.log_path
        if target is not None:
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "a", encoding="utf-8", newline="\n") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError as exc:  # 落盘失败不能影响动作本身
                self.warnings.append(f"trace write failed: {exc}")

    def add_step(self, step: dict, *, ms: int | None = None) -> int:
        payload = {"step": step}
        if ms is not None:
            payload["ms"] = ms
        self.note("step", payload)
        return len(self.trace)

    # ------------------------------------------------------------- targets

    def _frame_of(self, descriptor: dict) -> "Frame":
        want = str(descriptor.get("inFrame") or "main")
        if want == "main" or not self.frame_names:
            return self.page.main_frame
        # f1 / f1_1 之类：能对上就切，对不上退回当前 frame
        for fr in self.page.frames:
            if getattr(fr, "name", "") == want:
                return fr
        return self.current_frame()

    def iter_locators(self, target: dict, scope: "Locator | Frame | None" = None,
                      *, deep: bool = False) -> Iterator[tuple[str, "Locator"]]:
        """按 SPEC §2.1 的优先级产出候选定位器（ref > selector > text/role）。

        ``deep=True`` 时对 ref 追加「描述符降级」与「跨 frame 重找」的自愈候选。
        """
        target = dict(target or {})
        scope = scope if scope is not None else self.current_frame()
        nth = target.get("nth")
        exact = bool(target.get("exact", False))

        ref = target.get("ref")
        if ref:
            desc = self.refs.get(str(ref))
            if desc is None:
                raise ActionError("TARGET_NOT_FOUND",
                                  f"unknown ref {ref!r}（ref 只在下一次 snapshot 前有效）",
                                  {"ref": ref, "knownRefs": sorted(self.refs)[:20]})
            yield from self._descriptor_locators(desc, scope, deep=deep)
            return

        selector = target.get("selector")
        if selector:
            yield "selector", self._scoped(scope).locator(str(selector))
            text = target.get("text")
            if deep and text:
                yield "text", self._text_locator(scope, str(text), exact, target.get("role"))
            return

        text = target.get("text")
        role = target.get("role")
        if text is None and role is None:
            raise ActionError("BAD_REQUEST",
                              "target needs one of: ref / selector / text / role",
                              {"target": target})
        if role and text is not None:
            yield "role+text", self._role_locator(scope, str(role), str(text), exact)
        elif role:
            yield "role", self._role_locator(scope, str(role), None, exact)
        if text is not None:
            yield "text", self._text_locator(scope, str(text), exact, role)
            yield "text-prefix", self._scoped(scope).locator(
                f"text={_css_quote(str(text))}" if not exact else f"text=\"{str(text)}\"")
        if deep and text is not None:
            yield "tag-has-text", self._scoped(scope).locator(
                f"*:has-text({json.dumps(str(text), ensure_ascii=False)})")

    def _descriptor_locators(self, desc: dict, scope, *, deep: bool) -> Iterator[tuple[str, "Locator"]]:
        sel = str(desc.get("selector") or desc.get("value") or "")
        frame_scope = scope
        if deep and desc.get("inFrame") and desc.get("inFrame") != "main":
            frame_scope = self._frame_of(desc)
        if sel:
            yield "ref-selector", self._scoped(frame_scope).locator(sel)
        role, text = desc.get("role"), desc.get("text")
        if deep and (role or text):
            if role and text:
                yield "ref-role+text", self._role_locator(frame_scope, str(role), str(text), False)
            if text:
                yield "ref-text", self._text_locator(frame_scope, str(text), False, role)
            tag = desc.get("tag")
            if tag and text:
                yield "ref-tag+text", self._scoped(frame_scope).locator(
                    f"{tag}:has-text({json.dumps(str(text), ensure_ascii=False)})")

    @staticmethod
    def _scoped(scope) -> Any:
        return scope

    def _role_locator(self, scope, role: str, text: str | None, exact: bool) -> "Locator":
        try:
            if text is None:
                return scope.get_by_role(role)  # type: ignore[arg-type]
            return scope.get_by_role(role, name=text, exact=exact)  # type: ignore[arg-type]
        except Exception:
            # role 不认识时降级为 text
            return scope.get_by_text(text or "", exact=exact)

    def _text_locator(self, scope, text: str, exact: bool, role: str | None) -> "Locator":
        loc = scope.get_by_text(text, exact=exact)
        return loc

    def _build_within(self, target: dict, scope: "Locator") -> Iterator[tuple[str, "Locator"]]:
        yield from self.iter_locators(target, scope=scope, deep=True)

    def build_locator(self, target: dict) -> "Locator":
        """同步构造主定位器（结构性错误立刻抛 ActionError）。"""
        target = dict(target or {})
        within = target.pop("within", None)
        if within:
            scope = self.build_locator(within)
            for _kind, loc in self._build_within(target, scope):
                return loc
            raise ActionError("TARGET_NOT_FOUND", "within 目标无法构造",
                              {"within": within})
        for _kind, loc in self.iter_locators(target):
            return loc
        raise ActionError("BAD_REQUEST", "empty target", {"target": target})

    def resolve_target(self, target: dict) -> Any:
        """SPEC §6 签名（同步）-> Locator；``await`` 它则做严格校验。"""
        return ResolvedTarget(self, dict(target or {}), self.build_locator(target))

    async def locate(self, target: dict, *, single: bool = True) -> "Locator":
        """严格定位：找不到抛 ``ActionError("TARGET_NOT_FOUND")`` 并附候选元素。"""
        target = dict(target or {})
        within = target.pop("within", None)
        scope = None
        if within:
            scope = await self.locate(within, single=True)

        # 纯 text 目标走四级优先级解析：短动作词（发布/提交）不会被 <h1>发布中心</h1> 抢走
        if (scope is None and not target.get("ref") and not target.get("selector")
                and target.get("text") is not None and not target.get("role")):
            loc = await self._text_priority(target, single=single)
            if loc is not None:
                return loc
            raise ActionError(
                "TARGET_NOT_FOUND",
                f"no element matched text {target.get('text')!r}",
                {"target": target, "tiers": (self.last_target_info or {}).get("tierCounts"),
                 "candidates": (self.last_target_info or {}).get("candidates") or [],
                 "url": self.safe_url(),
                 "hint": "可加 role/nth，或用 selector 定位"})

        last_kind = None
        for kind, loc in (self._build_within(target, scope) if scope is not None
                          else self.iter_locators(target, deep=True)):
            last_kind = kind
            try:
                count = await loc.count()
            except Exception as exc:  # 无效 selector 等
                continue
            if count > 0:
                if not single:
                    return loc
                nth = target.get("nth")
                idx = 0
                if isinstance(nth, int):
                    idx = nth
                if idx >= count:
                    break
                return loc.nth(idx) if count > 1 else loc
        candidates = await self.candidates(target)
        raise ActionError(
            "TARGET_NOT_FOUND",
            f"no element matched target {_short(target)}",
            {"target": target, "triedAs": last_kind, "candidates": candidates,
             "url": self.safe_url(), "hint": "用 candidates 里的 selector / role+text 重试"},
        )

    async def _text_priority(self, target: dict, *, single: bool = True) -> "Locator | None":
        """四级优先级文本定位；命中后把 tier/ambiguity 写进 ``last_target_info``。"""
        from . import observe  # 延迟导入避免循环依赖

        text = str(target.get("text"))
        exact = bool(target.get("exact", False))
        nth = target.get("nth")
        frame = self.current_frame()
        try:
            info = await observe.find_by_text(frame, text, exact=exact, limit=10)
        except Exception as exc:
            self.last_target_info = {"error": f"text resolver failed: {exc!r}"}
            return None
        winner = info.get("winner") or None
        self.last_target_info = {
            "text": text, "tier": info.get("tier"), "tierCounts": info.get("tierCounts"),
            "matchCount": info.get("matchCount"), "visibleCount": info.get("visibleCount"),
            "ambiguous": bool(info.get("ambiguous")),
            "candidates": _compact_candidates(info.get("candidates") or []),
        }
        if not winner or not winner.get("selector"):
            return None
        loc = frame.locator(str(winner["selector"]))
        idx = int(nth) if isinstance(nth, int) else int(winner.get("nth") or 0)
        if single:
            return loc.nth(idx)
        return loc

    async def candidates(self, target: dict | None = None, limit: int = 10) -> list[dict]:
        """当前页面上的候选元素（按与目标 text 的相似度排序），供 agent 自纠。"""
        from . import observe  # 延迟导入避免循环依赖

        want = ""
        if isinstance(target, dict):
            want = str(target.get("text") or target.get("selector") or target.get("ref") or "")
        try:
            elements = await observe.scan_elements(self, max_elements=80)
        except Exception:
            return []
        if want:
            import difflib

            def score(el: dict) -> float:
                hay = f"{el.get('text') or ''} {el.get('selector') or ''} {el.get('role') or ''}"
                return difflib.SequenceMatcher(None, want, hay).ratio()

            elements.sort(key=score, reverse=True)
        return elements[:limit]

    # ---------------------------------------------------------------- info

    def safe_url(self) -> str:
        try:
            return self.page.url
        except Exception:  # pragma: no cover - 页面已关闭
            return self.last_url

    async def state(self) -> dict:
        url = self.safe_url()
        try:
            title = await self.page.title()
        except Exception:
            title = ""
        return {
            "sessionId": self.session_id,
            "accountCode": self.code,
            "url": url,
            "title": title,
            "recording": self.recording,
            "stepCount": self.step_count,
            "headless": self.headless,
            "activeFrame": self.frame_path[-1] if self.frame_path else "main",
            "proxy": _proxy_public(self.proxy),
        }

    def list_item(self) -> dict:
        return {
            "sessionId": self.session_id,
            "accountCode": self.code,
            "url": self.safe_url(),
            "recording": self.recording,
            "headless": self.headless,
        }


def _compact_candidates(items: list) -> list:
    """候选元素压缩成 agent 能直接用的形式（selector/role/text/visible）。"""
    out = []
    for el in items or []:
        if not isinstance(el, dict):
            continue
        out.append({
            "tag": el.get("tag"), "role": el.get("role"), "text": el.get("text"),
            "selector": el.get("selector"), "nth": el.get("nth"),
            "visible": bool(el.get("visible")), "inViewport": bool(el.get("inViewport")),
        })
    return out[:10]


def _short(target: dict, n: int = 120) -> str:
    try:
        s = json.dumps(target, ensure_ascii=False)
    except Exception:
        s = str(target)
    return s if len(s) <= n else s[:n] + "…"


def _css_quote(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def _proxy_public(proxy: dict | None) -> dict | None:
    if not proxy:
        return None
    return {
        "server": proxy.get("server"),
        "username": proxy.get("username") or None,
        "hasPassword": bool(proxy.get("password")),
        "expiresAt": proxy.get("expiresAt"),
        "source": proxy.get("source"),
    }


def monotonic_ms() -> float:
    return time.perf_counter() * 1000.0

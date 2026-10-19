"""record.py — 录制轨迹（session.trace）→ recipe 编译。

契约见 docs/SPEC.md §3（recipe 规范）与 §6（record.py 签名）。

设计要点
--------
* 本模块**不直接触碰浏览器**：所有动作都由 `actions.execute` 执行、由 sessiond 的分派器
  在 `session.recording` 为真时把规范化步骤追加进 `session.trace`。record.py 只读 trace。
* 兄弟模块（paths/config_store/actions/play）一律**惰性导入**并做保护，使本模块在
  兄弟模块尚未就绪时依然可导入、其纯函数依然可单测。
* `infer_params` / `compile_recipe` / `_pick_submit_step` / `summarize_step` 都是纯逻辑
  （无 I/O、无随机、确定性），由 tests/test_recipes.py 覆盖。
* 绝不向 stdout 打印任何东西（SPEC §2 协议纪律）；日志一律走 stderr。
"""

from __future__ import annotations

import copy
import importlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 启动期：UTF-8 化 stdout/stderr（幂等），且本模块永不写 stdout
# ---------------------------------------------------------------------------
for _stream in (sys.stdout, sys.stderr):
    try:  # pragma: no cover - 平台相关
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass


def _stderr(msg: str) -> None:
    """只写 stderr（SPEC §2 协议纪律：stdout 只允许协议帧）。"""
    try:
        sys.stderr.write(f"[record] {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 惰性导入：兄弟模块可能仍在并行实现中
# ---------------------------------------------------------------------------
_MOD_CACHE: dict[str, Any] = {}


def _lazy(name: str) -> Any:
    """尽力导入 engine.<name>（或顶层 <name>）；失败返回 None。"""
    if name in _MOD_CACHE:
        return _MOD_CACHE[name]
    pkg = __package__ or ""
    cands: list[str] = []
    if pkg:
        cands.append(f"{pkg}.{name}")
    cands += [f"engine.{name}", name]
    found = None
    seen: set[str] = set()
    for cand in cands:
        if cand in seen:
            continue
        seen.add(cand)
        try:
            found = importlib.import_module(cand)
            break
        except ModuleNotFoundError as exc:
            missing = getattr(exc, "name", "") or ""
            # 只吞掉“这个候选模块本身不存在”，兄弟模块内部的 ImportError 必须冒泡
            if missing == cand or cand.startswith(missing + ".") or missing.startswith(cand + "."):
                continue
            raise
    _MOD_CACHE[name] = found
    return found


def _require(name: str) -> Any:
    mod = _lazy(name)
    if mod is None:
        _action_error("INTERNAL", f"engine.{name} 不可用（兄弟模块尚未就绪）")
    return mod


def _action_error(code: str, message: str, details: dict | None = None) -> None:
    actions = _lazy("actions")
    if actions is not None and hasattr(actions, "ActionError"):
        raise actions.ActionError(code, message, details or {})
    raise RuntimeError(f"{code}: {message} {details or ''}")  # pragma: no cover


# ---------------------------------------------------------------------------
# 步骤分类：recipe 的 step.type 与 RPC act.* 一一对应（SPEC §3）
# ---------------------------------------------------------------------------
RECIPE_STEP_TYPES: tuple[str, ...] = (
    "goto", "click", "dispatch", "type", "press", "upload", "select",
    "check", "scroll", "waitFor", "frame", "eval", "extract",
    # actions.ACTION_TYPES 里额外的可用步骤（同一张分发表）
    "screenshot", "snapshot", "sleep",
)

NOTE_STEP_TYPE = "note"

#: session.note(kind=...) 里这些 kind 不是可进 recipe 的步骤
_NON_STEP_KINDS = frozenset({
    "action", "note", "snapshot", "screenshot", "session.open", "session.close",
    "closed", "handoff", "record", "step.error", "play", "warn", "error",
})

#: 正文判定阈值（保守：宁可漏判也不误判）
BODY_MIN_LEN = 80
BODY_MIN_LEN_MULTILINE = 40
TITLE_MIN_LEN = 3
TITLE_MAX_LEN = 120

EDITOR_HINTS = (
    "ql-editor", "contenteditable", "prosemirror", "cke_wysiwyg", "ckeditor",
    "wysiwyg", "note-editable", ".rte", "editor-body", "editor_content",
    "editable", "ueditor", "tinymce",
)
TITLE_HINTS = ("标题", "title", "subject", "headline")
RADIO_HINTS = ("radio", "statement-panel", "checkbox")

#: 明显是 UI 文案而非文章载荷的字符串，绝不参数化
UI_LABEL_DENY = frozenset({
    "发布", "发布内容", "提交", "确认", "确认发布", "取消", "确定", "关闭", "保存",
    "存草稿", "预览", "我知道了", "添加文章标签", "免费正版图片", "单图", "三图",
    "无封面", "返回编辑", "预览并发布", "发布博客", "登录", "下一步", "返回",
})

#: 搜狐创作声明候选值（NOTES-sohu.md:27 实测）
DECLARATION_VALUES = (
    "无需声明", "含有虚构演绎内容", "含有AI生成内容", "含有营销信息",
    "内容为转载", "内容为个人观点",
)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _target(step: Any) -> dict:
    t = step.get("target") if isinstance(step, dict) else None
    return t if isinstance(t, dict) else {}


def normalize_step_entry(entry: Any) -> dict | None:
    """把 session.trace 的条目归一成「可进 recipe 的步骤」；无法归一返回 None。

    分派器可能写入的三种形状都要容忍：
    * ``{"type": "click", "target": {...}}``                    —— 规范化步骤本身；
    * ``{"kind": "step", "step": {...}}``                       —— session.add_step 的封装；
    * ``{"kind": "step", "type": "click", "target": {...}}``    —— 步骤字段被拍平的封装。
    而 actions.execute 现在写的是 ``{"kind": "action", "type": ..., "target": ...}``
    —— 只有摘要、没有 url/text/spec 等载荷，**不足以编译 recipe**，因此判为 None，
    并由 :func:`trace_diagnostics` 显式报出来（见 compile-report 的 traceDiagnostics）。
    """
    if not isinstance(entry, dict):
        return None
    kind = entry.get("kind")
    if kind == "step":
        inner = entry.get("step")
        if isinstance(inner, dict):
            return copy.deepcopy(inner) if inner.get("type") in RECIPE_STEP_TYPES else None
        if entry.get("type") in RECIPE_STEP_TYPES:
            flat = {k: v for k, v in entry.items() if k not in ("kind", "ts", "ms")}
            return copy.deepcopy(flat)
        return None
    if kind is not None and kind in _NON_STEP_KINDS:
        return None
    if kind is None and entry.get("type") in RECIPE_STEP_TYPES:
        return copy.deepcopy(entry)
    return None


def is_recipe_step(entry: Any) -> bool:
    return normalize_step_entry(entry) is not None


def recipe_steps(trace: Any) -> list[dict]:
    if not isinstance(trace, list):
        return []
    out: list[dict] = []
    for entry in trace:
        step = normalize_step_entry(entry)
        if step is not None:
            out.append(step)
    return out


def trace_diagnostics(trace: Any) -> dict:
    """统计 trace 条目构成 —— 用来明确报告「分派器有没有补记规范化步骤」。"""
    diag = {"total": 0, "steps": 0, "stepEnvelope": 0, "actionOnly": 0, "other": 0}
    if not isinstance(trace, list):
        return diag
    for entry in trace:
        diag["total"] += 1
        if not isinstance(entry, dict):
            diag["other"] += 1
            continue
        kind = entry.get("kind")
        if kind == "step":
            diag["stepEnvelope"] += 1
            if normalize_step_entry(entry) is not None:
                diag["steps"] += 1
        elif kind == "action":
            diag["actionOnly"] += 1
        elif kind is None and entry.get("type") in RECIPE_STEP_TYPES:
            diag["steps"] += 1
        else:
            diag["other"] += 1
    return diag


def dispatcher_gap(diag: dict) -> str | None:
    """当 trace 里只有 action 摘要、没有规范化步骤时，返回一句可执行的诊断。"""
    if diag.get("actionOnly", 0) > 0 and diag.get("steps", 0) == 0:
        return (
            f"session.trace 里有 {diag['actionOnly']} 条 actions.execute 的 action 摘要，"
            "但没有任何规范化步骤（缺 url/text/spec 等载荷），无法编译出可回放的 recipe。"
            "需要分派器在录制态补记规范化步骤，例如在 engine/actions.py 的 execute() 末尾："
            "`if session.recording: session.add_step(result['step'], ms=ms)`"
            "（或 sessiond 的 _act() 里用 response['step'] 调用 session.add_step）。"
        )
    return None


def summarize_step(step: dict) -> str:
    """给 status/UI 用的一行摘要（纯函数）。"""
    if not isinstance(step, dict):
        return "?"
    stype = str(step.get("type") or "?")
    tgt = _target(step)
    loc = tgt.get("selector") or (
        f"text={tgt.get('text')!r}" if tgt.get("text") else (tgt.get("ref") or "")
    )
    if stype == "goto":
        return f"goto {step.get('url', '')}"
    if stype == "type":
        return f"type({step.get('mode', 'fill')}) {loc} ← {_short(step.get('text', ''))}"
    if stype == "waitFor":
        return "waitFor " + json.dumps(step.get("for", {}), ensure_ascii=False)
    if stype == "extract":
        names = ",".join(str(s.get("name")) for s in (step.get("spec") or []) if isinstance(s, dict))
        return f"extract {names}".strip()
    if stype == "eval":
        return f"eval {_short(step.get('expression', ''))}"
    if stype == "frame":
        return f"frame {step.get('frame')}"
    if stype == NOTE_STEP_TYPE:
        return f"note {_short(step.get('text', ''))}"
    return f"{stype} {loc}".strip()


def _short(value: Any, limit: int = 28) -> str:
    s = str(value or "").replace("\n", " ⏎ ").strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# 录制元数据（用 id(session) 做键：Session 是 dataclass，可能不可哈希）
# ---------------------------------------------------------------------------
_RECORDINGS: dict[int, dict] = {}


def _meta(session: Any) -> dict:
    return _RECORDINGS.get(id(session), {})


def _unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(1, 1000):
        cand = path.with_name(f"{path.stem}-{i}{path.suffix}")
        if not cand.exists():
            return cand
    return path  # pragma: no cover


def _append_trace_line(session: Any, payload: dict) -> None:
    meta = _meta(session)
    path = meta.get("trace_path")
    if not path:
        return
    try:
        with Path(path).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception as exc:  # pragma: no cover
        _stderr(f"写 trace 失败：{exc}")


# ---------------------------------------------------------------------------
# record.* 生命周期
# ---------------------------------------------------------------------------
def start(session: Any, recipe_id: str, media: str) -> dict:
    """标记 session 进入录制态，并在 paths.TRACES_DIR 下建 JSONL 轨迹文件。"""
    paths = _require("paths")
    rid = str(recipe_id or "").strip()
    med = str(media or "").strip()
    if not rid:
        _action_error("BAD_REQUEST", "record.start 需要 recipe_id")
    if not med:
        med = rid.split("__")[0] or "unknown"

    try:
        paths.ensure_dirs()
    except Exception:
        pass

    traces_dir = getattr(paths, "TRACES_DIR", None)
    if traces_dir is None:
        _action_error("INTERNAL", "paths.TRACES_DIR 不可用")

    ts = paths.timestamp() if hasattr(paths, "timestamp") else datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = paths.safe_slug(rid) if hasattr(paths, "safe_slug") else re.sub(r"[^A-Za-z0-9_.\-]+", "-", rid)
    trace_path = Path(traces_dir) / f"{ts}-{med}-{slug}.jsonl"
    try:
        trace_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    trace_path = _unique_path(trace_path)

    started = _now()
    header = {
        "kind": "record.start",
        "recipeVersion": 1,
        "recipeId": rid,
        "media": med,
        "sessionId": getattr(session, "session_id", None),
        "code": getattr(session, "code", None),
        "startedAt": started,
    }
    try:
        trace_path.write_text(json.dumps(header, ensure_ascii=False) + "\n", encoding="utf-8")
    except Exception as exc:
        _action_error("INTERNAL", f"无法创建轨迹文件 {trace_path}: {exc}")

    session.recording = True
    # 让 Session.note 把后续 trace（含 actions 的 action 摘要）也写进本次录制轨迹文件
    for attr, value in (("trace_path", trace_path), ("recipe_id", rid)):
        try:
            if hasattr(session, attr):
                setattr(session, attr, value)
        except Exception:
            pass
    _RECORDINGS[id(session)] = {
        "recipe_id": rid,
        "media": med,
        "trace_path": str(trace_path),
        "started_at": started,
    }
    _stderr(f"record.start recipe={rid} media={med} trace={trace_path}")
    return {"recording": True, "tracePath": str(trace_path), "recipeId": rid, "media": med, "startedAt": started}


def status(session: Any) -> dict:
    trace = getattr(session, "trace", None) or []
    steps = recipe_steps(trace)
    meta = _meta(session)
    diag = trace_diagnostics(trace)
    return {
        "recording": bool(getattr(session, "recording", False)),
        "recipeId": meta.get("recipe_id"),
        "media": meta.get("media"),
        "tracePath": meta.get("trace_path"),
        "stepCount": len(steps),
        "steps": [
            {"index": i, "type": s.get("type"), "summary": summarize_step(s)}
            for i, s in enumerate(steps)
        ],
        "diagnostics": diag,
        "dispatcherGap": dispatcher_gap(diag),
    }


def note(session: Any, text: str) -> dict:
    """注释步骤：进 trace 与轨迹文件，但绝不进 recipe。"""
    trace = getattr(session, "trace", None)
    if trace is None:
        trace = []
        try:
            session.trace = trace
        except Exception:  # pragma: no cover
            _action_error("INTERNAL", "session.trace 不可写")
    entry = {"type": NOTE_STEP_TYPE, "text": str(text or ""), "at": _now()}
    trace.append(entry)
    _append_trace_line(session, {"kind": NOTE_STEP_TYPE, **entry})
    return {"ok": True, "index": len(trace) - 1, "text": entry["text"]}


def undo(session: Any, count: int = 1) -> dict:
    trace = getattr(session, "trace", None)
    if not isinstance(trace, list):
        return {"removed": 0}
    try:
        want = max(0, int(count))
    except Exception:
        want = 1
    removed = 0
    for i in range(len(trace) - 1, -1, -1):
        if removed >= want:
            break
        if is_recipe_step(trace[i]):
            del trace[i]
            removed += 1
    _stderr(f"record.undo removed={removed} (want={want})")
    return {"removed": removed}


# ---------------------------------------------------------------------------
# infer_params：把“真发时敲进去的字面量”变成 {{title}} / {{body}} 模板
# ---------------------------------------------------------------------------
def _placeholder(selector: str) -> str:
    if not selector:
        return ""
    m = re.search(r"""placeholder\s*(?:[*^$|~]?=)\s*["']([^"']*)["']""", selector, re.I)
    return m.group(1) if m else ""


def _classify_target(step: dict) -> str:
    """返回 "editor" | "title" | "radio" | ""。"""
    tgt = _target(step)
    sel = str(tgt.get("selector") or "")
    txt = str(tgt.get("text") or "")
    ph = _placeholder(sel)
    low = f"{sel} {ph} {txt}".lower()

    title_ish = any(h in low for h in TITLE_HINTS)
    input_like = bool(re.search(r"\b(input|textarea)\b", sel, re.I))
    if title_ish and (input_like or not any(h in low for h in EDITOR_HINTS)):
        return "title"
    if any(h in low for h in EDITOR_HINTS):
        return "editor"
    if any(h in low for h in RADIO_HINTS):
        return "radio"
    if txt.strip() and txt.strip() in DECLARATION_VALUES:
        # 以文本定位时（SPEC §3 示例写法）也能认出创作声明 radio
        return "radio"
    return ""


def _payload_slots(step: dict) -> list[tuple[tuple[str, ...], str]]:
    """步骤里“承载字面量”的字段（路径, 值）。eval 逃生舱不自动参数化。"""
    stype = step.get("type")
    out: list[tuple[tuple[str, ...], str]] = []
    if stype == "type":
        if isinstance(step.get("text"), str):
            out.append((("text",), step["text"]))
    elif stype == "select":
        for key in ("value", "label"):
            if isinstance(step.get(key), str):
                out.append(((key,), step[key]))
    elif stype in ("dispatch", "click"):
        tgt = _target(step)
        if isinstance(tgt.get("text"), str) and tgt.get("text"):
            out.append((("target", "text"), tgt["text"]))
        if isinstance(step.get("detail"), str):
            out.append((("detail",), step["detail"]))
    return out


def _looks_like_url(value: str) -> bool:
    return bool(re.match(r"^\s*(https?|file|data|about|chrome):", value, re.I))


def _set_path(step: dict, path: tuple[str, ...], value: Any) -> None:
    node: Any = step
    for key in path[:-1]:
        if not isinstance(node.get(key), dict):
            node[key] = {}
        node = node[key]
    node[path[-1]] = value


def _get_path(step: dict, path: tuple[str, ...]) -> Any:
    node: Any = step
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _merge_editor_runs(steps: list[dict], decisions: list[dict]) -> None:
    """把“逐段录制”的同一编辑器连续 type 步骤合并成一步（正文含 \\n）。

    只在同 type、同 mode、同 target.selector、且目标判定为编辑器的连续步骤上生效。
    """
    i = 0
    while i < len(steps) - 1:
        a, b = steps[i], steps[i + 1]
        if not (isinstance(a, dict) and isinstance(b, dict)):
            i += 1
            continue
        if a.get("type") != "type" or b.get("type") != "type":
            i += 1
            continue
        sa, sb = str(_target(a).get("selector") or ""), str(_target(b).get("selector") or "")
        if not sa or sa != sb:
            i += 1
            continue
        if _classify_target(a) != "editor" or _classify_target(b) != "editor":
            i += 1
            continue
        if str(a.get("mode") or "fill") != str(b.get("mode") or "fill"):
            i += 1
            continue
        ta, tb = a.get("text"), b.get("text")
        if not isinstance(ta, str) or not isinstance(tb, str) or not ta.strip() or not tb.strip():
            i += 1
            continue
        if len(ta) + len(tb) + 1 > 20000:
            i += 1
            continue
        a["text"] = f"{ta}\n{tb}"
        del steps[i + 1]
        decisions.append({
            "kind": "merge",
            "stepIndex": i,
            "mergedCount": 2,
            "reason": f"连续逐段录入同一编辑器（{sa}），合并为单步并按 \\n 分段",
        })
        # 不前进，继续尝试与下一个合并


def infer_params(steps: list[dict], *, report: dict | None = None) -> list[dict]:
    """从 trace 推断参数，并**就地**把步骤里的字面量替换成 ``{{param}}`` 模板。

    保守策略（可解释、可审计）：
    * 编辑器目标 + 长文本/多行 → ``body``；
    * 标题类目标（placeholder/selector 含 标题/title）+ 标题长度 → ``title``；
    * radio 目标 + 值属于搜狐创作声明集合 → ``declaration``（enum）；
    * ``eval`` 逃生舱一律不自动参数化；
    * 其余字面量保持原样，并在 report 里写明原因。

    返回 params 列表（SPEC §3 结构）。确定性、无 I/O。
    """
    steps = steps if isinstance(steps, list) else []
    decisions: list[dict] = []
    merges: list[dict] = []

    _merge_editor_runs(steps, decisions)
    for d in decisions:
        if d.get("kind") == "merge":
            merges.append(d)

    # ---- 收集候选 ----
    slots: list[dict] = []
    for idx, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        stype = str(step.get("type") or "")
        hint = _classify_target(step)
        for path, value in _payload_slots(step):
            if not isinstance(value, str) or not value.strip():
                continue
            decision = {
                "stepIndex": idx,
                "path": ".".join(path),
                "stepType": stype,
                "targetHint": hint or None,
                "valueLength": len(value),
                "preview": _short(value, 40),
            }
            if "{{" in value:
                decisions.append({**decision, "decision": "kept-literal", "param": None,
                                  "reason": "已是模板，跳过"})
                continue
            if stype == "eval":
                decisions.append({**decision, "decision": "kept-literal", "param": None,
                                  "reason": "eval 逃生舱不自动参数化（JS 源码内替换不安全），需人工确认"})
                continue
            slots.append({
                "index": idx, "path": path, "value": value, "hint": hint,
                "stepType": stype, "decision": decision,
            })

    chosen: dict[str, str] = {}   # param -> 选中的字面量
    params: dict[str, dict] = {}

    def _mark(slot: dict, decision: str, param: str | None, reason: str) -> None:
        decisions.append({**slot["decision"], "decision": decision, "param": param, "reason": reason})

    # ---- 1) body：编辑器目标 或 长文本 ----
    body_slots = []
    for slot in slots:
        value = slot["value"]
        multiline = "\n" in value
        long_enough = len(value) >= BODY_MIN_LEN or (multiline and len(value) >= BODY_MIN_LEN_MULTILINE)
        if slot["hint"] == "editor":
            body_slots.append((slot, long_enough, "目标判定为编辑器(ql-editor/contenteditable/cke/prosemirror)"))
        elif long_enough and slot["stepType"] == "type" and slot["path"] == ("text",):
            body_slots.append((slot, True, f"type 步骤承载 {len(value)} 字长文本，判定为正文"))

    if body_slots:
        best = max(body_slots, key=lambda item: len(item[0]["value"]))
        chosen["body"] = best[0]["value"]
        params["body"] = {"name": "body", "type": "text", "required": True, "min_len": 1}
        for slot, long_enough, why in body_slots:
            if slot is best[0]:
                _mark(slot, "parameterized", "body", why)
            elif slot["value"] == best[0]["value"]:
                _mark(slot, "parameterized", "body", "与已选 body 字面量完全相同")
            else:
                _mark(slot, "kept-literal", None,
                      "已有一个 body 参数，本步骤内容不同，保守保留字面量（请人工确认）")

    # ---- 2) title ----
    title_slots = []
    for slot in slots:
        if slot["hint"] != "title":
            continue
        value = slot["value"].strip()
        if not (TITLE_MIN_LEN <= len(value) <= TITLE_MAX_LEN) or "\n" in value:
            _mark(slot, "kept-literal", None,
                  f"目标像标题但长度 {len(value)} 不在 {TITLE_MIN_LEN}~{TITLE_MAX_LEN} 之间")
            continue
        if value in UI_LABEL_DENY or _looks_like_url(value):
            _mark(slot, "kept-literal", None, "像 UI 文案/URL，不参数化")
            continue
        title_slots.append(slot)

    if title_slots:
        best_title = title_slots[0]
        chosen["title"] = best_title["value"]
        params["title"] = {"name": "title", "type": "string", "required": True}
        for slot in title_slots:
            if slot is best_title:
                _mark(slot, "parameterized", "title",
                      "目标 placeholder/selector 含 标题/title 且长度符合标题")
            elif slot["value"] == best_title["value"]:
                _mark(slot, "parameterized", "title", "与已选 title 字面量完全相同")
            else:
                _mark(slot, "kept-literal", None, "已有 title 参数，保留原字面量")

    # ---- 3) declaration（搜狐创作声明，enum）----
    decl_slots = [
        s for s in slots
        if s["hint"] == "radio" and s["value"] in DECLARATION_VALUES and s["stepType"] in ("dispatch", "click")
    ]
    if decl_slots:
        best_decl = decl_slots[0]
        chosen["declaration"] = best_decl["value"]
        params["declaration"] = {
            "name": "declaration", "type": "enum", "required": False,
            "values": [best_decl["value"]], "default": best_decl["value"],
        }
        for slot in decl_slots:
            if slot is best_decl:
                _mark(slot, "parameterized", "declaration",
                      "radio 目标且取值属于创作声明集合（NOTES-sohu.md:27）")
            else:
                _mark(slot, "kept-literal", None, "已有 declaration 参数，保留原字面量")

    # ---- 4) 其余候选：说明为何保持字面量 ----
    handled = {id(s) for s in slots if any(
        d.get("stepIndex") == s["index"] and d.get("path") == ".".join(s["path"]) for d in decisions
    )}
    for slot in slots:
        if id(slot) in handled:
            continue
        value = slot["value"]
        if slot["hint"] == "editor":
            reason = f"编辑器目标但文本过短（{len(value)} 字），保守不参数化"
        elif slot["hint"]:
            reason = f"目标提示为 {slot['hint']}，但不满足该参数的判定条件"
        else:
            reason = "目标无标题/正文提示，保守不参数化"
        _mark(slot, "kept-literal", None, reason)

    # ---- 5) 就地替换 ----
    replaced = 0
    for slot in slots:
        name = None
        for cand_name, value in chosen.items():
            if slot["value"] == value:
                name = cand_name
                break
        if name is None:
            continue
        # 被 body 抢占的标题式步骤不替换
        if name == "title" and "body" in chosen and slot["value"] == chosen.get("body"):
            continue
        _set_path(steps[slot["index"]], slot["path"], "{{" + name + "}}")
        replaced += 1

    ordered = [params[k] for k in ("title", "body", "declaration") if k in params]

    if report is not None:
        report.clear()
        report.update({
            "params": copy.deepcopy(ordered),
            "decisions": decisions,
            "merges": merges,
            "replaced": replaced,
            "unparameterized": [d for d in decisions if d.get("decision") == "kept-literal"],
        })
    return ordered


# ---------------------------------------------------------------------------
# submit 步骤判定
# ---------------------------------------------------------------------------
SUBMIT_TEXT_RE = re.compile(r"发布|提交|publish|submit", re.I)
SUBMIT_TEXT_DENY = ("发布内容", "发布设置", "发布记录", "发布管理", "发布帮助", "发布入口")
SUBMIT_SELECTOR_RE = re.compile(
    r"publish-report-btn|publish[_-]?submit|submit[_-]?btn|btn[_-]?submit|"
    r"confirm[_-]?publish|submit-btn|#submit\b",
    re.I,
)


def _pick_submit_step(steps: list[dict]) -> tuple[int | None, dict]:
    """启发式挑出真正的提交步骤：文本/selector 命中，且取**最后一个**。"""
    candidates: list[dict] = []
    for idx, step in enumerate(steps):
        if not isinstance(step, dict) or step.get("type") not in ("click", "dispatch"):
            continue
        tgt = _target(step)
        text = str(tgt.get("text") or step.get("text") or "")
        selector = str(tgt.get("selector") or "")
        if text and SUBMIT_TEXT_RE.search(text) and not any(d in text for d in SUBMIT_TEXT_DENY):
            candidates.append({"index": idx, "why": f"target.text 命中 发布|提交: {text!r}"})
        elif selector and SUBMIT_SELECTOR_RE.search(selector):
            candidates.append({"index": idx, "why": f"target.selector 命中提交按钮模式: {selector!r}"})
    if not candidates:
        report = {
            "submitStepIndex": None,
            "reason": "未找到 submit 候选（无 target.text 命中 发布|提交，也无 selector 命中提交模式）；"
                      "请在 recipe 里手工给提交步骤加 submit: true",
            "candidates": [],
        }
        return None, report
    winner = candidates[-1]
    report = {
        "submitStepIndex": winner["index"],
        "reason": f"取最后一个候选（共 {len(candidates)} 个）：{winner['why']}",
        "candidates": candidates,
    }
    return winner["index"], report


# ---------------------------------------------------------------------------
# 平台元数据（内置 recipe）合并
# ---------------------------------------------------------------------------
_CANON_CACHE: dict[str, dict] = {}


def _load_canonical(media: str | None) -> dict | None:
    """读取平台内置 recipe（用户目录优先），用于继承 capabilities/session_check/verify。"""
    if not media:
        return None
    if media in _CANON_CACHE:
        return _CANON_CACHE[media]
    rid = f"{media}__publish-article"
    recipe: dict | None = None
    cs = _lazy("config_store")
    if cs is not None and hasattr(cs, "load_recipe"):
        try:
            recipe, _path = cs.load_recipe(rid)
        except Exception:
            recipe = None
    if not recipe:
        candidates: list[Path] = []
        paths = _lazy("paths")
        base = getattr(paths, "BUILTIN_RECIPES_DIR", None) if paths is not None else None
        if base:
            candidates.append(Path(base) / f"{rid}.yaml")
        # 兜底：本模块同级的 recipes/ 就是内置 recipe 的规范位置（paths 未就绪时也能读到）
        candidates.append(Path(__file__).resolve().parent / "recipes" / f"{rid}.yaml")
        for candidate in candidates:
            if not candidate.exists():
                continue
            try:
                import yaml  # 唯一第三方依赖，pyyaml 已在环境中
                recipe = yaml.safe_load(candidate.read_text(encoding="utf-8"))
                if recipe:
                    break
            except Exception as exc:
                _stderr(f"读取内置 recipe 失败 {candidate}: {exc}")
    if recipe:
        _CANON_CACHE[media] = recipe
        return recipe
    return None


def _merge_params(canonical_params: Any, inferred: list[dict], caller: Any, recipe_refs: set[str]) -> list[dict]:
    """参数合并：caller > inferred > canonical（逐字段 canonical 只补缺）。"""
    canon_by_name: dict[str, dict] = {}
    if isinstance(canonical_params, list):
        for p in canonical_params:
            if isinstance(p, dict) and p.get("name"):
                canon_by_name[str(p["name"])] = p
    caller_by_name: dict[str, dict] = {}
    if isinstance(caller, list):
        for p in caller:
            if isinstance(p, dict) and p.get("name"):
                caller_by_name[str(p["name"])] = p

    names: list[str] = []
    for p in inferred:
        if p["name"] not in names:
            names.append(p["name"])
    for name in caller_by_name:
        if name not in names:
            names.append(name)
    for name in canon_by_name:
        if name in recipe_refs and name not in names:
            names.append(name)

    out: list[dict] = []
    for name in names:
        merged = dict(canon_by_name.get(name) or {})
        inf = next((p for p in inferred if p["name"] == name), None)
        if inf:
            canon_values = None
            if (
                inf.get("type") == "enum"
                and merged.get("values")
                and inf.get("default") in merged.get("values", [])
            ):
                # 枚举：内置 recipe 的候选值集合更完整，替换后把它还原回来
                canon_values = list(merged["values"])
            merged.update(inf)
            if canon_values:
                merged["values"] = canon_values
        merged.update(caller_by_name.get(name) or {})
        merged["name"] = name
        ordered = {"name": merged.pop("name")}
        for key in ("type", "required", "values", "default", "max_len", "min_len", "description"):
            if key in merged:
                ordered[key] = merged.pop(key)
        ordered.update(merged)
        out.append(ordered)
    return out


def _template_names(value: Any) -> set[str]:
    names: set[str] = set()
    if isinstance(value, str):
        for m in re.finditer(r"\{\{\s*([^{}]+?)\s*\}\}", value):
            raw = m.group(1).strip()
            if raw.startswith("env:"):
                continue
            names.add(raw)
    elif isinstance(value, dict):
        for v in value.values():
            names |= _template_names(v)
    elif isinstance(value, list):
        for v in value:
            names |= _template_names(v)
    return names


# ---------------------------------------------------------------------------
# compile_recipe
# ---------------------------------------------------------------------------
def compile_recipe(
    session: Any,
    *,
    recipe_id: str | None = None,
    media: str | None = None,
    label: str | None = None,
    params: list | None = None,
    session_check: dict | None = None,
    verify: dict | None = None,
    account_codes: list | None = None,
    capabilities: dict | None = None,
    report: dict | None = None,
) -> dict:
    """把 session.trace 编译成 SPEC §3 的 recipe（键顺序即 SPEC 顺序）。"""
    meta = _meta(session)
    trace = getattr(session, "trace", None) or []
    steps = recipe_steps(trace)
    diag = trace_diagnostics(trace)
    gap = dispatcher_gap(diag)
    if gap:
        _stderr(f"警告（录制链路阻塞）：{gap}")

    rid = (recipe_id or meta.get("recipe_id") or "").strip()
    if not rid:
        _action_error("BAD_REQUEST", "compile_recipe 无法确定 recipe_id（未 record.start 且未传入）")
    med = (media or meta.get("media") or rid.split("__")[0] or "unknown").strip()
    canonical = _load_canonical(med)

    infer_report: dict = {}
    inferred = infer_params(steps, report=infer_report)

    submit_index, submit_report = _pick_submit_step(steps)
    if submit_index is not None:
        steps[submit_index]["submit"] = True

    # canonical 里未被录制覆盖但被模板引用的参数（例如 declaration）
    refs = _template_names(steps) | _template_names(verify) | _template_names(session_check)
    final_params = _merge_params(
        (canonical or {}).get("params"), inferred, params, refs
    )

    acct = account_codes or (canonical or {}).get("account_codes")
    if not acct:
        sess_code = getattr(session, "code", None)
        acct = [sess_code] if sess_code else []

    caps = capabilities if capabilities is not None else (canonical or {}).get("capabilities") or {}
    sc = session_check if session_check is not None else (canonical or {}).get("session_check") or {
        "url": "", "fail_if_url_contains": [], "fail_if_text_contains": [],
    }
    vf = verify if verify is not None else (canonical or {}).get("verify") or {
        "mode": "none", "list_url": None, "title_match": "exact_normalized",
        "status_regex": None, "accept_link_contains": [], "final_url_template": None,
    }

    recipe: dict[str, Any] = {
        "recipe_version": 1,
        "id": rid,
        "media": med,
        "label": label or (canonical or {}).get("label") or f"{med} 发布",
        "account_codes": list(acct),
        "capabilities": copy.deepcopy(caps),
        "session_check": copy.deepcopy(sc),
        "params": copy.deepcopy(final_params),
        "steps": steps,
        "verify": copy.deepcopy(vf),
        "overrides": {},
    }

    # 校验（RECIPE_INVALID 只报告，不阻断落盘：录制流程可能需要人工修一次）
    validation = {"ok": None, "issues": []}
    play = _lazy("play")
    if play is not None and hasattr(play, "validate_sync"):
        try:
            validation = play.validate_sync(recipe)
        except Exception as exc:  # pragma: no cover
            validation = {"ok": None, "issues": [], "error": str(exc)}

    if report is not None:
        report.clear()
        report.update({
            "generatedAt": _now(),
            "recipeId": rid,
            "media": med,
            "stepCount": len(steps),
            "canonicalSource": f"{med}__publish-article(yaml)" if canonical else None,
            "canonicalMerged": bool(canonical),
            "traceDiagnostics": diag,
            "blockers": [gap] if gap else [],
            "inferParams": infer_report,
            "submitStep": submit_report,
            "paramsMerge": {
                "inferred": [p["name"] for p in inferred],
                "caller": [p.get("name") for p in (params or []) if isinstance(p, dict)],
                "final": [p["name"] for p in final_params],
            },
            "stepsWithNotes": [
                {"index": i, "type": s.get("type"), "note": s.get("note")}
                for i, s in enumerate(steps) if isinstance(s, dict) and s.get("note")
            ],
            "validation": validation,
        })

    _stderr(
        f"compile_recipe id={rid} media={med} steps={len(steps)} params={[p['name'] for p in final_params]} "
        f"submit={submit_index}"
    )
    return recipe


def save(session: Any, overwrite: bool = False, **kwargs: Any) -> dict:
    """编译并落盘；同时写 <id>.compile-report.json 供人工审计。"""
    paths = _require("paths")
    cs = _require("config_store")

    report: dict = {}
    recipe = compile_recipe(session, report=report, **kwargs)
    rid = recipe["id"]
    med = recipe["media"]

    recipes_dir = getattr(paths, "RECIPES_DIR", None)
    expected = None
    if recipes_dir is not None:
        expected = Path(recipes_dir) / str(med) / f"{rid}.yaml"
        if expected.exists() and not overwrite:
            _action_error(
                "BAD_REQUEST",
                f"用户 recipe 已存在，拒绝静默覆盖：{expected}（需要 overwrite=true）",
                {"recipePath": str(expected), "overwriteRequired": True},
            )

    if not recipe["steps"]:
        gap = dispatcher_gap(report.get("traceDiagnostics") or {})
        _action_error("BAD_REQUEST",
                      "trace 中没有可编译的步骤（record.start 后未执行任何 act.*？）"
                      + (f" 诊断：{gap}" if gap else ""),
                      {"traceDiagnostics": report.get("traceDiagnostics")})

    try:
        path = Path(cs.save_recipe(recipe, recipe_id=rid))
    except TypeError:  # 兼容只接受 recipe 的实现
        path = Path(cs.save_recipe(recipe))

    report_path = path.with_suffix(".compile-report.json")
    try:
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:  # pragma: no cover
        _stderr(f"写 compile-report 失败：{exc}")

    _append_trace_line(session, {
        "kind": "record.save", "recipeId": rid, "recipePath": str(path),
        "stepCount": len(recipe["steps"]), "compileReport": str(report_path), "at": _now(),
    })
    session.recording = False
    _stderr(f"record.save -> {path} ({len(recipe['steps'])} steps)")
    return {"recipePath": str(path), "stepCount": len(recipe["steps"])}


__all__ = [
    "start", "status", "note", "undo", "compile_recipe", "save", "infer_params",
    "summarize_step", "is_recipe_step", "recipe_steps", "normalize_step_entry",
    "trace_diagnostics", "dispatcher_gap", "RECIPE_STEP_TYPES",
    "_pick_submit_step", "_load_canonical",
]

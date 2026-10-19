"""play.py — recipe 校验、回放（含自愈）与审核后回查。

契约见 docs/SPEC.md §3（recipe）与 §6（play.py 签名）。

设计要点
--------
* 与浏览器相关的一切都在**函数内部**惰性导入兄弟模块，因此本模块在兄弟模块尚未就绪时
  依然可导入，`validate_sync` / `choose_heal_candidate` / `normalize_title` 等纯函数依然可单测。
* 执行动作**只经 `actions.execute`**，本模块不自己实现 act.* 语义。
* 绝不向 stdout 打印；日志走 stderr 与 run_dir/stdout.log。
"""

from __future__ import annotations

import asyncio
import copy
import difflib
import inspect
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

for _stream in (sys.stdout, sys.stderr):
    try:  # pragma: no cover
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass


def _stderr(msg: str) -> None:
    """只写 stderr（SPEC §2 协议纪律：stdout 只允许协议帧）。"""
    try:
        sys.stderr.write(f"[play] {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 分发表：recipe 的 step.type ↔ RPC act.* 方法名（SPEC §2.1 / §3）
# ---------------------------------------------------------------------------
SUPPORTED_STEP_TYPES: tuple[str, ...] = (
    "goto", "click", "dispatch", "type", "press", "upload", "select",
    "check", "scroll", "waitFor", "frame", "eval", "extract",
    # actions.ACTION_TYPES 里额外的可用步骤（同一张分发表）
    "screenshot", "snapshot", "sleep",
)

PARAM_TYPES = ("string", "text", "int", "number", "bool", "enum", "image_ref")

_DEFAULT_STEP_TIMEOUT_S = 60.0
_STEP_TIMEOUT_SLACK_S = 15.0

#: 自愈判定阈值
MIN_HEAL_SCORE = 0.62
HEAL_MARGIN = 0.15

_PENDING_STATUS_RE = re.compile(r"审核中|待审核|审核|pending", re.I)
_REJECT_STATUS_RE = re.compile(r"未通过|驳回|拒绝|reject|fail", re.I)
_TEMPLATE_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


# ---------------------------------------------------------------------------
# 惰性导入（与 record.py 同一策略）
# ---------------------------------------------------------------------------
_MOD_CACHE: dict[str, Any] = {}


def _lazy(name: str) -> Any:
    if name in _MOD_CACHE:
        return _MOD_CACHE[name]
    import importlib
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
            if missing == cand or cand.startswith(missing + ".") or missing.startswith(cand + "."):
                continue
            raise
    _MOD_CACHE[name] = found
    return found


def _require(name: str) -> Any:
    mod = _lazy(name)
    if mod is None:
        _raise("INTERNAL", f"engine.{name} 不可用（兄弟模块尚未就绪）")
    return mod


def _action_error_cls() -> type:
    actions = _lazy("actions")
    if actions is not None and hasattr(actions, "ActionError"):
        return actions.ActionError  # type: ignore[return-value]
    return RuntimeError


def _raise(code: str, message: str, details: dict | None = None) -> None:
    raise _action_error_cls()(code, message, details or {})


# ---------------------------------------------------------------------------
# 纯工具
# ---------------------------------------------------------------------------
def iter_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from iter_strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from iter_strings(v)


def template_names(value: Any) -> set[str]:
    """收集 `{{param}}` 名字（`{{env:...}}` 不算参数）。"""
    names: set[str] = set()
    for s in iter_strings(value):
        for m in _TEMPLATE_RE.finditer(s):
            raw = m.group(1).strip()
            if raw.lower().startswith("env:"):
                continue
            names.add(raw)
    return names


def render_templates(value: Any, params: dict | None = None, *, env: bool = True) -> Any:
    """递归替换 `{{name}}` / `{{env:NAME}}`；未声明的模板原样保留。"""
    params = params or {}

    def sub_str(text: str) -> Any:
        whole = _TEMPLATE_RE.fullmatch(text)
        if whole is not None:
            raw = whole.group(1).strip()
            if raw.lower().startswith("env:"):
                return os.environ.get(raw.split(":", 1)[1].strip(), "") if env else text
            if raw in params:
                return params[raw]
            return text
        def repl(m: re.Match[str]) -> str:
            raw = m.group(1).strip()
            if raw.lower().startswith("env:"):
                return str(os.environ.get(raw.split(":", 1)[1].strip(), "")) if env else m.group(0)
            if raw in params:
                return str(params[raw])
            return m.group(0)
        return _TEMPLATE_RE.sub(repl, text)

    if isinstance(value, str):
        return sub_str(value)
    if isinstance(value, dict):
        return {k: render_templates(v, params, env=env) for k, v in value.items()}
    if isinstance(value, list):
        return [render_templates(v, params, env=env) for v in value]
    return value


def normalize_text(text: Any) -> str:
    """宽松归一：NFKC + 空白折叠 + 大小写不敏感。用于自愈文本比对。"""
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s.casefold()


def normalize_title(text: Any) -> str:
    """严格归一：NFKC + 去空白 + 去标点/全角变体。用于回查标题比对。"""
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = s.casefold()
    s = re.sub(r"[\s\u00a0\u3000]+", "", s)
    s = s.replace("_", "")
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "", s)
    return s


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------
REQUIRED_RECIPE_KEYS = ("recipe_version", "id", "media", "steps")
EXPECTED_RECIPE_KEYS = (
    "recipe_version", "id", "media", "label", "account_codes", "capabilities",
    "session_check", "params", "steps", "verify", "overrides",
)


def _param_index(recipe: dict) -> tuple[dict[str, dict], list[dict]]:
    declared = recipe.get("params")
    issues: list[dict] = []
    by_name: dict[str, dict] = {}
    if declared is None:
        return by_name, issues
    if not isinstance(declared, list):
        issues.append({
            "level": "error", "code": "PARAMS_NOT_LIST",
            "message": f"params 必须是列表，实际为 {type(declared).__name__}",
        })
        return by_name, issues
    for i, p in enumerate(declared):
        if not isinstance(p, dict) or not p.get("name"):
            issues.append({
                "level": "error", "code": "PARAM_DECL_INVALID",
                "message": f"params[{i}] 缺少 name", "stepIndex": None,
            })
            continue
        name = str(p["name"])
        if name in by_name:
            issues.append({
                "level": "warning", "code": "PARAM_DUPLICATE",
                "message": f"参数 {name} 重复声明", "stepIndex": None,
            })
        by_name[name] = p
    return by_name, issues


def validate_sync(recipe: Any, *, require_submit: bool = True) -> dict:
    """纯函数校验；返回 {"ok", "issues":[{"level","code","message","stepIndex"?}]}。"""
    issues: list[dict] = []
    if not isinstance(recipe, dict):
        return {"ok": False, "issues": [{
            "level": "error", "code": "RECIPE_NOT_OBJECT",
            "message": f"recipe 必须是对象，实际为 {type(recipe).__name__}",
        }]}

    rv = recipe.get("recipe_version")
    if rv is None:
        issues.append({"level": "error", "code": "RECIPE_VERSION_MISSING",
                       "message": "缺少 recipe_version"})
    elif rv != 1:
        issues.append({"level": "error", "code": "RECIPE_VERSION_UNSUPPORTED",
                       "message": f"recipe_version={rv!r} 不受支持（本引擎只支持 1）"})

    for key in REQUIRED_RECIPE_KEYS:
        if key == "recipe_version":
            continue
        if key not in recipe or recipe.get(key) in (None, ""):
            issues.append({"level": "error", "code": "RECIPE_KEY_MISSING",
                           "message": f"缺少必需键 {key}"})
    for key in EXPECTED_RECIPE_KEYS:
        if key not in recipe:
            issues.append({"level": "warning", "code": "RECIPE_KEY_ABSENT",
                           "message": f"缺少可选键 {key}（SPEC §3 建议补齐）"})

    steps = recipe.get("steps")
    if steps is None:
        steps = []
    elif not isinstance(steps, list):
        issues.append({"level": "error", "code": "STEPS_NOT_LIST",
                       "message": f"steps 必须是列表，实际为 {type(steps).__name__}"})
        steps = []
    if isinstance(steps, list) and not steps:
        issues.append({"level": "warning", "code": "STEPS_EMPTY", "message": "steps 为空"})

    submit_count = 0
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            issues.append({"level": "error", "code": "STEP_NOT_OBJECT",
                           "message": f"steps[{i}] 不是对象", "stepIndex": i})
            continue
        stype = step.get("type")
        if not stype:
            issues.append({"level": "error", "code": "STEP_TYPE_MISSING",
                           "message": f"steps[{i}] 缺少 type", "stepIndex": i})
        elif stype not in SUPPORTED_STEP_TYPES:
            issues.append({
                "level": "error", "code": "STEP_TYPE_UNSUPPORTED",
                "message": f"steps[{i}] 的 type={stype!r} 不在分发表 {list(SUPPORTED_STEP_TYPES)} 中",
                "stepIndex": i,
            })
        if step.get("submit"):
            submit_count += 1
        if stype == "eval" and not step.get("purpose"):
            issues.append({
                "level": "warning", "code": "EVAL_WITHOUT_PURPOSE",
                "message": f"steps[{i}] 是逃生舱 eval，但未写 purpose 说明原因",
                "stepIndex": i,
            })
        if stype == "goto" and not step.get("url"):
            issues.append({"level": "error", "code": "GOTO_WITHOUT_URL",
                           "message": f"steps[{i}] goto 缺少 url", "stepIndex": i})

    declared, param_issues = _param_index(recipe)
    issues.extend(param_issues)

    refs = template_names({k: v for k, v in recipe.items() if k != "params"})
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        for name in sorted(template_names(step)):
            if name not in declared:
                issues.append({
                    "level": "error", "code": "PARAM_UNDECLARED",
                    "message": f"steps[{i}] 引用了未声明的参数 {{{{{name}}}}}",
                    "stepIndex": i,
                })
    for name, p in declared.items():
        if p.get("required") and name not in refs:
            # 必填参数却无处投递 = 调用方必须提供但配方永远不会用到它
            issues.append({
                "level": "error", "code": "PARAM_REQUIRED_UNUSED",
                "message": f"必填参数 {name} 未被任何步骤/verify/session_check 引用（必填值无处投递）",
                "stepIndex": None,
            })
        elif name not in refs:
            issues.append({
                "level": "warning", "code": "PARAM_UNUSED",
                "message": f"参数 {name} 未被 recipe 引用（有默认值则无害）", "stepIndex": None,
            })
        ptype = p.get("type")
        if ptype is not None and ptype not in PARAM_TYPES:
            issues.append({
                "level": "warning", "code": "PARAM_TYPE_UNKNOWN",
                "message": f"参数 {name} 的 type={ptype!r} 不是已知类型 {list(PARAM_TYPES)}",
            })
        if ptype == "enum":
            values = p.get("values")
            if not values:
                issues.append({"level": "error", "code": "ENUM_WITHOUT_VALUES",
                               "message": f"枚举参数 {name} 缺少 values"})
            elif "default" in p and p["default"] not in values:
                issues.append({
                    "level": "warning", "code": "ENUM_DEFAULT_NOT_IN_VALUES",
                    "message": f"参数 {name} 的 default={p['default']!r} 不在 values 中",
                })

    if require_submit and submit_count == 0:
        issues.append({
            "level": "error", "code": "SUBMIT_STEP_MISSING",
            "message": "没有任何步骤标记 submit: true（dryRun=false 时无法提交）",
        })
    if submit_count > 1:
        issues.append({
            "level": "warning", "code": "SUBMIT_STEP_MULTIPLE",
            "message": f"有 {submit_count} 个步骤标记 submit: true，dryRun 会全部跳过",
        })

    if not recipe.get("verify"):
        issues.append({"level": "warning", "code": "VERIFY_MISSING",
                       "message": "缺少 verify 块，审核后回查将不可用"})
    if not recipe.get("session_check"):
        issues.append({"level": "warning", "code": "SESSION_CHECK_MISSING",
                       "message": "缺少 session_check，回放前无法快速判定登录态"})
    if not recipe.get("capabilities"):
        issues.append({"level": "warning", "code": "CAPABILITIES_MISSING",
                       "message": "缺少 capabilities（编辑器/图库/封面等能力声明）"})

    ok = not any(i["level"] == "error" for i in issues)
    return {"ok": ok, "issues": issues}


async def validate(recipe: Any) -> dict:
    """SPEC §6 的 async 入口；与 validate_sync 同语义（纯逻辑，无 I/O）。"""
    return validate_sync(recipe)


# ---------------------------------------------------------------------------
# 自愈：唯一高置信候选选择器（纯函数，单测覆盖）
# ---------------------------------------------------------------------------
_SEL_TOKEN_RE = re.compile(r"[#.]?[A-Za-z_][-\w]*|\d+")


def _sel_tokens(selector: str) -> set[str]:
    toks = {t for t in _SEL_TOKEN_RE.findall(str(selector or "")) if t}
    return {t for t in toks if t not in ("*",)}


def _dedupe_candidates(candidates: Any) -> list[dict]:
    """去重：同 (selector,text,box) 视为同一元素；缺 box 的副本被有 box 的取代。"""
    seen: dict[tuple, dict] = {}
    order: list[tuple] = []
    for cand in candidates or []:
        if not isinstance(cand, dict):
            continue
        csel = str(cand.get("selector") or "").strip()
        ctext = normalize_text(cand.get("text"))
        box = cand.get("box")
        box_key = tuple(box) if isinstance(box, (list, tuple)) and len(box) == 4 else None
        key = (csel, ctext, box_key)
        if key not in seen:
            seen[key] = cand
            order.append(key)
    groups: dict[tuple, list[tuple]] = {}
    for key in order:
        groups.setdefault((key[0], key[1]), []).append(key)
    drop: set[tuple] = set()
    for keys in groups.values():
        if len(keys) > 1 and any(k[2] is not None for k in keys):
            drop.update(k for k in keys if k[2] is None)
    return [seen[k] for k in order if k not in drop]


def _locator_for(candidate: dict) -> tuple[dict | None, str | None]:
    csel = str(candidate.get("selector") or "").strip()
    if csel:
        return {"selector": csel}, "selector"
    ctext = str(candidate.get("text") or "").strip()
    if ctext:
        loc: dict[str, Any] = {"text": ctext, "exact": True}
        role = str(candidate.get("role") or "").strip()
        if role:
            loc["role"] = role
        return loc, "text"
    return None, None


def _score_candidate(candidate: Any, target: dict) -> tuple[float, list[str]] | None:
    if not isinstance(candidate, dict):
        return None
    if candidate.get("visible") is False:
        return None
    ctext = normalize_text(candidate.get("text"))
    csel = str(candidate.get("selector") or "").strip()
    if not (csel or ctext or candidate.get("ref")):
        return None

    ttext = normalize_text(target.get("text"))
    tsel = str(target.get("selector") or "").strip()
    trole = str(target.get("role") or "").strip().lower()
    score = 0.0
    matched: list[str] = []

    if ttext and ctext:
        if ctext == ttext:
            score = max(score, 1.0)
            matched.append("text-exact")
        elif ttext in ctext or ctext in ttext:
            ratio = min(len(ctext), len(ttext)) / max(len(ctext), len(ttext), 1)
            score = max(score, 0.55 + 0.35 * ratio)
            matched.append(f"text-contains({ratio:.2f})")
        else:
            sim = difflib.SequenceMatcher(None, ctext, ttext).ratio()
            if sim >= 0.6:
                score = max(score, 0.40 + 0.30 * sim)
                matched.append(f"text-similar({sim:.2f})")

    if tsel and csel:
        if tsel == csel:
            score = max(score, 1.0)
            matched.append("selector-exact")
        else:
            a, b = _sel_tokens(tsel), _sel_tokens(csel)
            if a and b:
                jac = len(a & b) / len(a | b)
                if jac > 0:
                    score = max(score, 0.50 + 0.50 * jac)
                    matched.append(f"selector-jaccard({jac:.2f})")

    if trole and str(candidate.get("role") or "").strip().lower() == trole:
        score += 0.05
        matched.append("role")

    if not matched:
        return None
    return min(score, 1.0), matched


def choose_heal_candidate(
    candidates: Any,
    *,
    target: dict | None = None,
    min_score: float = MIN_HEAL_SCORE,
    margin: float = HEAL_MARGIN,
) -> dict:
    """从候选元素中挑出**唯一**高置信目标用于自愈。

    返回 {"ok","ambiguous","reason","score","candidate","locator","locatorKind","ranked",...}
    ok=False 时绝不猜测：要么分数不够，要么存在分数接近的竞争者（歧义）。
    """
    target = target if isinstance(target, dict) else {}
    uniq = _dedupe_candidates(candidates)
    ranked: list[dict] = []
    for cand in uniq:
        scored = _score_candidate(cand, target)
        if scored is None:
            continue
        score, matched = scored
        locator, kind = _locator_for(cand)
        if locator is None:
            continue
        ranked.append({
            "score": round(score, 4), "matchedOn": matched,
            "candidate": cand, "locator": locator, "locatorKind": kind,
        })
    ranked.sort(key=lambda r: r["score"], reverse=True)
    base = {"ranked": ranked[:8], "considered": len(uniq), "scored": len(ranked)}

    if not ranked:
        return {**base, "ok": False, "ambiguous": False, "score": 0.0, "matchedOn": [],
                "candidate": None, "locator": None, "locatorKind": None,
                "reason": "没有可用候选（缺 selector/text，或全部不可见）"}
    best = ranked[0]
    if best["score"] < min_score:
        return {**base, "ok": False, "ambiguous": False, "score": best["score"],
                "matchedOn": best["matchedOn"],
                "candidate": best["candidate"], "locator": None, "locatorKind": None,
                "reason": f"最高候选分 {best['score']:.2f} < 阈值 {min_score:.2f}，拒绝自愈"}
    if len(ranked) > 1 and (best["score"] - ranked[1]["score"]) < margin:
        return {**base, "ok": False, "ambiguous": True, "score": best["score"],
                "matchedOn": best["matchedOn"],
                "candidate": best["candidate"], "locator": None, "locatorKind": None,
                "runnerUp": ranked[1],
                "reason": (f"候选不唯一（{best['score']:.2f} vs {ranked[1]['score']:.2f}，"
                           f"差值 < {margin:.2f}），按契约拒绝猜测")}
    return {**base, "ok": True, "ambiguous": False, "score": best["score"],
            "matchedOn": best["matchedOn"],
            "candidate": best["candidate"], "locator": best["locator"],
            "locatorKind": best["locatorKind"],
            "reason": "唯一高置信候选：" + ",".join(best["matchedOn"])}


def _apply_overrides(step: dict, index: int, overrides: dict | None) -> None:
    """应用 `"<stepIndex>.<dotted.path>": value` 覆盖；value 为 None 表示删除该键。"""
    for key, value in (overrides or {}).items():
        m = re.match(r"^(\d+)\.(.+)$", str(key))
        if not m or int(m.group(1)) != index:
            continue
        path = m.group(2).split(".")
        node: Any = step
        ok = True
        for part in path[:-1]:
            if not isinstance(node.get(part), dict):
                if value is None:
                    ok = False
                    break
                node[part] = {}
            node = node[part]
        if not ok:
            continue
        if value is None:
            node.pop(path[-1], None)
        else:
            node[path[-1]] = value


def _override_plan(index: int, step: dict, locator: dict, kind: str) -> dict:
    """自愈后写进 recipe.overrides 的键值计划。

    必须把「学到的定位器」完整写成覆盖项：旧 target 里优先级更高或会冲突的键
    （selector 优先于 text；nth/within 会改变匹配范围）都要显式清掉，
    否则下次回放看起来有 overrides、实际却还是按旧 key 定位。
    """
    tgt = step.get("target") if isinstance(step.get("target"), dict) else {}
    plan: dict[str, Any] = {}
    if kind == "selector":
        for stale in ("text", "role", "nth", "exact", "within"):
            if stale in tgt:
                plan[f"{index}.target.{stale}"] = None
        plan[f"{index}.target.selector"] = locator["selector"]
        return plan

    # 文本定位（selector 优先级更高，必须显式清掉）
    plan[f"{index}.target.selector"] = None
    for stale in ("nth", "within"):
        if stale in tgt:
            plan[f"{index}.target.{stale}"] = None
    plan[f"{index}.target.text"] = locator["text"]
    if "role" in locator:
        plan[f"{index}.target.role"] = locator["role"]
    elif "role" in tgt:
        plan[f"{index}.target.role"] = None
    if "exact" in locator:
        plan[f"{index}.target.exact"] = bool(locator["exact"])
    elif "exact" in tgt:
        plan[f"{index}.target.exact"] = None
    return plan


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def extract_named_value(data: Any, name: str) -> Any:
    """从 extract 步骤的 data 里取某个输出名。

    `actions._act_extract` 的规范形状是 ``{"values": {name: value}}``；同时兼容
    直接把 name 放在顶层的实现，避免形状漂移导致线索丢失。
    """
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("values"), dict) and data["values"].get(name) not in (None, ""):
        return data["values"][name]
    return data.get(name) or None


def resolve_param_values(recipe: dict, params: dict | None) -> dict:
    """应用默认值并校验必填；缺必填抛 PARAM_MISSING。"""
    provided = dict(params or {})
    declared = recipe.get("params") or []
    values: dict[str, Any] = {}
    missing: list[str] = []
    if isinstance(declared, list):
        for p in declared:
            if not isinstance(p, dict) or not p.get("name"):
                continue
            name = str(p["name"])
            if name in provided:
                values[name] = provided[name]
            elif "default" in p:
                values[name] = p["default"]
            elif p.get("required"):
                missing.append(name)
    for name, value in provided.items():
        values.setdefault(name, value)
    if missing:
        _raise("PARAM_MISSING", f"缺少必填参数：{', '.join(missing)}", {"missing": missing})
    return values


def _check_param_values(recipe: dict, values: dict) -> list[str]:
    warnings: list[str] = []
    declared = recipe.get("params") or []
    if not isinstance(declared, list):
        return warnings
    for p in declared:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        name = str(p["name"])
        if name not in values:
            continue
        value = values[name]
        if p.get("type") == "enum" and p.get("values") and value not in p["values"]:
            warnings.append(f"参数 {name}={value!r} 不在枚举候选 {p['values']} 中")
        if isinstance(value, str):
            if p.get("max_len") and len(value) > int(p["max_len"]):
                warnings.append(f"参数 {name} 长度 {len(value)} 超过平台上限 max_len={p['max_len']}")
            if p.get("min_len") and len(value) < int(p["min_len"]):
                warnings.append(f"参数 {name} 长度 {len(value)} 低于 min_len={p['min_len']}")
    return warnings


async def _emit_progress(on_progress: Callable | None, index: int, stype: str, status: str) -> None:
    if on_progress is None:
        return
    try:
        result = on_progress(index, stype, status)
        if inspect.isawaitable(result):
            await result
    except Exception as exc:  # 进度回调不得影响回放
        _stderr(f"on_progress 回调异常（已忽略）：{exc}")


async def _resolve_value(value: Any, params: dict, act: Any) -> Any:
    if act is not None and hasattr(act, "resolve_params"):
        try:
            return act.resolve_params(value, params)
        except Exception as exc:
            _stderr(f"actions.resolve_params 失败，回退内置渲染：{exc}")
    return render_templates(value, params)


async def _exec_step(session: Any, step: dict, act: Any) -> dict:
    """经 actions.execute 执行一步；对 timeoutMs 加一层兜底硬超时。"""
    coro = act.execute(session, step, dry_run=False)
    tmo = step.get("timeoutMs")
    try:
        budget = (float(tmo) / 1000.0 if tmo else _DEFAULT_STEP_TIMEOUT_S) + _STEP_TIMEOUT_SLACK_S
    except Exception:
        budget = _DEFAULT_STEP_TIMEOUT_S + _STEP_TIMEOUT_SLACK_S
    try:
        return await asyncio.wait_for(coro, timeout=max(5.0, budget))
    except (asyncio.TimeoutError, TimeoutError) as exc:
        _raise("TIMEOUT", f"步骤执行超过硬超时 {budget:.0f}s：{step.get('type')}",
               {"type": step.get("type"), "budgetSeconds": budget})  # raises
        raise AssertionError from exc  # pragma: no cover


async def _screenshot(session: Any, shots_dir: Path, label: str, artifacts: dict, warnings: list[str]) -> str | None:
    """截图证据必须落在本次 run 目录。

    `observe.screenshot` 见到 `session.run_dir` 就会写进 `<run_dir>/shots/`，因此优先走它；
    它不可用/失败才退回直接 page.screenshot，并把原因记进 warnings。
    """
    obs = _lazy("observe")
    if obs is not None and hasattr(obs, "screenshot"):
        try:
            res = await obs.screenshot(session, label=label)
            path = res.get("path") if isinstance(res, dict) else None
            if path:
                artifacts.setdefault("screenshots", []).append(str(path))
                return str(path)
            warnings.append(f"observe.screenshot 未返回路径（{label}）")
        except Exception as exc:
            warnings.append(f"observe.screenshot 失败（{label}），改用 page.screenshot：{exc}")
    try:
        shots_dir.mkdir(parents=True, exist_ok=True)
        path = shots_dir / f"{re.sub(r'[^A-Za-z0-9_.-]+', '-', label)}.png"
        await session.page.screenshot(path=str(path))
        artifacts.setdefault("screenshots", []).append(str(path))
        return str(path)
    except Exception as exc:
        warnings.append(f"截图失败（{label}）：{exc}")
        return None


def _resolve_proxy(config_store: Any, proxy_pool: Any, code: str,
                   policy: str) -> tuple[dict | None, list[str]]:
    """与 ``sessiond._resolve_proxy`` 同语义地取该账号的代理，返回 (proxy|None, warnings)。

    契约（SPEC §4.2）：
    * ``policy='direct'`` → 直连，无告警；
    * 既没有可用提取器、也没有绑定代理 → **直连 + 明确告警**（未配置代理不是错误）；
    * 配置了代理但拿不到 → 抛 ``PROXY_UNAVAILABLE``，绝不伪装成登录态失效。
    """
    warnings: list[str] = []
    if policy == "direct":
        return None, warnings
    if proxy_pool is None or not hasattr(proxy_pool, "get_for_account"):
        warnings.append("engine.proxy_pool 不可用 → 本次直连")
        return None, warnings
    try:
        cfg = config_store.load_proxies() if hasattr(config_store, "load_proxies") else {}
        bound = (config_store.load_account_proxy(code)
                 if hasattr(config_store, "load_account_proxy") else None)
    except Exception as exc:
        warnings.append(f"读取代理配置失败，改为直连：{exc}")
        return None, warnings
    usable = (proxy_pool.extractor_candidates(cfg)
              if hasattr(proxy_pool, "extractor_candidates") else [])
    if not usable and not bound:
        warnings.append("未绑定代理，且 proxies.yaml 没有可用提取器"
                        "（extractors.apipool.url 为空 / static 为空）→ 本次直连")
        return None, warnings
    try:
        proxy = proxy_pool.get_for_account(code, policy)
    except Exception as exc:
        exc_cls = getattr(proxy_pool, "ProxyUnavailable", None)
        if exc_cls is not None and isinstance(exc, exc_cls):
            # 代理确实配置了却拿不到：必须显式失败（且与登录态失效区分开）
            _raise("PROXY_UNAVAILABLE", f"代理不可用（这不是登录态失效）：{exc}",
                   {"code": code, "policy": policy,
                    "details": getattr(exc, "details", None)})
        warnings.append(f"代理获取异常，改为直连：{exc}")
        return None, warnings
    if proxy is None:
        warnings.append("未绑定代理 → 直连（建议 account.bindProxy 绑定独立 IP）")
    return proxy, warnings


async def _session_check(session: Any, recipe: dict, values: dict, act: Any) -> dict:
    """回放前先确认登录态，避免把文章敲进登录页。"""
    sc = recipe.get("session_check") or {}
    checks = sc if isinstance(sc, list) else [sc]
    results: list[dict] = []
    for chk in checks:
        if not isinstance(chk, dict) or not chk.get("url"):
            results.append({"skipped": True, "reason": "session_check.url 为空"})
            continue
        url = render_templates(chk["url"], values)
        await act.execute(session, {"type": "goto", "url": url, "waitUntil": "domcontentloaded",
                                    "timeoutMs": 45000})
        page = session.page
        # 这些平台的登录跳转是**客户端**发生的：domcontentloaded 之后 SPA 才 push 到 /auth/page/login
        # 之类的位置。只取样一次会读到跳转前的瞬时状态，守卫于是形同虚设
        # （实测：搜狐/头条/CSDN 三个平台在未登录时 session_check 全部误判为通过）。
        # 因此先在 networkidle 上等一下让客户端跳转发生，再在 settle 窗口内反复取样，
        # 任一时刻命中标记即判定登录态失效；连续若干次取样都稳定且无命中才放行。
        settle_ms = int(chk.get("settleMs") or 9000)
        interval_ms = int(chk.get("sampleIntervalMs") or 700)
        stable_needed = 3
        try:
            await page.wait_for_load_state("networkidle", timeout=4000)
        except Exception:
            pass  # networkidle 只是加速手段，不是必要条件

        samples: list[dict] = []
        hits: list[str] = []
        stable = 0
        last_url = None
        deadline = time.monotonic() + settle_ms / 1000
        while True:
            current = page.url
            try:
                text = await page.evaluate(
                    "() => (document.body ? document.body.innerText : '').slice(0, 60000)")
            except Exception:
                text = ""
            try:
                title = await page.title()
            except Exception:
                title = ""
            sample_hits: list[str] = []
            for marker in chk.get("fail_if_url_contains") or []:
                if str(marker).lower() in str(current).lower():
                    sample_hits.append(f"url 含 {marker}")
            for marker in chk.get("fail_if_text_contains") or []:
                if marker and (str(marker) in (text or "") or str(marker) in (title or "")):
                    sample_hits.append(f"页面文本含 {marker}")
            for sel in chk.get("fail_if_selector") or []:
                try:
                    if await page.locator(sel).count():
                        sample_hits.append(f"存在 {sel}")
                except Exception as exc:
                    samples.append({"selectorProbeError": str(exc)})
            samples.append({"url": current, "title": title, "hits": sample_hits})
            if sample_hits:
                hits = sample_hits
                break
            stable = stable + 1 if current == last_url else 0
            last_url = current
            if stable >= stable_needed or time.monotonic() >= deadline:
                break
            await asyncio.sleep(interval_ms / 1000)

        results.append({"url": url, "finalUrl": page.url, "hits": hits,
                        "sampled": len(samples), "samples": samples[-4:]})
        if hits:
            _raise("LOGIN_REQUIRED",
                   f"账号 {getattr(session, 'code', '?')} 登录态失效：{'; '.join(hits)}",
                   {"sessionCheckUrl": url, "finalUrl": page.url, "markers": hits,
                    "checks": results})
    return {"ok": True, "checks": results}


async def run(
    recipe: dict,
    *,
    account_code: str,
    params: dict | None = None,
    dry_run: bool = False,
    headless: bool | None = None,
    stop_on_error: bool = True,
    heal: bool = True,
    proxy_policy: str = "sticky",
    on_progress: Callable | None = None,
) -> dict:
    paths = _require("paths")
    config_store = _require("config_store")
    browser_mod = _require("browser")
    act = _require("actions")

    issues = validate_sync(recipe, require_submit=not dry_run)
    errors = [i for i in issues["issues"] if i["level"] == "error"]
    if errors:
        _raise("RECIPE_INVALID", "; ".join(i["message"] for i in errors), {"issues": issues["issues"]})

    values = resolve_param_values(recipe, params)
    warnings: list[str] = _check_param_values(recipe, values)

    recipe_id = str(recipe.get("id") or "recipe")
    media = str(recipe.get("media") or "")

    # 1) run 目录先行：即使随后崩溃也留下证据
    try:
        run_dir = Path(paths.new_run_dir(recipe_id, account_code))
    except Exception as exc:
        _raise("INTERNAL", f"无法创建 run 目录：{exc}")
    shots_dir = run_dir / "shots"
    shots_dir.mkdir(parents=True, exist_ok=True)
    stdout_log = run_dir / "stdout.log"
    run_json = run_dir / "run.json"

    if headless is None:
        headless = bool((recipe.get("capabilities") or {}).get("headless", True))

    state: dict[str, Any] = {
        "recipeId": recipe_id,
        "media": media,
        "accountCode": account_code,
        "dryRun": bool(dry_run),
        "headless": bool(headless),
        "heal": bool(heal),
        "proxyPolicy": proxy_policy,
        "startedAt": _now(),
        "finishedAt": None,
        "ok": False,
        "publishedUrl": None,
        "failedStep": None,
        "stoppedBeforeSubmit": None,
        "message": None,
        "runDir": str(run_dir),
        "steps": [],
        "healing": {"applied": [], "refused": []},
        "sessionCheck": None,
        "warnings": warnings,
    }

    def _sync() -> None:
        try:
            run_json.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as exc:  # pragma: no cover
            _stderr(f"写 run.json 失败：{exc}")

    def _log(line: str) -> None:
        try:
            with stdout_log.open("a", encoding="utf-8") as fh:
                fh.write(f"[{_now()}] {line}\n")
        except Exception:
            pass

    _sync()
    _log(f"play.run recipe={recipe_id} account={account_code} dryRun={dry_run} headless={headless}")

    # 2) 账号 / 指纹 / 代理
    account = None
    try:
        account = config_store.get_account(account_code)
    except Exception as exc:
        warnings.append(f"读取账号失败：{exc}")
    if not account:
        account = {"code": account_code, "media": media, "account": account_code}
        warnings.append(f"账号 {account_code} 未在 accounts.yaml 注册，按临时账号处理（不会保存登录态）")
        _log(f"WARN 账号未注册：{account_code}")

    fingerprint: dict = {}
    fp_mod = _lazy("fingerprint")
    if fp_mod is not None and hasattr(fp_mod, "derive"):
        try:
            fingerprint = fp_mod.derive(account_code) or {}
        except Exception as exc:
            warnings.append(f"fingerprint.derive 失败，使用浏览器默认：{exc}")

    manager = browser_mod.BrowserManager()
    session = None
    artifacts: dict[str, Any] = {"runJson": str(run_json), "stdoutLog": str(stdout_log),
                                "screenshots": [], "shotsDir": str(shots_dir)}
    steps_out: list[dict] = []
    failed_index: int | None = None
    published_url: str | None = None
    ok = False
    dry_run_stopped_at: int | None = None

    try:
        # 2b) 代理：与 sessiond._resolve_proxy 同语义（未配置代理池 → 直连 + 告警）
        pp_mod = _lazy("proxy_pool")
        proxy, proxy_warnings = _resolve_proxy(config_store, pp_mod, account_code, proxy_policy)
        warnings.extend(proxy_warnings)
        state["proxy"] = {
            "bound": bool(proxy),
            "server": (proxy or {}).get("server"),
            "policy": proxy_policy,
        }
        state["warnings"] = warnings
        _sync()
        _log(f"proxy={state['proxy']} warnings={proxy_warnings}")

        await manager.start()
        session = await manager.open_session(
            account, proxy=proxy, fingerprint=fingerprint,
            headless=bool(headless), interactive=(not headless),
        )
        state["sessionId"] = getattr(session, "session_id", None)
        # observe.screenshot 见到 run_dir 就写进 <run_dir>/shots/（证据必须落在 run 内）
        try:
            session.run_dir = run_dir
        except Exception:
            pass
        _sync()

        # 3) session_check 先跑，失败即 LOGIN_REQUIRED（不把文章敲进登录页）
        # 记录真实结果（含取样证据），而不是一个恒为 true 的字面量：
        # 守卫误判时，run.json 里必须留下能判断「它当时看到了什么」的痕迹。
        state["sessionCheck"] = await _session_check(session, recipe, values, act)
        _sync()
        _log("session_check ok")
        await _screenshot(session, shots_dir, "00-session-check", artifacts, warnings)

        # 4) 逐步回放
        for index, raw_step in enumerate(recipe.get("steps") or []):
            if not isinstance(raw_step, dict):
                continue

            # dryRun 语义：submit 步骤本身跳过，并且**它之后的所有步骤一律跳过**。
            # 理由：提交后的步骤（等跳转/取正式链接）在预演里必然不成立，若继续执行
            # 会把一次健康的预演报成 ok=false，让人误以为 recipe 坏了。
            if dry_run and dry_run_stopped_at is not None:
                skipped_type = str(raw_step.get("type") or "?")
                steps_out.append({
                    "index": index, "type": skipped_type, "status": "skipped", "ms": 0,
                    "reason": (f"dryRun=true：已在 step {dry_run_stopped_at}（submit）停止回放，"
                               "本步及其后步骤不再执行"),
                })
                state["steps"] = steps_out
                _sync()
                await _emit_progress(on_progress, index, skipped_type, "skipped")
                _log(f"[{index}] {skipped_type} skipped (dryRun: stopped after submit step "
                     f"{dry_run_stopped_at})")
                continue

            step = copy.deepcopy(raw_step)
            _apply_overrides(step, index, recipe.get("overrides") or {})
            step = await _resolve_value(step, values, act)
            stype = str(step.get("type") or "?")

            if step.get("submit") and dry_run:
                dry_run_stopped_at = index
                steps_out.append({"index": index, "type": stype, "status": "skipped", "ms": 0,
                                  "reason": "dryRun=true：跳过 submit 步骤（未提交任何内容）"})
                state["steps"] = steps_out
                _sync()
                await _emit_progress(on_progress, index, stype, "skipped")
                _log(f"[{index}] {stype} skipped (dryRun: submit not clicked)")
                continue

            retry = step.get("retry") or {}
            try:
                extra = int(retry.get("times") or 0)
            except Exception:
                extra = 0
            try:
                delay_ms = int(retry.get("delayMs") or 0)
            except Exception:
                delay_ms = 0

            await _emit_progress(on_progress, index, stype, "running")
            started = time.perf_counter()
            err: Exception | None = None
            result: dict | None = None
            attempts = 0
            healed = False

            for attempt in range(1, max(1, extra + 1) + 1):
                attempts = attempt
                try:
                    result = await _exec_step(session, step, act)
                    err = None
                    break
                except Exception as exc:
                    err = exc
                    code = getattr(exc, "code", None)
                    if code == "TARGET_NOT_FOUND" and heal:
                        healed_result, decision = await _attempt_heal(
                            session, recipe, index, step, exc, artifacts, warnings, act)
                        state["healing"]["applied" if healed_result else "refused"].append(
                            {"stepIndex": index, "type": stype, "ok": bool(healed_result), **{
                                k: decision.get(k) for k in
                                ("reason", "score", "matchedOn", "ambiguous", "locator",
                                 "locatorKind", "considered")
                            }})
                        if healed_result is not None:
                            result = healed_result
                            healed = True
                            err = None
                            await _screenshot(session, shots_dir, f"{index:02d}-heal-{stype}",
                                              artifacts, warnings)
                            _log(f"[{index}] {stype} healed -> {decision.get('locator')}")
                            break
                    if attempt <= extra and delay_ms > 0:
                        await asyncio.sleep(delay_ms / 1000.0)
            ms = int((time.perf_counter() - started) * 1000)

            record: dict[str, Any] = {"index": index, "type": stype, "ms": ms, "attempts": attempts}
            if healed:
                record["status"] = "healed"
            if err is None:
                record.setdefault("status", "ok")
                data = (result or {}).get("data") if isinstance(result, dict) else None
                if data:
                    record["data"] = data
                if isinstance(data, dict) and stype == "extract":
                    # actions._act_extract 的返回形状是 {"values": {name: value}}
                    found = extract_named_value(data, "publishedUrl")
                    if found:
                        published_url = found
                steps_out.append(record)
                await _emit_progress(on_progress, index, stype, record["status"])
                _log(f"[{index}] {stype} {record['status']} {ms}ms")
            else:
                code = getattr(err, "code", None) or "INTERNAL"
                record["status"] = "failed"
                record["error"] = {"code": code, "message": str(err),
                                   "details": getattr(err, "details", None) or {}}
                await _screenshot(session, shots_dir, f"{index:02d}-fail-{stype}", artifacts, warnings)
                if step.get("optional"):
                    record["status"] = "warning"
                    steps_out.append(record)
                    warnings.append(f"可选步骤 {index}({stype}) 失败（降级为告警）：{err}")
                    await _emit_progress(on_progress, index, stype, "warning")
                    _log(f"[{index}] {stype} warning(optional) {code}: {err}")
                else:
                    steps_out.append(record)
                    failed_index = index
                    await _emit_progress(on_progress, index, stype, "failed")
                    _log(f"[{index}] {stype} FAILED {code}: {err}")
                    if stop_on_error:
                        break
            state["steps"] = steps_out
            state["failedStep"] = failed_index
            _sync()

        ok = failed_index is None
        if ok:
            await _screenshot(session, shots_dir, "99-final", artifacts, warnings)

        if dry_run and dry_run_stopped_at is not None:
            state["stoppedBeforeSubmit"] = dry_run_stopped_at
            state["message"] = (
                f"dryRun 预演完成：step {dry_run_stopped_at} 及其后的步骤全部跳过，"
                "没有点击提交、没有发布任何内容（ok=true 只表示提交前的流程都通过了）"
            )

        # 5) publishedUrl：extract 输出优先，其次是命中 accept_link_contains 的最终 URL
        if not published_url:
            verify = recipe.get("verify") or {}
            accepts = [str(a) for a in (verify.get("accept_link_contains") or [])]
            try:
                final_url = session.page.url
            except Exception:
                final_url = ""
            if final_url and accepts and any(a in final_url for a in accepts):
                published_url = final_url

    except BaseException as exc:  # 保留证据后原样抛出（sessiond 会转成错误响应）
        state["ok"] = False
        state["failedStep"] = failed_index
        state["steps"] = steps_out
        if getattr(exc, "code", None):
            state["error"] = {"code": exc.code, "message": str(exc),
                              "details": getattr(exc, "details", None) or {}}
            if exc.code == "LOGIN_REQUIRED":
                state["loginRequired"] = True
        state["finishedAt"] = _now()
        state["warnings"] = warnings
        _sync()
        _log(f"play.run ABORTED: {type(exc).__name__} {exc}")
        raise
    finally:
        if session is not None:
            try:
                await manager.close_session(session, save_state=bool(ok and not dry_run))
            except Exception as exc:
                warnings.append(f"关闭会话失败：{exc}")
        try:
            await manager.stop()
        except Exception as exc:
            warnings.append(f"停止 BrowserManager 失败：{exc}")

    state.update({
        "ok": bool(ok),
        "publishedUrl": published_url,
        "failedStep": failed_index,
        "steps": steps_out,
        "artifacts": artifacts,
        "finishedAt": _now(),
        "warnings": warnings,
    })
    _sync()
    _log(f"play.run done ok={ok} publishedUrl={published_url} failedStep={failed_index}")

    return {
        "ok": bool(ok),
        "publishedUrl": published_url,
        "failedStep": failed_index,
        "steps": steps_out,
        "runDir": str(run_dir),
        "artifacts": artifacts,
        "warnings": warnings,
        "healing": state["healing"],
        "dryRun": bool(dry_run),
        "stoppedBeforeSubmit": state.get("stoppedBeforeSubmit"),
        "message": state.get("message"),
    }


async def _attempt_heal(
    session: Any,
    recipe: dict,
    index: int,
    step: dict,
    err: Exception,
    artifacts: dict,
    warnings: list[str],
    act: Any,
) -> tuple[dict | None, dict]:
    """TARGET_NOT_FOUND 后的自愈：新 snapshot + 候选重定位，只在唯一高置信时落地。"""
    details = getattr(err, "details", None) or {}
    candidates: list[dict] = []
    if isinstance(details, dict):
        raw = details.get("candidates")
        if isinstance(raw, list):
            candidates.extend([c for c in raw if isinstance(c, dict)])

    obs = _lazy("observe")
    if obs is not None and hasattr(obs, "snapshot"):
        try:
            snap = await obs.snapshot(session, max_elements=200, include_text=True)
            interactive = (snap or {}).get("interactive") if isinstance(snap, dict) else None
            if isinstance(interactive, list):
                candidates.extend([c for c in interactive if isinstance(c, dict)])
        except Exception as exc:
            warnings.append(f"自愈时重新 snapshot 失败：{exc}")

    decision = choose_heal_candidate(candidates, target=step.get("target") or {})
    if not decision.get("ok"):
        return None, decision

    new_step = copy.deepcopy(step)
    new_step["target"] = decision["locator"]
    try:
        result = await _exec_step(session, new_step, act)
    except Exception as exc:
        warnings.append(f"自愈重试仍失败（{decision.get('locator')}）：{exc}")
        return None, {**decision, "ok": False, "reason": f"用新定位器重试仍失败：{exc}"}

    plan = _override_plan(index, step, decision["locator"], decision["locatorKind"])
    overrides = recipe.setdefault("overrides", {})
    for key, value in plan.items():
        overrides[key] = value
    entry = {
        "at": _now(),
        "stepIndex": index,
        "type": step.get("type"),
        "reason": decision.get("reason"),
        "score": decision.get("score"),
        "matchedOn": decision.get("matchedOn"),
        "from": step.get("target"),
        "to": decision["locator"],
        "overrides": plan,
    }
    recipe.setdefault("healing_log", []).append(entry)
    artifacts.setdefault("healing", []).append(entry)
    _stderr(f"自愈成功 step={index} -> {decision['locator']}")
    return result, decision


# ---------------------------------------------------------------------------
# backfill：审核后回查正式链接
# ---------------------------------------------------------------------------
_ROWS_JS = """
() => {
  const out = [];
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const t = (a.innerText || a.textContent || '').trim();
    if (!t) continue;
    let row = a;
    for (let i = 0; i < 8 && row.parentElement; i++) {
      row = row.parentElement;
      const cls = (typeof row.className === 'string') ? row.className : '';
      const txt = (row.innerText || row.textContent || '');
      if (/row|item|content-list|article|list|card/i.test(cls) && txt.length > t.length) break;
    }
    out.push({text: t, href: a.href, rowText: (row.innerText || row.textContent || '').trim()});
  }
  return out.slice(0, 500);
}
"""


def _match_row(rows: list[dict], title: str, verify: dict) -> tuple[dict | None, str]:
    """按 verify.title_match / row_guard 找目标行。返回 (row, detail)。"""
    want = normalize_title(title)
    mode = str(verify.get("title_match") or "exact_normalized")
    guard = str(verify.get("row_guard") or "")
    guard_n = None
    m = re.search(r"(\d+)", guard)
    if guard.startswith("title_prefix") and m:
        guard_n = int(m.group(1))
    prefix = normalize_title(title)[: guard_n] if guard_n else None

    partial = None
    for row in rows:
        got = normalize_title(row.get("text"))
        if not got:
            continue
        hit = (got == want) if mode == "exact_normalized" else (want in got or got in want)
        if not hit:
            if partial is None and want and (got.startswith(want[:8]) or want.startswith(got[:8])):
                partial = row
            continue
        if prefix:
            if prefix not in normalize_title(row.get("rowText")):
                continue
        return row, "matched"
    if partial is not None:
        return None, f"仅找到近似标题行（{partial.get('text')!r}），按契约不做跨行匹配"
    return None, "未找到（可能被平台拦截或审核超时）"


async def backfill(
    recipe: dict,
    *,
    account_code: str,
    title: str,
    headless: bool = True,
) -> dict:
    paths = _require("paths")
    config_store = _require("config_store")
    browser_mod = _require("browser")
    act = _require("actions")

    verify = recipe.get("verify") or {}
    list_url = verify.get("list_url")
    if not list_url:
        return {"ok": False, "status": "no_verify", "link": None,
                "detail": "recipe.verify.list_url 未配置，无法回查"}
    list_url = str(render_templates(list_url, {}))

    account = None
    try:
        account = config_store.get_account(account_code)
    except Exception:
        account = None
    if not account:
        account = {"code": account_code, "media": recipe.get("media"), "account": account_code}

    fingerprint: dict = {}
    fp_mod = _lazy("fingerprint")
    if fp_mod is not None and hasattr(fp_mod, "derive"):
        try:
            fingerprint = fp_mod.derive(account_code) or {}
        except Exception:
            fingerprint = {}

    proxy = None
    pp_mod = _lazy("proxy_pool")
    if pp_mod is not None and hasattr(pp_mod, "get_for_account"):
        try:
            proxy = pp_mod.get_for_account(account_code, policy="sticky")
        except Exception:
            proxy = None

    manager = browser_mod.BrowserManager()
    session = None
    try:
        await manager.start()
        session = await manager.open_session(account, proxy=proxy, fingerprint=fingerprint,
                                            headless=bool(headless))
        await act.execute(session, {"type": "goto", "url": list_url,
                                    "waitUntil": "domcontentloaded", "timeoutMs": 45000})
        wait_ms = verify.get("wait_ms") or verify.get("waitMs")
        try:
            await session.page.wait_for_timeout(int(wait_ms or 7000))
        except Exception:
            pass

        try:
            rows = await session.page.evaluate(_ROWS_JS)
        except Exception as exc:
            return {"ok": False, "status": "probe_failed", "link": None,
                    "detail": f"读取列表行失败：{exc}"}
        rows = [r for r in (rows or []) if isinstance(r, dict)]

        row, detail = _match_row(rows, title, verify)
        if row is None:
            return {"ok": False, "status": "not_found", "link": None, "detail": detail,
                    "listUrl": list_url, "rowCount": len(rows)}

        href = str(row.get("href") or "")
        row_text = str(row.get("rowText") or "")
        status = "unknown"
        status_regex = verify.get("status_regex")
        if status_regex:
            m = re.search(str(status_regex), row_text)
            if m:
                status = m.group(0)

        accepts = [str(a) for a in (verify.get("accept_link_contains") or [])]
        rejects = [str(a) for a in (verify.get("reject_link_contains") or [])]
        link_ok = bool(href) and (not accepts or any(a in href for a in accepts))
        if link_ok and rejects and any(r in href for r in rejects):
            link_ok = False

        if _REJECT_STATUS_RE.search(status) or _REJECT_STATUS_RE.search(row_text[:200]):
            return {"ok": True, "status": "rejected", "statusText": status, "link": None,
                    "detail": f"状态={status or '未通过'}（{href or '无链接'}）", "listUrl": list_url}
        if _PENDING_STATUS_RE.search(status) or not link_ok:
            return {"ok": True, "status": "pending", "statusText": status, "link": None,
                    "detail": "(审核中，稍后回查)" + (f" status={status}" if status else ""),
                    "href": href or None, "listUrl": list_url}

        if verify.get("http_verify") and href:
            try:
                resp = await session.context.request.get(href, timeout=15000)
                if not resp.ok:
                    return {"ok": True, "status": "pending", "statusText": status, "link": None,
                            "detail": f"链接 HTTP {resp.status}，正式链接尚未生效（稍后回查）",
                            "href": href, "listUrl": list_url}
            except Exception as exc:
                return {"ok": True, "status": "pending", "statusText": status, "link": None,
                        "detail": f"链接校验失败（{exc}），稍后回查", "href": href, "listUrl": list_url}

        return {"ok": True, "status": "published", "statusText": status, "link": href,
                "detail": f"状态={status or '已发布'}", "listUrl": list_url}
    finally:
        if session is not None:
            try:
                await manager.close_session(session, save_state=False)
            except Exception:
                pass
        try:
            await manager.stop()
        except Exception:
            pass


__all__ = [
    "SUPPORTED_STEP_TYPES", "validate", "validate_sync", "run", "backfill",
    "choose_heal_candidate", "normalize_title", "normalize_text", "render_templates",
    "resolve_param_values", "template_names", "MIN_HEAL_SCORE", "HEAL_MARGIN",
]

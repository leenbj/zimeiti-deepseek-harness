"""页面模型：snapshot / screenshot / alerts（SPEC §2.2 §6）。

snapshot 是 agent 的「眼睛」：紧凑、ref 稳定可回指、并附带真实截图。
每个元素都带一条**可持久化**的 CSS 路径（``evaluate`` 生成），失败时降级为
``{role,text,nth}``——这正是 record 编译 recipe 与 play 自愈的基础。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from . import paths
from .rpc import log

__all__ = ["snapshot", "screenshot", "detect_alerts", "scan_elements",
           "SCAN_JS", "INTERACTIVE_SELECTOR", "ALERT_KEYWORDS", "ELEMENT_KEYS",
           "public_element", "describe_element", "find_by_text", "TEXT_TIERS",
           "TEXT_INTERACTIVE_SELECTOR"]

# SPEC §2.2 要求 interactive[] 里**每个**元素都带这些键
ELEMENT_KEYS = ("ref", "tag", "role", "text", "selector", "visible", "enabled",
                "box", "inFrame")

# 可交互元素 + 常见可点容器（含中文站大量 el-* / mt-* 组件）
INTERACTIVE_SELECTOR = ", ".join([
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select",
    "summary", "label", "[role=button]", "[role=link]", "[role=tab]", "[role=radio]",
    "[role=checkbox]", "[role=menuitem]", "[role=option]", "[role=switch]",
    "[contenteditable=true]", "[contenteditable='']", "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
    "li.publish-report-btn", ".mt-button", ".el-radio", ".el-checkbox",
])

ALERT_KEYWORDS = (
    "安全验证", "验证码", "扫码登录", "重新登录", "登录后继续", "请登录", "滑块",
    "滑动验证", "人机验证", "操作频繁", "访问异常", "账号异常", "登录已失效",
    "captcha", "verify", "verification", "unusual traffic", "access denied",
    "forbidden", "blocked", "risk control",
)

SUBMIT_KEYWORDS = re.compile(
    r"(发布|发表|提交|保存并发布|立即发布|确认发布|publish|submit|post now)", re.I)

SCAN_JS = r"""
(opts) => {
  const MAX = (opts && opts.max) || 120;
  const HARD = (opts && opts.hard) || 4000;
  const SEL = (opts && opts.selector) || "a[href],button,input,textarea,select";
  const out = [];
  let seen = 0;
  const nodes = document.querySelectorAll(SEL);

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  function cssPath(el) {
    try {
      if (el.id) {
        const idSel = "#" + cssEscape(el.id);
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      }
    } catch (e) {}
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) {}
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function implicitRole(el, tag, type) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "li") return "listitem";
    if (tag === "img") return el.getAttribute("alt") ? "img" : "presentation";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "file") return "button";
      if (type === "range") return "slider";
      return "textbox";
    }
    return "generic";
  }

  function labelText(el) {
    const t = [];
    if (el.getAttribute("aria-label")) t.push(el.getAttribute("aria-label"));
    if (el.getAttribute("placeholder")) t.push(el.getAttribute("placeholder"));
    if (el.getAttribute("title")) t.push(el.getAttribute("title"));
    if (el.getAttribute("alt")) t.push(el.getAttribute("alt"));
    if (el.id) {
      try {
        const lab = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (lab && lab.textContent) t.push(lab.textContent);
      } catch (e) {}
    }
    const near = el.closest("label");
    if (near && near.textContent) t.push(near.textContent);
    const txt = (el.innerText || el.textContent || "");
    if (txt) t.push(txt);
    return t.join(" ").replace(/\s+/g, " ").trim();
  }

  for (const el of nodes) {
    if (seen++ > HARD) break;
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    let visible = rect.width > 0 && rect.height > 0;
    if (visible && cs) {
      visible = cs.visibility !== "hidden" && cs.display !== "none"
        && parseFloat(cs.opacity || "1") > 0.05;
    }
    if (visible && el.checkVisibility) {
      try {
        visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          && rect.width > 0 && rect.height > 0;
      } catch (e) {}
    }
    const isFile = tag === "input" && type === "file";
    if (!visible && !isFile) continue;

    const role = implicitRole(el, tag, type);
    let text = labelText(el);
    if (text.length > 80) text = text.slice(0, 80);
    const enabled = !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const value = (tag === "input" && ["submit", "button", "reset"].includes(type))
      ? (el.value || "") : null;
    const sel = cssPath(el);
    let nth = 0;
    try {
      const all = document.querySelectorAll(sel);
      nth = Array.prototype.indexOf.call(all, el);
      if (nth < 0) nth = 0;
    } catch (e) {}

    out.push({
      tag: tag,
      role: role,
      type: type || null,
      text: text || value || "",
      selector: sel,
      nth: nth,
      visible: visible,
      enabled: enabled,
      checked: (type === "checkbox" || type === "radio") ? !!el.checked : null,
      box: [Math.round(rect.left), Math.round(rect.top),
            Math.round(rect.width), Math.round(rect.height)],
      inViewport: rect.top < (window.innerHeight || 0) && rect.bottom > 0
        && rect.left < (window.innerWidth || 0) && rect.right > 0,
      id: el.id || null,
      name: el.getAttribute("name") || null,
      placeholder: el.getAttribute("placeholder") || null,
      value: value,
      contenteditable: el.getAttribute("contenteditable") === "true"
        || el.getAttribute("contenteditable") === "" || el.isContentEditable === true,
    });
    if (out.length >= MAX) break;
  }

  const bodyText = (document.body ? (document.body.innerText || "") : "");
  return {
    url: location.href,
    title: document.title || "",
    elements: out,
    text: bodyText,
    truncated: out.length >= MAX,
    counts: { interactive: out.length, scanned: seen }
  };
}
"""

_TEXT_LINE_SPLIT = re.compile(r"[\r\n]+")

# 文本定位的「可交互」范围：真实平台上的提交按钮常常是 <li>/<div class="mt-button">
TEXT_INTERACTIVE_SELECTOR = ", ".join([
    "button", "a[href]", "input[type=submit]", "input[type=button]", "input[type=reset]",
    "label", "summary", "select", "textarea",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=option]",
    "[role=checkbox]", "[role=radio]", "[role=switch]", "[onclick]",
    ".mt-button", ".el-button", ".ant-btn", "li.publish-report-btn",
])

# 文本目标的四级优先级：短动作词（发布/提交/保存）不能被 <h1>发布中心</h1> 抢走。
TEXT_TIERS = ("interactive-exact", "any-exact", "interactive-substring", "any-substring")

TEXT_RESOLVE_JS = r"""
(args) => {
  const target = String(args.text || "").replace(/\s+/g, " ").trim();
  const exact = !!args.exact;
  const limit = args.limit || 10;
  const INTERACTIVE = args.interactive;
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }
  function cssPath(el) {
    try {
      if (el.id) {
        const idSel = "#" + cssEscape(el.id);
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      }
    } catch (e) {}
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (e) {}
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }
  function visible(el) {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    if (parseFloat(cs.opacity || "1") <= 0.05) return false;
    if (el.checkVisibility) {
      try {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch (e) {}
    }
    return true;
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top < (window.innerHeight || 0) && r.bottom > 0
      && r.left < (window.innerWidth || 0) && r.right > 0;
  }
  function roleOf(el, tag, type) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "li") return "listitem";
    if (tag === "label") return "generic";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "generic";
  }
  // 可访问名近似：可见文本 > value > aria-label/placeholder/title/alt
  function nameOf(el) {
    const txt = norm(el.innerText || "");
    if (txt) return txt;
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && ["submit", "button", "reset"].includes(type)) {
      const v = norm(el.value || "");
      if (v) return v;
    }
    for (const attr of ["aria-label", "placeholder", "title", "alt"]) {
      const v = norm(el.getAttribute(attr) || "");
      if (v) return v;
    }
    const lab = el.closest("label");
    if (lab && lab !== el) return norm(lab.innerText || "");
    return "";
  }
  function describe(el) {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const sel = cssPath(el);
    let nth = 0;
    try {
      const all = document.querySelectorAll(sel);
      nth = Array.prototype.indexOf.call(all, el);
      if (nth < 0) nth = 0;
    } catch (e) {}
    return {
      tag: tag, role: roleOf(el, tag, type), type: type || null,
      text: nameOf(el).slice(0, 80), selector: sel, nth: nth,
      visible: visible(el), inViewport: inViewport(el),
      enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
    };
  }

  const interactiveSet = new Set(Array.from(document.querySelectorAll(INTERACTIVE)));
  const nodes = Array.from(document.querySelectorAll("*"));
  const isInteractive = (el) => interactiveSet.has(el);
  const innerMost = (el, pred) => {
    for (const child of el.querySelectorAll("*")) {
      if (pred(child)) return false;
    }
    return true;
  };
  const preds = {
    "interactive-exact": (el) => isInteractive(el) && nameOf(el) === target,
    "any-exact": (el) => nameOf(el) === target && innerMost(el, (c) => nameOf(c) === target),
    "interactive-substring": (el) => !exact && isInteractive(el) && nameOf(el).includes(target),
    "any-substring": (el) => !exact && nameOf(el).includes(target)
      && innerMost(el, (c) => nameOf(c).includes(target)),
  };

  const tierCounts = {};
  for (const tier of args.tiers) {
    const pred = preds[tier];
    if (!pred) continue;
    const hits = nodes.filter(pred);
    tierCounts[tier] = hits.length;
    if (!hits.length) continue;
    // 同一层里优先「可见且在视口内」，其次可见，最后文档顺序
    const ranked = hits.slice().sort((a, b) => {
      const score = (el) => (visible(el) ? (inViewport(el) ? 2 : 1) : 0);
      return score(b) - score(a);
    });
    const visibleHits = ranked.filter(visible);
    const chosen = (visibleHits.length ? visibleHits : ranked)[0];
    return {
      tier: tier,
      tierCounts: tierCounts,
      matchCount: hits.length,
      visibleCount: visibleHits.length,
      ambiguous: hits.length > 1,
      winner: describe(chosen),
      candidates: ranked.slice(0, limit).map(describe),
    };
  }
  return {tier: null, tierCounts: tierCounts, matchCount: 0, visibleCount: 0,
          ambiguous: false, winner: null,
          candidates: nodes.filter(preds["any-substring"]).slice(0, limit).map(describe)};
}
"""


async def find_by_text(frame, text: str, *, exact: bool = False,
                       limit: int = 10) -> dict:
    """按四级优先级找元素：交互元素精确 > 任意元素精确 > 交互元素子串 > 任意元素子串。"""
    return await frame.evaluate(TEXT_RESOLVE_JS, {
        "text": str(text), "exact": bool(exact), "limit": int(limit),
        "interactive": TEXT_INTERACTIVE_SELECTOR, "tiers": list(TEXT_TIERS),
    })


async def _scan_frame(frame, selector: str, max_elements: int) -> dict:
    return await frame.evaluate(SCAN_JS, {"max": max_elements, "selector": selector})


async def scan_elements(session, *, max_elements: int = 80,
                        frame=None, deep: bool = False) -> list[dict]:
    """扫描当前（或指定）frame 的可交互元素，返回描述符列表（带 inFrame）。"""
    frame = frame or session.current_frame()
    try:
        data = await _scan_frame(frame, INTERACTIVE_SELECTOR, max_elements)
    except Exception as exc:
        if deep:
            raise
        log(f"scan_elements failed: {exc!r}", level="WARN")
        return []
    elements = data.get("elements") or []
    for el in elements:
        el["inFrame"] = _frame_path(session, frame)
    return elements


def _frame_path(session, frame) -> str:
    try:
        frames = session.page.frames
        idx = frames.index(frame)
    except Exception:
        return "main"
    return "main" if idx == 0 else f"f{idx}"


async def snapshot(session, *, max_elements: int = 120, include_text: bool = True) -> dict:
    """SPEC §2.2 页面模型。ref 在下一次 snapshot 前保持有效。"""
    page = session.page
    frame_meta: list[dict] = []
    frames = list(page.frames)
    collected: list[dict] = []
    remaining = max(1, int(max_elements))
    main_text = ""
    main_title = ""
    alerts: list[str] = []

    session.reset_refs()

    for i, frame in enumerate(frames):
        path = "main" if i == 0 else f"f{i}"
        frame_meta.append({"path": path, "url": _safe(frame, "url")})
        if remaining <= 0:
            continue
        try:
            data = await _scan_frame(frame, INTERACTIVE_SELECTOR, remaining)
        except Exception as exc:
            frame_meta[-1]["error"] = str(exc)[:120]
            continue
        if i == 0:
            main_text = data.get("text") or ""
            main_title = data.get("title") or ""
        if path != "main" and re.search(r"captcha|验证", str(frame_meta[-1]["url"]), re.I):
            alerts.append(f"captcha-iframe:{path}")
        for el in data.get("elements") or []:
            if remaining <= 0:
                break
            el["inFrame"] = path
            collected.append(el)
            remaining -= 1

    # 视口内的元素优先（agent 更需要看得见的东西），但保持文档顺序稳定
    for order, el in enumerate(collected):
        el["_order"] = order
    collected.sort(key=lambda e: (0 if e.get("inViewport") else 1, e["_order"]))

    interactive: list[dict] = []
    for el in collected:
        descriptor = describe_element(el)
        ref = session.register_ref(descriptor)
        interactive.append(public_element(descriptor, ref))

    text_sample: list[str] = []
    if include_text and main_text:
        for line in _TEXT_LINE_SPLIT.split(main_text):
            line = line.strip()
            if not line or len(line) > 200:
                continue
            if line not in text_sample:
                text_sample.append(line)
            if len(text_sample) >= 60:
                break

    alerts.extend(detect_alerts(_safe(page.main_frame, "url"), main_title,
                               "\n".join(text_sample)))
    alerts = list(dict.fromkeys(alerts))

    shot: dict | None = None
    try:
        shot = await screenshot(session, full_page=False, label="snapshot")
    except Exception as exc:
        log(f"snapshot screenshot failed: {exc!r}", level="WARN")

    session.last_url = _safe(page.main_frame, "url")
    result = {
        "sessionId": session.session_id,
        "url": session.last_url,
        "title": main_title,
        "activeFrame": session.frame_path[-1] if session.frame_path else "main",
        "frames": frame_meta,
        "interactive": interactive,
        "textSample": text_sample,
        "alerts": alerts,
        "counts": {"interactive": len(interactive), "scanned": len(collected)},
        "truncated": remaining <= 0,
        "screenshot": shot["path"] if shot else None,
    }
    session.note("snapshot", {"url": result["url"], "count": len(interactive),
                              "screenshot": result["screenshot"]})
    return result


def _descriptor(el: dict) -> dict:
    text = str(el.get("text") or "")
    desc = {
        "kind": "selector",
        "value": el.get("selector") or "",
        "selector": el.get("selector") or "",
        "tag": el.get("tag") or "",
        "role": el.get("role") or "",
        "text": text,
        "nth": int(el.get("nth") or 0),
        "visible": bool(el.get("visible")),
        "enabled": bool(el.get("enabled", True)),
        "inFrame": el.get("inFrame") or "main",
        "box": el.get("box") or [0, 0, 0, 0],
    }
    if not desc["selector"]:
        desc.update({"kind": "text", "value": text})
    if el.get("type"):
        desc["type"] = el["type"]
    if el.get("id"):
        desc["id"] = el["id"]
    if el.get("name"):
        desc["name"] = el["name"]
    if el.get("placeholder"):
        desc["placeholder"] = el["placeholder"]
    if el.get("contenteditable"):
        desc["contenteditable"] = True
    if el.get("checked") is not None:
        desc["checked"] = el["checked"]
    if el.get("enabled") is False:
        desc["disabled"] = True
    if text and SUBMIT_KEYWORDS.search(text):
        desc["likelySubmit"] = True
    return desc


def describe_element(el: Any) -> dict:
    """把**任意**元素输入（SQL 采集结果 / 裸 dict / 缺字段）规范成完整描述符。

    这是「永不 KeyError」的保险栓：无论上游少了哪个键，输出都自带全部 SPEC §2.2 键。
    """
    raw = el if isinstance(el, dict) else {}
    desc = _descriptor(raw)
    # 兜底：即使 _descriptor 被改坏，这里也强制补齐
    for key in ELEMENT_KEYS:
        if key not in desc:
            desc[key] = {"ref": "", "tag": "", "role": "", "text": "", "selector": "",
                         "visible": False, "enabled": True, "box": [0, 0, 0, 0],
                         "inFrame": "main"}[key]
    return desc


def public_element(el: Any, ref: str | None = None) -> dict:
    """按 SPEC §2.2 组装 ``interactive[]`` 的一项；输入可以是任意残缺 dict。"""
    desc = el if isinstance(el, dict) and "selector" in el else describe_element(el)
    box = desc.get("box")
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        box = [0, 0, 0, 0]
    safe_box = []
    for value in box:
        try:
            safe_box.append(int(value))
        except (TypeError, ValueError):
            safe_box.append(0)
    visible = bool(desc.get("visible", True))
    item = {
        "ref": str(ref or desc.get("ref") or ""),
        "tag": str(desc.get("tag") or ""),
        "role": str(desc.get("role") or ""),
        "text": str(desc.get("text") or ""),
        "selector": str(desc.get("selector") or desc.get("value") or ""),
        "visible": visible,
        "enabled": bool(desc.get("enabled", True)),
        "box": safe_box,
        "inFrame": str(desc.get("inFrame") or "main"),
    }
    for optional in ("type", "id", "name", "placeholder"):
        if desc.get(optional):
            item[optional] = str(desc[optional])
    if desc.get("contenteditable"):
        item["contenteditable"] = True
    if desc.get("checked") is not None:
        item["checked"] = bool(desc.get("checked"))
    if desc.get("likelySubmit"):
        item["likelySubmit"] = True
    if not visible:
        item["hidden"] = True
    return item


def _shots_dir(session) -> Path:
    if getattr(session, "run_dir", None):
        d = Path(session.run_dir) / "shots"
        d.mkdir(parents=True, exist_ok=True)
        return d
    return paths.account_shots_dir(session.code)


async def screenshot(session, *, full_page: bool = False, label: str = "shot") -> dict:
    """截图落盘（账号 shots/ 或 run_dir/shots），返回 {path,width,height,bytes}。"""
    page = session.page
    out_dir = _shots_dir(session)
    name = f"{paths.timestamp()}-{paths.safe_slug(label)}-{session.session_id}.png"
    path = out_dir / name
    await page.screenshot(path=str(path), full_page=bool(full_page), animations="disabled")
    size = path.stat().st_size if path.exists() else 0
    viewport = session.fingerprint.get("viewport") or {}
    width, height = viewport.get("width"), viewport.get("height")
    try:
        box = await page.evaluate("() => ({w: document.documentElement.scrollWidth,"
                                  " h: document.documentElement.scrollHeight})")
        if box:
            height = int(box.get("h") or height or 0) if full_page else height
    except Exception:
        pass
    session.note("screenshot", {"path": str(path), "fullPage": bool(full_page)})
    return {"path": str(path), "width": width, "height": height, "bytes": size,
            "fullPage": bool(full_page)}


def detect_alerts(url: str, title: str, text: str) -> list[str]:
    """验证码/风控/掉登录的启发式识别（纯函数，可单测）。"""
    haystack = "\n".join([str(url or ""), str(title or ""), str(text or "")]).lower()
    hits: list[str] = []
    for kw in ALERT_KEYWORDS:
        if kw.lower() in haystack:
            hits.append(kw)
    if re.search(r"(passport|sso|login|signin)", str(url or ""), re.I):
        hits.append("login-redirect")
    return hits


def _safe(frame, attr: str) -> str:
    try:
        return str(getattr(frame, attr) or "")
    except Exception:
        return ""


def to_json(obj: Any) -> str:  # pragma: no cover - 调试辅助
    return json.dumps(obj, ensure_ascii=False)

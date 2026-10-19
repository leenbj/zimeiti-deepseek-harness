"""tests/test_recipes.py — recipe/录制/回放 的纯逻辑测试 + 可跳过的浏览器冒烟。

用法（二选一，本机没装 pytest）：
    python -m pytest tests/test_recipes.py
    python tests/test_recipes.py

纯逻辑部分不需要浏览器、不需要网络；唯一的浏览器用例会把临时 recipe 写到系统临时目录
（**不写进 engine/recipes/**），并在兄弟模块尚未就绪时明确 skip。
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 浏览器用例必须把数据目录指到临时目录：必须在导入 engine.* 之前设置
TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="media-publish-test-"))
os.environ["MEDIA_DATA_DIR"] = str(TEST_DATA_DIR)

import yaml  # noqa: E402

from engine import play, record  # noqa: E402

RECIPES_DIR = ROOT / "engine" / "recipes"
BUILTIN_IDS = ("sohu__publish-article", "toutiao__publish-article", "csdn__publish-article")

# ---------------------------------------------------------------------------
# 极简测试框架（pytest 与本文件直跑都支持）
# ---------------------------------------------------------------------------
_TESTS: list = []


def test(fn):
    _TESTS.append(fn)
    return fn


class Skipped(Exception):
    pass


try:  # pytest 可用时，让 Skipped 也表现为 pytest 的 skip（而不是 failure）
    import pytest as _pytest

    class Skipped(_pytest.skip.Exception):  # type: ignore[no-redef]
        """pytest 下等价于 pytest.skip(...)。"""
except ImportError:  # pragma: no cover - 本机 bundled 运行时没有 pytest
    _pytest = None  # type: ignore[assignment]


def load_builtin(recipe_id: str) -> dict:
    return yaml.safe_load((RECIPES_DIR / f"{recipe_id}.yaml").read_text(encoding="utf-8"))


def load_builtins() -> dict[str, dict]:
    return {rid: load_builtin(rid) for rid in BUILTIN_IDS}


def error_issues(report: dict) -> list[dict]:
    return [i for i in report["issues"] if i["level"] == "error"]


# ---------------------------------------------------------------------------
# 1. 三个内置 recipe：加载 + validate 零 error
# ---------------------------------------------------------------------------
@test
def test_builtin_recipes_exist_and_validate_clean():
    recipes = load_builtins()
    assert set(recipes) == set(BUILTIN_IDS)
    for rid, recipe in recipes.items():
        assert recipe["id"] == rid, f"{rid}: id 与文件名不一致"
        assert recipe["recipe_version"] == 1
        report = play.validate_sync(recipe)
        errs = error_issues(report)
        assert not errs, f"{rid} 有 error 级问题: {json.dumps(errs, ensure_ascii=False)}"
        assert report["ok"] is True, f"{rid} validate.ok 应为 True"


@test
def test_builtin_recipe_media_and_accounts():
    expected = {
        "sohu__publish-article": ("sohu", ["a-1"]),
        "toutiao__publish-article": ("toutiao", ["b-1"]),
        "csdn__publish-article": ("csdn", ["c-1", "c-2"]),
    }
    for rid, (media, codes) in expected.items():
        recipe = load_builtin(rid)
        assert recipe["media"] == media, rid
        assert list(recipe["account_codes"]) == codes, rid
        assert recipe["capabilities"], rid
        assert recipe["session_check"]["url"], rid
        assert recipe["verify"]["mode"] in ("immediate", "later_backfill"), rid


# ---------------------------------------------------------------------------
# 2. 步骤 type 全在分发表内
# ---------------------------------------------------------------------------
@test
def test_all_step_types_supported():
    table = set(play.SUPPORTED_STEP_TYPES)
    assert table == set(record.RECIPE_STEP_TYPES), "record/play 的步骤类型表必须一致"
    for rid, recipe in load_builtins().items():
        for i, step in enumerate(recipe["steps"]):
            assert step["type"] in table, f"{rid} steps[{i}] type={step['type']} 不在分发表"


# ---------------------------------------------------------------------------
# 3. 模板参数：全部已声明；必填参数都被引用
# ---------------------------------------------------------------------------
@test
def test_params_declared_and_required_params_used():
    for rid, recipe in load_builtins().items():
        declared = {p["name"] for p in recipe["params"]}
        refs = play.template_names({k: v for k, v in recipe.items() if k != "params"})
        undeclared = refs - declared
        assert not undeclared, f"{rid} 引用了未声明参数 {undeclared}"
        for p in recipe["params"]:
            if p.get("required"):
                assert p["name"] in refs, f"{rid} 必填参数 {p['name']} 未被任何步骤引用"


@test
def test_recipes_declare_expected_params():
    assert [p["name"] for p in load_builtin("sohu__publish-article")["params"]] == \
        ["title", "body", "declaration"]
    assert [p["name"] for p in load_builtin("toutiao__publish-article")["params"]] == \
        ["title", "body", "gallery_keyword"]
    assert [p["name"] for p in load_builtin("csdn__publish-article")["params"]] == \
        ["title", "body", "tag"]
    # 平台标题长度上限来自实测（sohu 5-72、toutiao 30、csdn 5-100）
    limits = {rid: next(p for p in r["params"] if p["name"] == "title").get("max_len")
              for rid, r in load_builtins().items()}
    assert limits["sohu__publish-article"] == 72
    assert limits["toutiao__publish-article"] == 30
    assert limits["csdn__publish-article"] == 100


@test
def test_submit_step_marked_exactly_once_per_recipe():
    for rid, recipe in load_builtins().items():
        submits = [i for i, s in enumerate(recipe["steps"]) if s.get("submit")]
        assert len(submits) == 1, f"{rid} 应恰好有 1 个 submit 步骤，实际 {submits}"
        assert recipe["steps"][submits[0]]["type"] in ("click", "dispatch"), rid
    # 头条必须是「确认发布」（二次确认），不是「预览并发布」
    tt = load_builtin("toutiao__publish-article")
    submit = next(s for s in tt["steps"] if s.get("submit"))
    assert "确认发布" in str(submit.get("target"))


# ---------------------------------------------------------------------------
# 4. infer_params 往返：字面量 → {{title}}/{{body}} → compile_recipe → 可加载
# ---------------------------------------------------------------------------
TITLE_LITERAL = "中文域名.网址对企业有用吗？品牌保护与知识产权不可或缺的一环"
BODY_LITERAL = "\n".join([
    "中文域名.网址的价值，首先体现在品牌保护上：企业把品牌名直接做成域名，用户看一眼就能记住，"
    "不必在英文缩写和拼音之间反复猜测，这对长期经营的企业来说是一笔看不见却持续生效的资产。",
    "其次，中文域名的知识产权属性同样值得关注。域名注册遵循先申请先获得的原则，"
    "尽早把与自身商标、字号一致的中文域名收入囊中，能够有效降低被他人抢注、被第三方高价兜售的风险。",
    "再次，从实际使用角度看，中文域名.网址在名片、包装、广告物料上的辨识度更高，"
    "线下场景里口播一次就能记住，减少了流量在「记不住域名」这一步的流失。",
])


def synthetic_trace() -> list[dict]:
    return [
        {"type": "goto", "url": "https://mp.example.com/publish", "waitUntil": "domcontentloaded"},
        {"type": "type", "target": {"selector": 'input[placeholder="请输入标题（5-72字）"]'},
         "text": TITLE_LITERAL, "mode": "fill"},
        {"type": "frame", "frame": {"urlContains": "editor"}},
        {"type": "type", "target": {"selector": ".ql-editor[contenteditable=true]"},
         "text": BODY_LITERAL, "mode": "type"},
        {"type": "frame", "frame": "main"},
        {"type": "dispatch", "target": {"text": "无需声明"}, "event": "click"},
        {"type": "click", "target": {"text": "发布"}, "event": "click"},
        {"type": "note", "text": "这行不该进 recipe"},
        {"kind": "handoff", "payload": {"reason": "captcha"}},
    ]


class FakeSession:
    """只提供 record.py 需要的字段，不碰浏览器。"""

    def __init__(self, trace: list[dict], code: str = "a-1") -> None:
        self.session_id = "s-test"
        self.code = code
        self.trace = trace
        self.recording = True


@test
def test_infer_params_replaces_literals():
    steps = [s for s in synthetic_trace() if record.is_recipe_step(s)]
    report: dict = {}
    params = record.infer_params(steps, report=report)

    assert [p["name"] for p in params] == ["title", "body", "declaration"], params
    title_step = next(s for s in steps if s.get("type") == "type" and "标题" in str(s.get("target")))
    body_step = next(s for s in steps
                     if str(s.get("target", {}).get("selector", "")).startswith(".ql-editor"))
    assert title_step["text"] == "{{title}}"
    assert body_step["text"] == "{{body}}"
    assert body_step["mode"] == "type", "参数化后不能丢掉 mode"
    assert steps[5]["target"]["text"] == "{{declaration}}"
    # 字面量不得残留
    assert TITLE_LITERAL not in json.dumps(steps, ensure_ascii=False)
    assert BODY_LITERAL not in json.dumps(steps, ensure_ascii=False)
    # 非步骤条目被过滤
    assert not any(s.get("type") == "note" for s in steps)
    # title 必填、body 必填且 min_len、declaration 是带默认值的 enum
    by_name = {p["name"]: p for p in params}
    assert by_name["title"]["required"] is True and by_name["title"]["type"] == "string"
    assert by_name["body"]["required"] is True and by_name["body"]["type"] == "text"
    assert by_name["body"]["min_len"] == 1
    assert by_name["declaration"]["type"] == "enum"
    assert by_name["declaration"]["default"] == "无需声明"
    assert by_name["declaration"]["required"] is False
    # 审计轨迹：每条决策都要能解释
    assert report["params"] == params
    decided = {(d["stepIndex"], d["path"]): d for d in report["decisions"]}
    assert decided[(1, "text")]["decision"] == "parameterized"
    assert decided[(1, "text")]["param"] == "title"
    assert decided[(3, "text")]["param"] == "body"
    assert decided[(3, "text")]["targetHint"] == "editor"
    assert all(d.get("reason") for d in report["decisions"])


@test
def test_infer_params_is_conservative_on_unknown_targets():
    steps = [
        {"type": "type", "target": {"selector": "input[placeholder*='自定义标签']"},
         "text": "域名与商标", "mode": "type"},
        {"type": "type", "target": {"selector": "input[placeholder='请输入标题']"},
         "text": "发布", "mode": "fill"},
    ]
    report: dict = {}
    params = record.infer_params(steps, report=report)
    assert params == [], "无标题/正文提示时应保持字面量"
    assert steps[0]["text"] == "域名与商标"
    assert steps[1]["text"] == "发布", "UI 文案（发布）不得被当成标题"
    assert all(d["decision"] == "kept-literal" for d in report["decisions"])


@test
def test_infer_params_does_not_touch_eval_escape_hatch():
    steps = [{"type": "eval",
              "expression": "(() => '一二三四五六七八九十一二三四五六七八九十')()",
              "purpose": "x"}]
    params = record.infer_params(steps)
    assert params == []
    assert steps[0]["expression"].startswith("(() =>")


@test
def test_infer_params_merges_paragraph_by_paragraph_typing():
    a = "第一段内容，用来模拟逐段录制正文时的第一段文字。"
    b = "第二段内容，用来模拟逐段录制正文时的第二段文字。"
    steps = [
        {"type": "type", "target": {"selector": ".ql-editor[contenteditable=true]"},
         "text": a, "mode": "type"},
        {"type": "type", "target": {"selector": ".ql-editor[contenteditable=true]"},
         "text": b, "mode": "type"},
    ]
    report: dict = {}
    params = record.infer_params(steps, report=report)
    assert len(steps) == 1, "同一编辑器的连续逐段录入应合并为一步"
    assert steps[0]["text"] == "{{body}}"
    long_steps = [s for s in [steps[0]] if "{{body}}" in s["text"]]
    assert long_steps
    assert [p["name"] for p in params] == ["body"]
    assert report["merges"], "合并决策必须写进 compile report"
    assert a + "\n" + b not in steps[0]["text"]


@test
def test_compile_recipe_roundtrip_inherits_platform_metadata():
    steps = [s for s in synthetic_trace() if record.is_recipe_step(s)]
    session = FakeSession(steps, code="a-1")
    report: dict = {}
    recipe = record.compile_recipe(
        session, recipe_id="sohu__publish-article", media="sohu", report=report)

    # SPEC §3 的键与顺序
    assert list(recipe.keys()) == [
        "recipe_version", "id", "media", "label", "account_codes", "capabilities",
        "session_check", "params", "steps", "verify", "overrides",
    ]
    # 继承平台元数据
    assert recipe["label"] == "搜狐号发布图文"
    assert recipe["account_codes"] == ["a-1"]
    assert recipe["capabilities"]["editor"] == "quill"
    assert recipe["session_check"]["url"].endswith("/first/page")
    assert recipe["verify"]["mode"] == "later_backfill"
    assert recipe["overrides"] == {}
    # 参数：录制推断 + 平台 max_len 合体 + 枚举补齐
    by_name = {p["name"]: p for p in recipe["params"]}
    assert set(by_name) == {"title", "body", "declaration"}
    assert by_name["title"]["max_len"] == 72, "应继承内置 recipe 的标题长度上限"
    assert by_name["body"]["min_len"] == 1
    assert len(by_name["declaration"]["values"]) == 6, "枚举候选应继承内置的完整集合"
    # 模板替换 + submit 标记
    assert recipe["steps"][1]["text"] == "{{title}}"
    assert recipe["steps"][3]["text"] == "{{body}}"
    submits = [i for i, s in enumerate(recipe["steps"]) if s.get("submit")]
    assert submits == [6], submits
    assert report["submitStep"]["submitStepIndex"] == 6
    assert report["submitStep"]["candidates"], "submit 判定必须给出候选与理由"
    assert TITLE_LITERAL not in json.dumps(recipe, ensure_ascii=False)
    # 往返：编译产物必须是合法 recipe
    assert play.validate_sync(recipe)["ok"] is True
    # 可被 config_store.load_recipe 消费（用 yaml 往返模拟落盘/读盘）
    assert yaml.safe_load(yaml.safe_dump(recipe, allow_unicode=True, sort_keys=False))["id"] == recipe["id"]


@test
def test_save_refuses_to_overwrite_without_flag():
    """save 走 config_store/paths 落盘，缺少兄弟模块时只验证拒绝逻辑的判据。"""
    paths = play._lazy("paths")
    config_store = play._lazy("config_store")
    if paths is None or config_store is None:
        raise Skipped("paths/config_store 未就绪，跳过 save 落盘用例")
    steps = [s for s in synthetic_trace() if record.is_recipe_step(s)]
    session = FakeSession(steps, code="a-1")
    first = record.save(session, recipe_id="sohu__publish-article", media="sohu", label="临时")
    assert Path(first["recipePath"]).exists()
    assert first["stepCount"] == len(steps)
    report_path = Path(first["recipePath"]).with_suffix(".compile-report.json")
    assert report_path.exists(), "必须写 <id>.compile-report.json"
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    assert payload["inferParams"]["params"] and payload["submitStep"]["submitStepIndex"] is not None
    # 往返保证：compile 产物落盘后必须是合法 recipe，且 config_store.load_recipe 能读回来
    saved_direct = yaml.safe_load(Path(first["recipePath"]).read_text(encoding="utf-8"))
    assert play.validate_sync(saved_direct)["ok"] is True
    assert len(saved_direct["steps"]) == first["stepCount"]
    loaded, _loaded_path = config_store.load_recipe("sohu__publish-article")
    assert loaded["id"] == "sohu__publish-article"
    assert play.validate_sync(loaded)["ok"] is True
    # 注意（已上报引擎 owner）：config_store.load_recipe 的 fast-path 先查内置目录，
    # 所以 <DATA>/recipes/<media>/<id>.yaml 会被同名内置 recipe 抢先命中，
    # 这里刻意不断言 loaded_path == 保存路径，以免掩盖该 seam。
    # 二次保存必须拒绝
    session2 = FakeSession([s for s in synthetic_trace() if record.is_recipe_step(s)], code="a-1")
    try:
        record.save(session2, recipe_id="sohu__publish-article", media="sohu")
    except Exception as exc:  # ActionError
        assert getattr(exc, "code", None) == "BAD_REQUEST", exc
        assert "overwrite" in str(exc)
    else:
        raise AssertionError("未加 overwrite 时必须拒绝覆盖用户 recipe")


@test
def test_trace_shapes_are_tolerated():
    """分派器可能写入的不同 trace 形状：只有带载荷的规范化步骤才能进 recipe。"""
    bare = {"type": "goto", "url": "https://example.test/a"}
    envelope = {"kind": "step", "step": {"type": "type", "target": {"selector": "#t"},
                                         "text": "x"}}
    flat = {"kind": "step", "ts": "t", "type": "click", "target": {"selector": "#b"}}
    # actions.execute 现在写的摘要：缺 url/text/spec 载荷，绝不能当成步骤编译
    action_only = {"ts": "t", "kind": "action", "type": "click",
                   "target": {"selector": "#b"}, "ms": 12, "ok": True}
    other = {"ts": "t", "kind": "handoff", "reason": "captcha"}
    assert record.normalize_step_entry(bare) == bare
    assert record.normalize_step_entry(envelope)["text"] == "x"
    assert record.normalize_step_entry(flat) == {"type": "click", "target": {"selector": "#b"}}
    assert record.normalize_step_entry(action_only) is None
    assert record.normalize_step_entry(other) is None
    assert record.normalize_step_entry({"type": "note", "text": "x"}) is None
    steps = record.recipe_steps([bare, envelope, flat, action_only, other])
    assert [s["type"] for s in steps] == ["goto", "type", "click"]
    diag = record.trace_diagnostics([action_only, action_only])
    assert diag["actionOnly"] == 2 and diag["steps"] == 0
    assert record.dispatcher_gap(diag) and "add_step" in record.dispatcher_gap(diag)
    ok_diag = record.trace_diagnostics([bare, action_only])
    assert record.dispatcher_gap(ok_diag) is None, "有规范化步骤时不该报阻塞"


@test
def test_start_writes_trace_header_and_marks_recording():
    paths = play._lazy("paths")
    if paths is None:
        raise Skipped("paths 未就绪，跳过 record.start 用例")

    class _Sess(FakeSession):
        def note(self, kind, payload):  # 模拟 Session.note
            self.trace.append({"kind": kind, **payload})

    session = _Sess([], code="a-1")
    session.trace_path = None
    session.recipe_id = None
    info = record.start(session, "sohu__publish-article", "sohu")
    assert session.recording is True
    assert Path(info["tracePath"]).exists()
    header = json.loads(Path(info["tracePath"]).read_text(encoding="utf-8").splitlines()[0])
    assert header["kind"] == "record.start" and header["media"] == "sohu"
    assert Path(getattr(session, "trace_path")).name == Path(info["tracePath"]).name, \
        "record.start 必须把 trace_path 指到录制轨迹文件"
    assert getattr(session, "recipe_id") == "sohu__publish-article"
    session.trace.extend(s for s in synthetic_trace() if record.is_recipe_step(s))
    st = record.status(session)
    assert st["stepCount"] == 7 and st["recording"] is True
    assert st["steps"][0]["type"] == "goto"
    assert st["diagnostics"]["steps"] == 7 and st["dispatcherGap"] is None
    # note / undo
    assert record.note(session, "人工备注")["index"] == len(session.trace) - 1
    assert st["stepCount"] == len(record.recipe_steps(session.trace))
    assert record.undo(session, 2)["removed"] == 2
    assert len(record.recipe_steps(session.trace)) == 5
    assert not any(s.get("type") == "note" for s in record.recipe_steps(session.trace))
    assert isinstance(record.summarize_step({"type": "click", "target": {"selector": "#b"}}), str)


# ---------------------------------------------------------------------------
# 5. 自愈候选选择（纯逻辑）
# ---------------------------------------------------------------------------
def _cand(**kw) -> dict:
    base = {"ref": "e1", "tag": "button", "role": "button", "text": "", "selector": "",
            "visible": True, "enabled": True, "box": [820, 40, 96, 36], "inFrame": "main"}
    base.update(kw)
    return base


@test
def test_heal_unique_high_confidence_wins():
    target = {"text": "发布", "role": "button"}
    cands = [
        _cand(ref="e1", text="取消", selector="#btn-cancel"),
        _cand(ref="e2", text="发布", selector="#btn-publish"),
    ]
    d = play.choose_heal_candidate(cands, target=target)
    assert d["ok"] is True, d
    assert d["ambiguous"] is False
    assert d["locator"] == {"selector": "#btn-publish"}
    assert d["locatorKind"] == "selector"
    assert d["score"] >= play.MIN_HEAL_SCORE
    assert "text-exact" in d["matchedOn"]


@test
def test_heal_refuses_when_ambiguous():
    target = {"text": "发布", "role": "button"}
    cands = [
        _cand(ref="e1", text="发布", selector="#btn-publish", box=[820, 40, 96, 36]),
        _cand(ref="e2", text="发布", selector="#btn-publish-top", box=[820, 8, 96, 36]),
    ]
    d = play.choose_heal_candidate(cands, target=target)
    assert d["ok"] is False
    assert d["ambiguous"] is True, "两个同分候选必须拒绝自愈"
    assert d["locator"] is None
    assert d["ranked"] and len(d["ranked"]) == 2
    assert "拒绝猜测" in d["reason"]


@test
def test_heal_refuses_low_score_and_invisible():
    target = {"text": "发布", "role": "button"}
    assert play.choose_heal_candidate([_cand(text="提交订单", selector="#x")], target=target)["ok"] is False
    assert play.choose_heal_candidate([], target=target)["ok"] is False
    invisible = [_cand(text="发布", selector="#btn-publish", visible=False)]
    assert play.choose_heal_candidate(invisible, target=target)["ok"] is False
    assert play.choose_heal_candidate(
        [_cand(text="发布", selector="#btn-publish")], target={})["ok"] is False, \
        "没有 target 线索时不应猜测"


@test
def test_heal_dedupes_same_element_from_two_sources():
    target = {"text": "发布", "role": "button"}
    cands = [
        _cand(ref="e1", text="发布", selector="#btn-publish"),
        _cand(ref="e9", text="发布", selector="#btn-publish", box=None),
    ]
    d = play.choose_heal_candidate(cands, target=target)
    assert d["ok"] is True, d
    assert d["considered"] == 1, "同一元素的两个来源应去重"


@test
def test_heal_by_selector_similarity_when_no_text():
    target = {"selector": "li.publish-report-btn.active"}
    cands = [_cand(text="", selector="li.publish-report-btn")]
    d = play.choose_heal_candidate(cands, target=target)
    assert d["ok"] is True, d
    assert d["locator"] == {"selector": "li.publish-report-btn"}
    assert d["matchedOn"] and d["matchedOn"][0].startswith("selector-jaccard")


@test
def test_heal_text_locator_when_candidate_has_no_selector():
    target = {"text": "我知道了"}
    cands = [_cand(text="我知道了", selector="", role="button")]
    d = play.choose_heal_candidate(cands, target=target)
    assert d["ok"] is True
    assert d["locatorKind"] == "text"
    assert d["locator"] == {"text": "我知道了", "exact": True, "role": "button"}
    plan = play._override_plan(3, {"type": "click", "target": {"text": "我知道了"}},
                              d["locator"], d["locatorKind"])
    assert plan["3.target.text"] == "我知道了"
    assert plan["3.target.selector"] is None, "降级为文本定位时必须清掉旧 selector（优先级高于 text）"
    # 覆盖计划必须完整还原「学到的定位器」
    step = {"type": "click", "target": {"role": "button", "text": "立即提交流程"}}
    plan2 = play._override_plan(9, step, {"text": "立即提交", "exact": True, "role": "button"},
                               "text")
    play._apply_overrides(step, 9, plan2)
    assert step["target"] == {"text": "立即提交", "exact": True, "role": "button"}, step
    # selector 计划：清掉低优先级的 text/role
    step3 = {"type": "click", "target": {"selector": "#old", "text": "发布", "role": "button"}}
    plan3 = play._override_plan(2, step3, {"selector": "#new"}, "selector")
    play._apply_overrides(step3, 2, plan3)
    assert step3["target"] == {"selector": "#new"}, step3


# ---------------------------------------------------------------------------
# 6. validate 必须抓到的三类问题
# ---------------------------------------------------------------------------
def _minimal_recipe(**overrides) -> dict:
    recipe = {
        "recipe_version": 1,
        "id": "unit__test",
        "media": "unit",
        "label": "单元测试",
        "account_codes": ["u-1"],
        "capabilities": {"editor": "none"},
        "session_check": {"url": "https://example.test/", "fail_if_url_contains": [],
                          "fail_if_text_contains": []},
        "params": [],
        "steps": [{"type": "goto", "url": "https://example.test/"}],
        "verify": {"mode": "none", "list_url": None, "title_match": "exact_normalized",
                   "status_regex": None, "accept_link_contains": [], "final_url_template": None},
        "overrides": {},
    }
    recipe.update(overrides)
    return recipe


@test
def test_validate_catches_unknown_step_type():
    recipe = _minimal_recipe(steps=[{"type": "teleport", "url": "https://x"}])
    report = play.validate_sync(recipe)
    assert report["ok"] is False
    hit = [i for i in error_issues(report) if i["code"] == "STEP_TYPE_UNSUPPORTED"]
    assert hit and hit[0]["stepIndex"] == 0


@test
def test_validate_catches_undeclared_param():
    recipe = _minimal_recipe(steps=[{"type": "type", "target": {"selector": "#t"},
                                    "text": "{{title}}"}])
    report = play.validate_sync(recipe)
    assert report["ok"] is False
    hit = [i for i in error_issues(report) if i["code"] == "PARAM_UNDECLARED"]
    assert hit and "title" in hit[0]["message"] and hit[0]["stepIndex"] == 0


@test
def test_validate_catches_missing_required_param():
    # 声明了必填参数，却没有任何步骤/块引用它 → 必填值无处投递
    recipe = _minimal_recipe(params=[{"name": "title", "type": "string", "required": True}])
    report = play.validate_sync(recipe)
    assert report["ok"] is False
    assert any(i["code"] == "PARAM_REQUIRED_UNUSED" for i in error_issues(report))
    # 运行期：必填参数未提供 → PARAM_MISSING
    ok_recipe = _minimal_recipe(
        params=[{"name": "title", "type": "string", "required": True}],
        steps=[{"type": "type", "target": {"selector": "#t"}, "text": "{{title}}"}])
    assert play.validate_sync(ok_recipe, require_submit=False)["ok"] is True
    try:
        play.resolve_param_values(ok_recipe, {})
    except Exception as exc:
        assert getattr(exc, "code", None) == "PARAM_MISSING", exc
        assert getattr(exc, "details", {}).get("missing") == ["title"]
    else:
        raise AssertionError("缺必填参数时必须抛 PARAM_MISSING")
    # 有默认值就不算缺
    assert play.resolve_param_values(
        {"params": [{"name": "d", "type": "string", "required": True, "default": "x"}]}, {}) == {"d": "x"}


@test
def test_validate_requires_submit_when_not_dry_run():
    recipe = _minimal_recipe(steps=[{"type": "click", "target": {"selector": "#b"}}])
    assert any(i["code"] == "SUBMIT_STEP_MISSING" for i in error_issues(play.validate_sync(recipe)))
    assert play.validate_sync(recipe, require_submit=False)["ok"] is True
    with_submit = _minimal_recipe(steps=[{"type": "click", "target": {"selector": "#b"},
                                          "submit": True}])
    assert play.validate_sync(with_submit)["ok"] is True
    # async 入口与 sync 同语义
    assert asyncio.run(play.validate(with_submit))["ok"] is True


@test
def test_validate_spec_example_recipe():
    """SPEC §3 的示例 recipe 必须零 error（这是契约自带的用例）。"""
    example = yaml.safe_load("""
recipe_version: 1
id: sohu__publish-article
media: sohu
label: 搜狐号发布图文
account_codes: [a-1]
capabilities:
  editor: quill
  cover: false
  free_gallery: true
  daily_limit: 5
session_check:
  url: https://mp.sohu.com/mpfe/v4/contentManagement/news/list
  fail_if_url_contains: [passport, login, sso]
  fail_if_text_contains: [扫码登录, 登录后继续]
params:
  - {name: title, type: string, required: true, max_len: 72}
  - {name: body, type: text, required: true, min_len: 1}
  - {name: declaration, type: enum, values: ["个人观点，仅供参考"], required: false, default: "个人观点，仅供参考"}
steps:
  - {type: goto, url: "https://mp.sohu.com/mpfe/v4/contentManagement/news/publish"}
  - {type: waitFor, for: {selector: "input[placeholder*='标题']"}, timeoutMs: 45000}
  - {type: type, target: {selector: "input[placeholder*='标题']"}, text: "{{title}}"}
  - {type: frame, frame: {urlContains: "editor"}}
  - {type: type, target: {selector: ".ql-editor"}, text: "{{body}}", mode: type}
  - {type: frame, frame: "main"}
  - {type: dispatch, target: {text: "{{declaration}}"}, event: click}
  - {type: click, target: {text: "发布"}, submit: true}
  - {type: waitFor, for: {urlContains: "/contentManagement/news/list"}, timeoutMs: 60000, optional: true}
  - {type: extract, spec: [{name: publishedUrl, from: {url: true}}]}
verify:
  mode: later_backfill
  list_url: https://mp.sohu.com/mpfe/v4/contentManagement/news/list
  title_match: exact_normalized
  status_regex: "已发布|审核中|发布成功"
  accept_link_contains: ["sohu.com"]
  final_url_template: null
overrides: {}
""")
    report = play.validate_sync(example)
    assert error_issues(report) == [], json.dumps(error_issues(report), ensure_ascii=False)


@test
def test_normalize_title_and_render_templates():
    assert play.normalize_title("中文域名.网址，有用吗？") == play.normalize_title("中文域名．网址有用吗")
    assert play.normalize_title("  A B_C ") == play.normalize_title("a b c")
    assert play.normalize_title("１２３") == play.normalize_title("123"), "全角数字要归一到半角"
    assert play.normalize_title("ＡＢＣ！") == play.normalize_title("abc")
    assert play.render_templates({"a": "{{x}}", "b": ["{{y}}!", "{{z}}"]}, {"x": 1, "y": "q"}) == \
        {"a": 1, "b": ["q!", "{{z}}"]}
    os.environ["MEDIA_TEST_TPL"] = "env-值"
    assert play.render_templates("{{env:MEDIA_TEST_TPL}}", {}) == "env-值"
    assert play.template_names({"s": ["{{a}}", "{{env:B}}", "{{c}}"]}) == {"a", "c"}


# ---------------------------------------------------------------------------
# 7. 浏览器冒烟：机制跑通（不带任何平台），dry_run 与真跑各一次
# ---------------------------------------------------------------------------
_SMOKE_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>replay-smoke</title></head><body>
<input id="title" placeholder="title">
<div id="body" contenteditable="true"></div>
<button id="decl" type="button">声明</button>
<button id="submit" type="button">发布</button>
<button id="go" type="button">立即提交</button>
<div id="result" data-state="idle">idle</div>
<script>
document.getElementById('decl').addEventListener('click', function () {
  this.dataset.clicked = 'yes'; this.textContent = '声明已选';
});
document.getElementById('submit').addEventListener('click', function () {
  var r = document.getElementById('result');
  r.setAttribute('data-state', 'published'); r.textContent = 'published';
});
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('result').setAttribute('data-heal', 'clicked');
});
</script></body></html>"""
_SMOKE_URL = "data:text/html;charset=utf-8," + quote(_SMOKE_HTML, safe="")


def smoke_recipe() -> dict:
    """一次性回放机制冒烟 recipe；只存在于内存，绝不写进 engine/recipes/。"""
    return {
        "recipe_version": 1,
        "id": "smoke__replay-machinery",
        "media": "smoke",
        "label": "回放机制冒烟（临时）",
        "account_codes": ["t-1"],
        "capabilities": {"editor": "contenteditable", "cover": False, "free_gallery": False,
                         "headless": True},
        "session_check": {"url": _SMOKE_URL, "fail_if_url_contains": ["passport"],
                          "fail_if_text_contains": ["请登录"]},
        "params": [
            {"name": "title", "type": "string", "required": True, "max_len": 72},
            {"name": "body", "type": "text", "required": True, "min_len": 1},
        ],
        "steps": [
            {"type": "goto", "url": _SMOKE_URL, "waitUntil": "domcontentloaded", "timeoutMs": 30000},
            {"type": "waitFor", "for": {"selector": "#title"}, "timeoutMs": 15000},
            {"type": "type", "target": {"selector": "#title"}, "text": "{{title}}",
             "mode": "fill", "timeoutMs": 10000},
            {"type": "type", "target": {"selector": "#body"}, "text": "{{body}}",
             "mode": "fill", "timeoutMs": 10000},
            {"type": "dispatch", "target": {"selector": "#decl"}, "event": "click", "timeoutMs": 10000},
            {"type": "eval", "purpose": "验证 act.dispatch 真的派发了原生 click",
             "expression": ("(() => { const d = document.getElementById('decl');"
                            " if (!d.dataset.clicked) throw new Error('dispatch 未触发');"
                            " return true; })()"), "timeoutMs": 10000},
            {"type": "click", "target": {"selector": "#submit"}, "submit": True, "timeoutMs": 10000},
            {"type": "waitFor", "for": {"text": "published"}, "timeoutMs": 5000, "optional": True},
            {"type": "extract", "spec": [{"name": "publishedUrl",
                                          "from": {"selector": "#result", "attr": "data-state"}}]},
            # 自愈用例（index 9）：页面只有 <button>立即提交</button>，标题写成「立即提交流程」，
            # 引擎所有降级定位都落空 → TARGET_NOT_FOUND → 用 candidates 里的唯一高置信候选自愈
            {"type": "click", "target": {"role": "button", "text": "立即提交流程"},
             "timeoutMs": 8000},
        ],
        "verify": {"mode": "none", "list_url": None, "title_match": "exact_normalized",
                   "status_regex": None, "accept_link_contains": [], "final_url_template": None},
        "overrides": {},
    }


_SMOKE_NEEDED = ("paths", "config_store", "browser", "actions", "observe", "fingerprint", "proxy_pool")


def _try_import(name: str) -> tuple[object, str | None]:
    """导入兄弟模块；返回 (module|None, error)。SyntaxError 等也算「未就绪」。"""
    try:
        return play._lazy(name), None
    except Exception as exc:  # noqa: BLE001 - 另一个 agent 可能正好在改文件
        return None, f"{name}: {type(exc).__name__}: {exc}"


def wait_for_siblings(limit_s: float | None = None) -> tuple[list[str], list[str]]:
    """兄弟模块是另一个 agent 并行写的：等一小会儿再决定是否 skip。

    返回 (缺失模块名, 导入错误描述)。注意这里**只影响测试是否跳过**，
    play.py 运行期遇到兄弟模块内部错误仍然是硬失败（不吞异常）。
    """
    if limit_s is None:
        try:
            limit_s = float(os.environ.get("MEDIA_TEST_WAIT_S", "60"))
        except Exception:
            limit_s = 60.0
    deadline = time.time() + max(0.0, limit_s)
    while True:
        missing: list[str] = []
        errors: list[str] = []
        for name in _SMOKE_NEEDED:
            mod, err = _try_import(name)
            if mod is None:
                missing.append(name)
                if err:
                    errors.append(err)
        if not missing or time.time() >= deadline:
            return missing, errors
        time.sleep(5)


@test
def test_browser_replay_machinery_smoke():
    if importlib.util.find_spec("playwright") is None:
        raise Skipped("未安装 playwright，浏览器冒烟测试跳过")
    missing, errors = wait_for_siblings()
    if missing:
        detail = ("；导入错误：" + " | ".join(errors)) if errors else ""
        raise Skipped(
            "兄弟模块尚未就绪（另一个 agent 并行实现中）：" + ", ".join(missing) + detail +
            f"；临时数据目录={TEST_DATA_DIR}。这是**阻塞项**：回放机制无法端到端验证。")

    paths = play._lazy("paths")
    config_store = play._lazy("config_store")

    # 注册一次性账号 + 一个空但合法的 storage_state（data: 页面无 cookie）
    config_store.upsert_account("t-1", "smoke", "冒烟账号", note="tests/test_recipes.py")
    state_path = Path(paths.account_state_path("t-1"))
    state_path.parent.mkdir(parents=True, exist_ok=True)
    if not state_path.exists():
        state_path.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")

    params = {"title": "回放机制冒烟标题", "body": "正文第一段。\n正文第二段，用来验证 type/fill 落到 contenteditable。"}

    dry = asyncio.run(play.run(smoke_recipe(), account_code="t-1", params=params, dry_run=True))
    assert dry["ok"] is True, dry
    # dryRun 契约：submit 及其后的步骤全部 skipped（上报而不是漏报），且 ok=true、没有任何 failed
    assert dry["dryRun"] is True
    assert dry["stoppedBeforeSubmit"] == 6, dry.get("stoppedBeforeSubmit")
    statuses = [s["status"] for s in dry["steps"]]
    assert statuses == ["ok"] * 6 + ["skipped"] * 4, statuses
    assert not any(s["status"] == "failed" for s in dry["steps"]), dry["steps"]
    assert all(s.get("reason") for s in dry["steps"][6:]), "跳过的步骤必须说明原因"
    assert dry["message"] and "没有发布任何内容" in dry["message"], dry.get("message")
    assert dry["failedStep"] is None
    # submit 之后的 extract 不执行 → 预演里不该有 publishedUrl（#result 仍是 idle）
    assert dry["publishedUrl"] is None, dry["publishedUrl"]
    assert Path(dry["runDir"]).exists() and Path(dry["artifacts"]["runJson"]).exists()
    assert dry["artifacts"]["screenshots"], "预演也必须留下截图证据"
    # 本机未配置代理池：必须直连 + 明确告警，而不是 PROXY_UNAVAILABLE
    assert any("直连" in w for w in dry["warnings"]), dry["warnings"]
    dry_json = json.loads(Path(dry["artifacts"]["runJson"]).read_text(encoding="utf-8"))
    assert dry_json["proxy"]["bound"] is False
    assert dry_json["warnings"], "run.json 必须带上 warnings"
    assert dry_json["dryRun"] is True and dry_json["stoppedBeforeSubmit"] == 6
    assert dry_json["ok"] is True

    real = asyncio.run(play.run(smoke_recipe(), account_code="t-1", params=params, dry_run=False))
    assert real["ok"] is True, real
    assert real["steps"][6]["status"] == "ok", real["steps"][6]
    assert real["publishedUrl"] == "published", \
        f"真发下 submit 必须被点：publishedUrl={real['publishedUrl']!r}"
    assert real["steps"][4]["status"] == "ok", "dispatch 原生事件未生效"
    assert real["steps"][5]["status"] == "ok", "dispatch 断言失败"
    assert real["artifacts"]["screenshots"], "run 目录必须留下截图证据"
    for shot in real["artifacts"]["screenshots"]:
        assert Path(shot).exists() and Path(shot).parent == Path(real["runDir"]) / "shots"
    payload = json.loads(Path(real["artifacts"]["runJson"]).read_text(encoding="utf-8"))
    assert payload["ok"] is True and payload["dryRun"] is False
    assert not (RECIPES_DIR / "smoke__replay-machinery.yaml").exists(), \
        "冒烟 recipe 绝不能落进 engine/recipes/"

    # --- 自愈：TARGET_NOT_FOUND → candidates 唯一高置信 → 学到新定位器 ---
    heal_real = asyncio.run(play.run(heal_recipe := smoke_recipe(), account_code="t-1",
                                     params=params, dry_run=False))
    assert heal_real["ok"] is True, heal_real
    assert heal_real["steps"][9]["status"] == "healed", heal_real["steps"][9]
    assert heal_real["healing"]["applied"], heal_real["healing"]
    applied = heal_real["healing"]["applied"][0]
    assert applied["ok"] is True and applied["stepIndex"] == 9
    # candidates 里 #go 自带稳定 id selector → 优先学 selector（SPEC 要求写 "<stepIndex>.target.selector"）
    assert applied["locatorKind"] == "selector", applied
    assert applied["locator"]["selector"] == "#go", applied
    assert applied["matchedOn"], applied
    # 学到的定位器必须落到 recipe.overrides + healing_log
    assert heal_recipe["overrides"]["9.target.selector"] == "#go"
    assert heal_recipe["overrides"]["9.target.text"] is None, "旧 text 必须清掉（selector 优先级更高）"
    assert heal_recipe["overrides"]["9.target.role"] is None
    assert heal_recipe["healing_log"][-1]["stepIndex"] == 9
    assert heal_recipe["healing_log"][-1]["matchedOn"]
    assert any("heal" in Path(s).name for s in heal_real["artifacts"]["screenshots"])
    assert any("heal" in Path(s).name for s in heal_real["artifacts"]["screenshots"])

    # --- 学到之后：第二次回放不再需要自愈（overrides 生效） ---
    again = asyncio.run(play.run(heal_recipe, account_code="t-1", params=params, dry_run=False))
    assert again["ok"] is True, again
    assert again["steps"][9]["status"] == "ok", again["steps"][9]
    assert not again["healing"]["applied"], "overrides 生效后不应再自愈"
    assert len(heal_recipe["healing_log"]) == 1


@test
def test_run_raises_proxy_unavailable_when_configured_but_dead():
    """配置了代理却拿不到 → 必须 PROXY_UNAVAILABLE，且不能伪装成登录态失效。"""
    missing = [n for n in ("paths", "config_store", "browser", "actions", "proxy_pool")
               if _try_import(n)[0] is None]
    if missing:
        raise Skipped("兄弟模块尚未就绪：" + ", ".join(missing))
    config_store = play._lazy("config_store")
    proxies = play._lazy("proxy_pool")
    before = config_store.load_proxies()
    try:
        cfg = json.loads(json.dumps(before))
        cfg.setdefault("extractors", {})["deadpool"] = {
            "type": "http",
            # 127.0.0.1:9 必然 connection refused → ProxyUnavailable（不需要真的网络）
            "url": "http://127.0.0.1:9/get?num=1",
            "method": "GET",
            "headers": {},
            "parse": "text",
            "text_regex": r"(?P<ip>[\d.]+):(?P<port>\d+)",
            "separator": ":",
        }
        config_store.save_proxies(cfg)
        if hasattr(proxies, "reset_cache"):
            proxies.reset_cache()
        recipe = smoke_recipe()
        recipe["account_codes"] = ["t-proxy"]
        try:
            asyncio.run(play.run(recipe, account_code="t-proxy",
                                 params={"title": "t", "body": "b"}, dry_run=True))
        except Exception as exc:  # ActionError
            assert getattr(exc, "code", None) == "PROXY_UNAVAILABLE", exc
            assert "登录" in str(exc), f"错误信息必须区分代理/登录态：{exc}"
            details = getattr(exc, "details", None) or {}
            assert details.get("policy") == "sticky"
            run_dir = Path(details.get("runDir")) if details.get("runDir") else None
            # run.json 必须留下证据（在 run 目录里找即可）
            runs = sorted(Path(os.environ["MEDIA_DATA_DIR"]).glob("runs/*/run.json"))
            assert runs, "失败也要留下 run.json 证据"
            payload = json.loads(runs[-1].read_text(encoding="utf-8"))
            assert payload["ok"] is False
            assert payload["error"]["code"] == "PROXY_UNAVAILABLE"
        else:
            raise AssertionError("配置了不可用代理时必须抛 PROXY_UNAVAILABLE")
    finally:
        config_store.save_proxies(before)
        if hasattr(play._lazy("proxy_pool"), "reset_cache"):
            play._lazy("proxy_pool").reset_cache()


# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------
def main() -> int:
    passed, failed, skipped = 0, 0, 0
    for fn in _TESTS:
        name = fn.__name__
        try:
            result = fn()
            if inspect.isawaitable(result):
                asyncio.run(result)
            print(f"PASS {name}")
            passed += 1
        except Skipped as exc:
            print(f"SKIP {name}: {exc}")
            skipped += 1
        except Exception:
            print(f"FAIL {name}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed, {skipped} skipped"
          f"  (data dir: {TEST_DATA_DIR})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Pure-logic tests for the engine (no browser, no network, no real data dir).

Two layers:

1. :func:`test_cli_selftest_passes` runs the engine's own ``--selftest`` in a subprocess and
   asserts the JSON report is all-green — that is the same gate CI uses.
2. The remaining ``test_*`` functions re-check the important invariants in-process so they can be
   run one by one while developing (and so a regression names a single behaviour).

Usage:
    python tests/test_selftest.py          # standalone, prints a summary, exits 0/1
    python -m pytest tests/test_selftest.py -q

``MEDIA_DATA_DIR`` is pointed at a throwaway temp dir *before* the engine is imported, so these
tests can never read or write the operator's real accounts/recipes/proxy state.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 必须在 import engine 之前：否则 paths.DATA_DIR 会指向真实数据目录
os.environ.setdefault("MEDIA_DATA_DIR", tempfile.mkdtemp(prefix="media-unittest-"))

from engine import actions, config_store, fingerprint, observe, paths, proxy_pool, rpc  # noqa: E402
from engine.session import ActionError  # noqa: E402


# --------------------------------------------------------------- CLI selftest

def test_cli_selftest_passes() -> dict:
    proc = subprocess.run([sys.executable, "-m", "engine.sessiond", "--selftest"],
                          cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out = proc.stdout.decode("utf-8", "replace").strip()
    assert out, f"selftest produced no stdout (exit {proc.returncode}): " \
                f"{proc.stderr.decode('utf-8', 'replace')[-800:]}"
    report = json.loads(out)
    failed = [c["name"] for c in report["checks"] if not c.get("ok")]
    assert report["ok"] is True, f"failing checks: {failed}"
    assert proc.returncode == 0, f"exit={proc.returncode}"
    assert report.get("chromium"), "chromium path should be detected"
    return {"passed": report["passed"], "total": report["total"]}


# ------------------------------------------------------------ pure behaviour

def test_rpc_codec_and_error_frames() -> dict:
    rid, method, params = rpc.decode_request('{"id":7,"method":"act.click","params":{"a":1}}')
    assert (rid, method, params) == (7, "act.click", {"a": 1})
    for bad in ("", "{", "[]", '{"id":1}', '{"method":"x","params":[]}'):
        try:
            rpc.decode_request(bad)
        except rpc.RpcError as exc:
            assert exc.code == "BAD_REQUEST", f"{bad!r} -> {exc.code}"
        else:
            raise AssertionError(f"decode_request accepted {bad!r}")
    frame = json.loads(rpc.encode_error(None, "TIMEOUT", "慢", {"x": object()}))
    assert frame["ok"] is False and frame["id"] is None
    assert frame["error"]["code"] == "TIMEOUT" and isinstance(frame["error"]["details"]["x"], str)
    assert "你好" in rpc.encode_response(1, {"t": "你好"}), "UTF-8 must not be escaped"
    assert "id" not in json.loads(rpc.encode_event("handoff", {"sessionId": "s1"}))
    return {"errorCodes": len(rpc.ERROR_CODES)}


def test_param_templating() -> dict:
    out = actions.resolve_params(
        {"a": "{{x}}", "b": ["{{env:MEDIA_TEST_ENV}}", "pre-{{x}}"], "n": "{{num}}"},
        {"x": "值", "num": 3})
    assert out["a"] == "值" and out["n"] == 3, f"type-preserving substitution: {out}"
    assert out["b"][1] == "pre-值", out["b"]
    assert actions.resolve_params("{{a}}", {"a": "{{b}}", "b": "ok"}) == "ok", "nested"
    try:
        actions.resolve_params("{{nope}}", {})
    except ActionError as exc:
        assert exc.code == "PARAM_MISSING"
    else:
        raise AssertionError("missing param must raise PARAM_MISSING")
    return {"ok": True}


def test_ref_downgrades_to_a_durable_target() -> dict:
    """ref 的两半契约：注册表留富描述符；进 recipe 的 target 里绝不能有 ref。"""
    class _Stub:
        refs = {"e3": {"selector": "#btn", "role": "button", "text": "发布", "nth": 0},
                "e4": {"role": "button", "text": "提交", "nth": 1}}
    durable = actions.normalize_target(_Stub(), {"ref": "e3"})
    assert durable == {"selector": "#btn"}, durable
    assert "ref" not in durable
    fallback = actions.normalize_target(_Stub(), {"ref": "e4"})
    assert fallback == {"role": "button", "text": "提交"}, fallback
    assert actions.normalize_target(_Stub(), {"text": "发布"}) == {"text": "发布"}
    assert actions.normalize_target(_Stub(), {"ref": "e9"}) == {"text": ""}
    return {"durable": durable, "fallback": fallback}


def test_snapshot_element_shape_matches_spec() -> dict:
    for raw in ({}, {"tag": "button"}, {"tag": "input", "box": "oops"},
                {"selector": "#x", "visible": False, "enabled": False}):
        item = observe.public_element(observe.describe_element(raw))
        for key in observe.ELEMENT_KEYS:
            assert key in item, f"{raw!r} missing {key!r}"
        assert isinstance(item["box"], list) and len(item["box"]) == 4
        assert all(isinstance(v, int) for v in item["box"])
    assert observe.ELEMENT_KEYS == ("ref", "tag", "role", "text", "selector", "visible",
                                    "enabled", "box", "inFrame")
    assert observe.public_element({})["enabled"] is True
    return {"keys": list(observe.ELEMENT_KEYS)}


def test_text_target_priority_order() -> dict:
    assert observe.TEXT_TIERS == ("interactive-exact", "any-exact",
                                  "interactive-substring", "any-substring")
    for token in observe.TEXT_TIERS:
        assert token in observe.TEXT_RESOLVE_JS, f"resolver missing tier {token}"
    assert "button" in observe.TEXT_INTERACTIVE_SELECTOR
    return {"tiers": list(observe.TEXT_TIERS)}


def test_alert_heuristics() -> dict:
    assert "验证码" in observe.detect_alerts("https://x/y", "验证码", "")
    assert observe.detect_alerts("https://mp.sohu.com/mpfe/v4/index", "搜狐号",
                                 "创作中心") == []
    assert "login-redirect" in observe.detect_alerts("https://mpfe/v4/login", "", "")
    return {"ok": True}


def test_fingerprint_stability_and_spread() -> dict:
    for key in ("user_agent", "locale", "timezone_id", "viewport",
                "device_scale_factor", "platform"):
        assert key in fingerprint.derive("a-1"), f"missing {key}"
    assert fingerprint.derive("a-1") == fingerprint.derive("a-1"), "must be deterministic"
    for prefix in ("smoke-", "a-", "c-", "x-"):
        uas = [fingerprint.derive(f"{prefix}{i}")["user_agent"] for i in (1, 2)]
        assert uas[0] != uas[1], f"{prefix}1 / {prefix}2 share a UA"
    slots = [fingerprint.profile_slot(f"y-{i}")
             for i in range(1, len(fingerprint.PROFILES) + 1)]
    assert sorted(slots) == list(range(len(fingerprint.PROFILES))), slots
    kept = fingerprint.realign_user_agent(fingerprint.derive("a-1"), "153.0.8010.12")
    far = fingerprint.realign_user_agent({"chrome_major": 120, "user_agent": "Chrome/120.0.0.0"},
                                         "153.0.8010.12")
    assert "Chrome/153" in far["user_agent"], "a far-off UA must be realigned"
    assert kept["user_agent"] == fingerprint.derive("a-1")["user_agent"]
    return {"profiles": len(fingerprint.PROFILES)}


def test_proxy_extractor_parsing_without_network() -> dict:
    cfg = {"default_policy": "sticky", "sticky_ttl_minutes": 30,
           "health_check": {"url": "http://127.0.0.1:1/", "timeout_ms": 200},
           "static": [], "account_policy": {}, "whitelist": []}
    fields = {"server": "{ip}:{port}", "username": "{user}", "password": "{pass}"}
    base = {"type": "http", "url": "http://fake/api", "method": "GET", "parse": "json",
            "json_path": "data.list", "fields": fields,
            "field_map": {"ip": "ip", "port": "port", "user": "user", "pass": "pass"},
            "cooldown_seconds": 0}
    body = json.dumps({"data": {"list": [{"ip": "1.2.3.4", "port": 8080,
                                         "user": "u", "pass": "p"}]}})
    proxy_pool.reset_cache()
    got = proxy_pool.fetch_from_extractor("t", base, cfg=cfg, fetcher=lambda *a: body)
    assert got["server"] == "http://1.2.3.4:8080" and got["password"] == "p"
    text_ext = {**base, "parse": "text", "separator": ":", "field_map": None}
    got2 = proxy_pool.fetch_from_extractor("t2", text_ext, cfg=cfg,
                                          fetcher=lambda *a: "5.6.7.8:3128:u2:p2\n")
    assert got2["server"] == "http://5.6.7.8:3128" and got2["username"] == "u2"
    try:
        proxy_pool.fetch_from_extractor("t3", base, cfg=cfg, fetcher=lambda *a: "not json")
    except proxy_pool.ProxyUnavailable:
        pass
    else:
        raise AssertionError("invalid JSON must raise ProxyUnavailable")
    return {"json": got["server"], "text": got2["server"]}


def test_bound_proxy_survives_without_an_extractor() -> dict:
    """回归：账号已绑定代理时，proxy.fetch 不得因为「没配提取器」而失败。"""
    original = json.loads(json.dumps(config_store.load_proxies()))
    try:
        config_store.save_proxies(json.loads(json.dumps(config_store.DEFAULT_PROXIES)))
        assert proxy_pool.extractor_candidates(config_store.load_proxies()) == []
        proxy_pool.bind("unit-1", {"server": "http://127.0.0.1:9", "username": "u",
                                   "password": "p", "source": "manual",
                                   "expiresAt": "2035-01-01T00:00:00"})
        fetched = proxy_pool.fetch_proxy("unit-1")
        assert fetched["server"] == "http://127.0.0.1:9" and fetched["source"] == "manual"
        assert fetched["password"] == "p", "password must come from secrets.yaml"
        assert proxy_pool.get_for_account("unit-1", "sticky")["server"] == "http://127.0.0.1:9"
        assert proxy_pool.get_for_account("unit-1", "direct") is None
        assert proxy_pool.get_for_account("unit-nobody", "sticky") is None, \
            "an unconfigured pool must degrade to direct, not raise"
        described = proxy_pool.describe("unit-1")
        assert described["bound"] and "password" not in described
    finally:
        proxy_pool.bind("unit-1", None)
        config_store.save_proxies(original)
    return {"ok": True}


def test_secrets_never_reach_accounts_yaml() -> dict:
    paths.ensure_dirs()  # 生成 .gitignore（首次运行才会写）
    config_store.upsert_account("unit-2", "sohu", "u2")
    config_store.save_account_proxy("unit-2", {"server": "http://1.1.1.1:8080",
                                              "username": "u", "password": "pw"})
    assert "password" not in paths.ACCOUNTS_YAML.read_text(encoding="utf-8").lower()
    assert "pw" not in paths.account_proxy_path("unit-2").read_text(encoding="utf-8")
    assert config_store.get_proxy_secret("http://1.1.1.1:8080", "u") == "pw"
    ignore = paths.GITIGNORE.read_text(encoding="utf-8")
    assert "secrets.yaml" in ignore and "accounts/*/proxy.json" in ignore
    config_store.remove_account("unit-2", purge_state=True)
    return {"ok": True}


def test_launch_args_and_init_script() -> dict:
    from engine import browser
    assert "--disable-blink-features=AutomationControlled" in browser.LAUNCH_ARGS
    assert browser.normalize_proxy(None) is None
    proxied = browser.normalize_proxy({"server": "1.2.3.4:80"})
    assert proxied["server"] == "http://1.2.3.4:80" and proxied["bypass"], proxied
    js = browser.init_script(fingerprint.derive("a-1"))
    for token in ("webdriver", "chrome.runtime", "plugins", "languages",
                  "gpuRenderer", "Notification", "__FP__"):
        if token == "__FP__":
            assert "__FP__" not in js, "the fingerprint payload must be substituted"
            continue
        assert token in js, f"init script missing {token}"
    return {"launchArgs": len(browser.LAUNCH_ARGS)}


def test_recipe_helper_roundtrip() -> dict:
    path = config_store.save_recipe({"id": "unit__x", "media": "unit", "steps": [{"type": "goto"}]})
    assert path.exists() and path.parent.name == "unit"
    data, found = config_store.load_recipe("unit__x")
    assert data["id"] == "unit__x" and found == path
    try:
        config_store.load_recipe("__missing__")
    except config_store.RecipeNotFound:
        pass
    else:
        raise AssertionError("RecipeNotFound expected")
    path.unlink()
    return {"ok": True}


# ----------------------------------------------------------------- standalone

def main() -> int:
    tests = [(name, fn) for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            detail = fn()
            print(f"[PASS] {name} :: {json.dumps(detail, ensure_ascii=False)}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"[FAIL] {name} :: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed "
          f"(MEDIA_DATA_DIR={os.environ['MEDIA_DATA_DIR']})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

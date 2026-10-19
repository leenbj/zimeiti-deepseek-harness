#!/usr/bin/env python3
"""真实无头浏览器冒烟测试：把脚本化的 NDJSON 序列灌进 ``engine.sessiond`` 的 stdin。

序列（SPEC §2.1）：
    engine.status → account.upsert ×2 → session.open(direct, headless)
    → act.goto(data:text/html…) → session.snapshot → act.click(text)
    → act.eval → session.snapshot → act.click(ref) → act.eval
    → session.screenshot → session.close

两种模式：
    python tests/smoke_browser.py            # 交互式：发一条读一条（默认）
    python tests/smoke_browser.py --piped    # 一次性灌入全部请求（验证顺序屏障）

退出码 0/1；所有断言失败都会打印实际收到的帧。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable

HTML = (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>冒烟</title></head>'
    '<body><h1 id="t">你好</h1>'
    "<button id=\"b\" onclick=\"window.__n=(window.__n||0)+1;"
    "document.title='clicked-'+window.__n\">发布</button>"
    '<input id="title-input" placeholder="请输入标题（5-72字）">'
    "</body></html>"
)
# 中文直接放进 data: URL：Chromium 内部会做百分号编码，这里保留原样以贴近需求描述
URL = "data:text/html;charset=utf-8," + urllib.parse.quote(HTML)
URL_RAW = "data:text/html," + HTML


def jline(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


class Engine:
    """一次性的 sessiond 子进程 + NDJSON 客户端。"""

    def __init__(self, data_dir: str):
        env = dict(os.environ)
        env["MEDIA_DATA_DIR"] = data_dir
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            [PY, "-m", "engine.sessiond"], cwd=str(ROOT), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1)
        self.events: list[dict] = []
        self.transcript: list[tuple[dict, dict]] = []
        self._rid = 0

    def send(self, method: str, params: dict | None = None, *, wait: bool = True) -> dict:
        self._rid += 1
        req = {"id": self._rid, "method": method, "params": params or {}}
        self.proc.stdin.write(jline(req))
        self.proc.stdin.flush()
        if not wait:
            return {}
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"engine closed stdout while waiting for {method}")
            frame = json.loads(line)
            if "event" in frame and "id" not in frame:
                self.events.append(frame)
                print(f"  ← event {frame['event']}: "
                      f"{json.dumps(frame.get('data'), ensure_ascii=False)[:160]}")
                continue
            self.transcript.append((req, frame))
            return frame

    def finish(self) -> tuple[int, str]:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        err = self.proc.stderr.read() or ""
        return self.proc.returncode, err


def expect(cond, msg, *, frames=None):
    if not cond:
        detail = ""
        if frames is not None:
            detail = "\n" + json.dumps(frames, ensure_ascii=False, indent=2)[:2000]
        raise AssertionError(msg + detail)


def pick_button(snapshot: dict) -> dict:
    for el in snapshot.get("interactive", []):
        if el.get("selector") == "#b" or el.get("text") == "发布":
            return el
    raise AssertionError("snapshot 里找不到「发布」按钮："
                         + json.dumps(snapshot.get("interactive"), ensure_ascii=False)[:800])


def show(label: str, frame: dict, *, full: bool = False) -> None:
    text = json.dumps(frame, ensure_ascii=False)
    if full or len(text) <= 900:
        print(f"{label}: {text}")
    else:
        print(f"{label}: {text[:900]}… ({len(text)} bytes)")


def run_interactive() -> int:
    tmp = tempfile.mkdtemp(prefix="media-smoke-")
    print(f"== 交互式冒烟测试 · MEDIA_DATA_DIR={tmp}")
    eng = Engine(tmp)
    try:
        st = eng.send("engine.status", {})
        show("engine.status", st)
        expect(st["ok"], "engine.status failed", frames=st)
        expect(st["result"]["sessions"] == 0, "fresh engine should have 0 sessions")

        for code, media in (("a-1", "sohu"), ("c-1", "csdn")):
            up = eng.send("account.upsert", {"code": code, "media": media,
                                            "account": f"{media}-测试"})
            expect(up["ok"], f"account.upsert {code} failed", frames=up)

        op = eng.send("session.open", {"accountCode": "a-1", "headless": True,
                                       "proxyPolicy": "direct"})
        show("session.open", op)
        expect(op["ok"], "session.open failed", frames=op)
        sid = op["result"]["sessionId"]
        expect(op["result"]["proxy"] is None, "proxyPolicy=direct must yield no proxy")
        fp_a = op["result"]["fingerprint"]

        go = eng.send("act.goto", {"sessionId": sid, "url": URL,
                                   "waitUntil": "domcontentloaded"})
        show("act.goto", go)
        expect(go["ok"], "act.goto failed", frames=go)

        snap = eng.send("session.snapshot", {"sessionId": sid, "maxElements": 60})
        expect(snap["ok"], "session.snapshot failed", frames=snap)
        s = snap["result"]
        print("snapshot.url   =", s["url"][:70])
        print("snapshot.title =", s["title"])
        print("snapshot.frames=", json.dumps(s["frames"], ensure_ascii=False))
        print("snapshot.textSample =", json.dumps(s["textSample"], ensure_ascii=False)[:200])
        print("snapshot.alerts =", s["alerts"])
        print("snapshot.screenshot =", s["screenshot"])
        print("snapshot.interactive =",
              json.dumps(s["interactive"], ensure_ascii=False, indent=1)[:1200])
        btn = pick_button(s)
        expect(btn["role"] == "button", f"button role: {btn}")
        expect(btn["visible"] is True and btn["enabled"] is True, f"button flags: {btn}")
        expect(btn["inFrame"] == "main", f"inFrame: {btn}")
        ref = btn["ref"]
        print(f">> 按钮 ref={ref} selector={btn['selector']} text={btn['text']}")
        expect("你好" in " ".join(s["textSample"]), "textSample must contain Chinese text")

        c1 = eng.send("act.click", {"sessionId": sid, "target": {"text": "发布"}})
        show("act.click by text", c1)
        expect(c1["ok"], "click by text failed", frames=c1)
        t1 = eng.send("act.eval", {"sessionId": sid,
                                   "expression": "() => document.title",
                                   "purpose": "verify text click"})
        expect(t1["ok"] and t1["result"]["data"]["result"] == "clicked-1",
               f"click by text did not fire: {t1}", frames=t1)
        print("act.eval after text click -> document.title =",
              t1["result"]["data"]["result"])

        # ref 在下一次 snapshot 前保持有效；再拍一次快照重新确认 ref
        snap2 = eng.send("session.snapshot", {"sessionId": sid, "maxElements": 60,
                                             "includeText": False})
        btn2 = pick_button(snap2["result"])
        print(f">> 第二次 snapshot 的按钮 ref={btn2['ref']}（应与上次一致：{ref}）")
        c2 = eng.send("act.click", {"sessionId": sid, "target": {"ref": btn2["ref"]}})
        show("act.click by ref", c2)
        expect(c2["ok"], "click by ref failed", frames=c2)
        t2 = eng.send("act.eval", {"sessionId": sid,
                                   "expression": "() => document.title",
                                   "purpose": "verify ref click"})
        expect(t2["ok"] and t2["result"]["data"]["result"] == "clicked-2",
               f"click by ref did not fire: {t2}", frames=t2)
        print("act.eval after ref click  -> document.title =",
              t2["result"]["data"]["result"])

        shot = eng.send("session.screenshot", {"sessionId": sid, "fullPage": False,
                                              "label": "smoke"})
        show("session.screenshot", shot)
        expect(shot["ok"], "screenshot failed", frames=shot)
        path = Path(shot["result"]["path"])
        expect(path.exists() and path.stat().st_size > 0,
               f"screenshot file missing/empty: {path}")
        print(f">> 截图 {path} ({path.stat().st_size} bytes)")

        cl = eng.send("session.close", {"sessionId": sid, "saveState": True})
        show("session.close", cl)
        expect(cl["ok"], "session.close failed", frames=cl)
        state = Path(cl["result"]["savedStatePath"] or "")
        expect(state.exists() and state.stat().st_size > 2,
               f"storage_state not saved: {state}")
        print(f">> storage_state {state} ({state.stat().st_size} bytes)")
        print(f"fingerprint(a-1) = {json.dumps(fp_a, ensure_ascii=False)}")
    finally:
        rc, err = eng.finish()
    tail = "\n".join(err.strip().splitlines()[-6:])
    print(f"== 子进程退出码 {rc}；stderr 末尾：\n{tail}")
    if rc != 0:
        return 1
    print("== 交互式冒烟测试通过")
    return 0


def run_piped() -> int:
    """一次性把全部请求灌进 stdin（不等待响应），验证顺序屏障。"""
    tmp = tempfile.mkdtemp(prefix="media-smoke-piped-")
    print(f"== 管道式冒烟测试 · MEDIA_DATA_DIR={tmp}")
    lines = [
        {"id": 1, "method": "engine.status", "params": {}},
        {"id": 2, "method": "account.upsert",
         "params": {"code": "a-1", "media": "sohu", "account": "管道测试"}},
        {"id": 3, "method": "session.open",
         "params": {"accountCode": "a-1", "headless": True, "proxyPolicy": "direct"}},
        {"id": 4, "method": "act.goto", "params": {"sessionId": "s1", "url": URL}},
        {"id": 5, "method": "session.snapshot", "params": {"sessionId": "s1",
                                                          "maxElements": 40}},
        {"id": 6, "method": "act.click",
         "params": {"sessionId": "s1", "target": {"text": "发布"}}},
        {"id": 7, "method": "act.click",
         "params": {"sessionId": "s1", "target": {"ref": "e1"}}},
        {"id": 8, "method": "act.eval", "params": {"sessionId": "s1",
                                                   "expression": "() => document.title"}},
        {"id": 9, "method": "session.screenshot", "params": {"sessionId": "s1",
                                                            "label": "piped"}},
        {"id": 10, "method": "session.close", "params": {"sessionId": "s1"}},
    ]
    env = dict(os.environ)
    env["MEDIA_DATA_DIR"] = tmp
    env["PYTHONIOENCODING"] = "utf-8"
    script = "".join(jline(x) for x in lines)
    proc = subprocess.run([PY, "-m", "engine.sessiond"], cwd=str(ROOT), env=env,
                          input=script, text=True, encoding="utf-8",
                          capture_output=True, timeout=180)
    frames = [json.loads(x) for x in proc.stdout.splitlines() if x.strip()]
    by_id: dict[int, dict] = {}
    events = []
    for f in frames:
        if "id" in f:
            by_id[f["id"]] = f
        else:
            events.append(f)
    for i in sorted(by_id):
        show(f"#{i} {lines[i-1]['method']}", by_id[i])
    print(f"events: {[e.get('event') for e in events]}")
    print("stderr tail:", "\n".join((proc.stderr or '').strip().splitlines()[-4:]))
    expect(proc.returncode == 0, f"piped run exit={proc.returncode}")
    expect(len(by_id) == len(lines), f"missing responses: got {sorted(by_id)}")
    for i in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10):
        expect(by_id[i].get("ok") is True,
               f"#{i} {lines[i-1]['method']} failed: {by_id[i]}")
    expect(by_id[8]["result"]["data"]["result"] == "clicked-2",
           "piped: two clicks should have fired (text then ref)",
           frames=by_id[8])
    shot = Path(by_id[9]["result"]["path"])
    expect(shot.exists() and shot.stat().st_size > 0, f"piped screenshot: {shot}")
    print(f">> 管道截图 {shot} ({shot.stat().st_size} bytes)")
    print("== 管道式冒烟测试通过（顺序屏障生效：s1 已存在才执行 act.*）")
    return 0


def run_isolation() -> int:
    """隔离证明：两个账号同时开会话，指纹/状态路径/context 互不相同且互不可见。"""
    tmp = tempfile.mkdtemp(prefix="media-isolation-")
    print(f"== 隔离验证 · MEDIA_DATA_DIR={tmp}")
    eng = Engine(tmp)
    try:
        for code, media in (("iso-a-1", "sohu"), ("iso-c-2", "csdn")):
            up = eng.send("account.upsert", {"code": code, "media": media,
                                            "account": f"{media}-隔离"})
            expect(up["ok"], f"account.upsert {code}", frames=up)
        a = eng.send("session.open", {"accountCode": "iso-a-1", "headless": True,
                                      "proxyPolicy": "direct"})
        b = eng.send("session.open", {"accountCode": "iso-c-2", "headless": True,
                                      "proxyPolicy": "direct"})
        expect(a["ok"] and b["ok"], "both sessions must open", frames=[a, b])
        ra, rb = a["result"], b["result"]
        expect(ra["sessionId"] != rb["sessionId"], "distinct session ids")
        print(f"session A = {ra['sessionId']} account={ra['accountCode']} "
              f"state={ra['storageStatePath']}")
        print(f"session B = {rb['sessionId']} account={rb['accountCode']} "
              f"state={rb['storageStatePath']}")
        print(f"fingerprint A = {json.dumps(ra['fingerprint'], ensure_ascii=False)}")
        print(f"fingerprint B = {json.dumps(rb['fingerprint'], ensure_ascii=False)}")
        expect(ra["storageStatePath"] != rb["storageStatePath"],
               "per-account state paths must differ")
        differing = [k for k in ra["fingerprint"] if ra["fingerprint"][k] != rb["fingerprint"][k]]
        expect(len(differing) >= 3,
               f"fingerprints should differ in several fields, got {differing}")
        print(f">> 指纹差异字段: {differing}")

        # 两个会话必须并行存活，且页面状态互不可见
        eng.send("act.goto", {"sessionId": ra["sessionId"], "url": URL, "waitUntil": "load"})
        eng.send("act.goto", {"sessionId": rb["sessionId"], "url": URL, "waitUntil": "load"})
        eng.send("act.eval", {"sessionId": ra["sessionId"],
                              "expression": "() => { window.__iso = 'A'; return 1; }"})
        probe = eng.send("act.eval", {"sessionId": rb["sessionId"],
                                      "expression": "() => String(window.__iso)"})
        expect(probe["result"]["data"]["result"] == "undefined",
               f"session B must not see session A's JS state: {probe}", frames=probe)
        ua_a = eng.send("act.eval", {"sessionId": ra["sessionId"],
                                     "expression": "() => navigator.userAgent"})
        ua_b = eng.send("act.eval", {"sessionId": rb["sessionId"],
                                     "expression": "() => navigator.userAgent"})
        real_a = ua_a["result"]["data"]["result"]
        real_b = ua_b["result"]["data"]["result"]
        print(f">> 运行中 UA A = {real_a}")
        print(f">> 运行中 UA B = {real_b}")
        expect(real_a != real_b, "the two live contexts must report different UAs")
        expect(real_a == ra["fingerprint"]["user_agent"],
               "the live UA must match the reported fingerprint")
        webdriver = eng.send("act.eval", {"sessionId": ra["sessionId"],
                                          "expression": "() => String(navigator.webdriver)"})
        expect(webdriver["result"]["data"]["result"] in ("undefined", "false"),
               f"navigator.webdriver must be neutralised: {webdriver}", frames=webdriver)
        lang = eng.send("act.eval", {"sessionId": ra["sessionId"],
                                     "expression": "() => navigator.languages.join(',')"})
        expect(lang["result"]["data"]["result"].startswith("zh-CN"),
               f"navigator.languages must be zh-CN first: {lang}", frames=lang)
        print(f">> navigator.webdriver = {webdriver['result']['data']['result']}; "
              f"languages = {lang['result']['data']['result']}")
        lst = eng.send("session.list", {})
        expect(len(lst["result"]["sessions"]) == 2,
               f"both sessions must be listed at once: {lst}", frames=lst)
        for sid in (ra["sessionId"], rb["sessionId"]):
            cl = eng.send("session.close", {"sessionId": sid, "saveState": True})
            expect(cl["ok"] and Path(cl["result"]["savedStatePath"]).exists(),
                   f"close {sid} must save its own state", frames=cl)
    finally:
        rc, err = eng.finish()
    print(f"== 子进程退出码 {rc}；stderr 末尾：\n" +
          "\n".join(err.strip().splitlines()[-3:]))
    if rc != 0:
        return 1
    print("== 隔离验证通过：不同账号 = 不同指纹 + 不同状态路径 + 互不可见的 context")
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if mode == "--piped":
            return run_piped()
        if mode == "--isolation":
            return run_isolation()
        return run_interactive()
    except AssertionError as exc:
        print(f"!! 断言失败: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(f"!! 冒烟测试异常: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""A deliberately badly-behaved engine stand-in, used by ``tests/engine-restart.mjs``.

The real engine is a long-lived child process, so the Node transport must survive the ways such a
process can misbehave: crashing mid-request, writing non-protocol noise to stdout, and emitting
unsolicited event frames. Reproducing those on demand is far more reliable than trying to crash the
real engine at the right moment, so this stub implements only the protocol edges under test.

Methods
-------
ping     -> {"ok": true, "result": {"pong": <count>}}
noise    -> writes a non-protocol line to stdout first, then answers normally
event    -> emits a ``progress`` event frame, then answers normally
slow     -> never answers (lets the caller kill the process mid-request)
die      -> exits the process with status 3 without answering
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time

# The transport writes NDJSON, so line buffering is not enough: force unbuffered text output.
try:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
except Exception:  # pragma: no cover
    pass

_pings = 0


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"flaky-engine: {message}\n")
    sys.stderr.flush()


log(f"started pid={os.getpid()}")

for raw in iter(sys.stdin.buffer.readline, b""):
    line = raw.decode("utf-8", "replace").strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        continue
    req_id = request.get("id")
    method = request.get("method")
    log(f"method={method}")

    if method == "ping":
        _pings += 1
        emit({"id": req_id, "ok": True, "result": {"pong": _pings, "pid": os.getpid()}})
    elif method == "noise":
        # A stray print in plugin code would land here. The transport must log it, not die.
        sys.stdout.write("this line is not JSON at all\n")
        sys.stdout.flush()
        emit({"id": req_id, "ok": True, "result": {"survivedNoise": True}})
    elif method == "event":
        emit({"event": "progress", "data": {"method": "event", "index": 7, "status": "running"}})
        emit({"id": req_id, "ok": True, "result": {"emitted": True}})
    elif method == "handoff":
        emit({"event": "handoff", "data": {
            "sessionId": "s1", "reason": "captcha",
            "hint": "请在浏览器窗口中完成人工操作（验证码/扫码），然后调用 session.resume"}})
        emit({"id": req_id, "ok": True, "result": {"ok": True}})
    elif method == "slow":
        # The real engine handles each request in its own asyncio task, so one slow method must NOT
        # block the others. Sleeping inline here would make the stub unresponsive in a way the real
        # engine never is, and would produce false failures in the transport tests.
        log("sleeping until killed (in a background thread, so the process stays responsive)")
        threading.Thread(target=time.sleep, args=(120,), daemon=True).start()
    elif method == "die":
        log("exiting with status 3 as requested")
        sys.stderr.flush()
        os._exit(3)
    else:
        emit({"id": req_id, "ok": False,
              "error": {"code": "UNKNOWN_METHOD", "message": f"unknown method {method!r}"}})

log("stdin closed; exiting")

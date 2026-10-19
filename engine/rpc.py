"""JSON-RPC（NDJSON）协议编解码、错误码、事件与 stdout 纪律（SPEC §2 / §6）。

约定：
  * stdout **只**允许协议帧（NDJSON），全部由 :func:`emit_frame` 写出；
  * 一切诊断信息走 :func:`log`（stderr）；
  * 任何一行坏请求都必须转成 ``ok:false`` 回应，绝不崩溃。
"""
from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

__all__ = [
    "RpcError", "ERROR_CODES", "encode_response", "encode_error", "encode_event",
    "decode_request", "log", "emit_frame", "configure_stdio", "dumps",
]

ERROR_CODES = (
    "BAD_REQUEST", "UNKNOWN_METHOD", "SESSION_NOT_FOUND", "TARGET_NOT_FOUND",
    "TIMEOUT", "PROXY_UNAVAILABLE", "LOGIN_REQUIRED", "RECIPE_INVALID",
    "PARAM_MISSING", "UNSUPPORTED", "INTERNAL",
)

_warned_codes: set[str] = set()


class RpcError(Exception):
    """协议层错误：带机器可读 code 与可选 details。"""

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = str(code or "INTERNAL")
        self.message = str(message)
        self.details = details or {}
        if self.code not in ERROR_CODES:
            _warn_once(f"unknown rpc error code {self.code!r}")


def _warn_once(msg: str) -> None:
    if msg not in _warned_codes:
        _warned_codes.add(msg)
        log(f"WARN {msg}")


def configure_stdio() -> None:
    """UTF-8 + LF，且不受 PYTHONIOENCODING 影响（Windows 关键修复）。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n", errors="replace")
        except Exception:  # pragma: no cover - 极少数被替换的流对象
            pass


def dumps(obj: Any) -> str:
    """协议 JSON：不转义中文，紧凑单行。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_fallback)


def _fallback(obj: Any) -> Any:
    try:
        return f"<{type(obj).__name__}>"
    except Exception:  # pragma: no cover
        return "<unserializable>"


def _scrub(details: Any, depth: int = 0) -> Any:
    """保证 details 一定可 JSON 序列化，且不无限递归。"""
    if depth > 6:
        return "<max-depth>"
    if details is None or isinstance(details, (bool, int, float, str)):
        return details
    if isinstance(details, dict):
        return {str(k): _scrub(v, depth + 1) for k, v in details.items()}
    if isinstance(details, (list, tuple, set)):
        return [_scrub(v, depth + 1) for v in details]
    return str(details)


def _to_id(req_id: Any) -> Any:
    if isinstance(req_id, bool) or req_id is None:
        return req_id
    if isinstance(req_id, int):
        return req_id
    if isinstance(req_id, str):
        return req_id
    if isinstance(req_id, float) and req_id.is_integer():
        return int(req_id)
    return str(req_id)


def encode_response(req_id: Any, result: Any) -> str:
    return dumps({"id": _to_id(req_id), "ok": True, "result": _scrub(result)})


def encode_error(req_id: Any, code: str, message: str,
                 details: dict | None = None) -> str:
    code = str(code or "INTERNAL")
    if code not in ERROR_CODES:
        _warn_once(f"unknown rpc error code {code!r}")
    return dumps({
        "id": _to_id(req_id),
        "ok": False,
        "error": {"code": code, "message": str(message), "details": _scrub(details or {})},
    })


def encode_event(name: str, data: dict) -> str:
    return dumps({"event": str(name), "data": _scrub(data or {})})


def decode_request(line: str) -> tuple[Any, str, dict]:
    """``(id, method, params)``；坏输入抛 :class:`RpcError` (BAD_REQUEST)。"""
    raw = (line or "").strip()
    if not raw:
        raise RpcError("BAD_REQUEST", "empty request line")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RpcError("BAD_REQUEST", f"invalid JSON: {exc.msg}",
                       {"line": raw[:200], "pos": exc.pos}) from exc
    if not isinstance(obj, dict):
        raise RpcError("BAD_REQUEST", "request must be a JSON object",
                       {"got": type(obj).__name__})
    req_id = obj.get("id")
    method = obj.get("method")
    if not isinstance(method, str) or not method:
        raise RpcError("BAD_REQUEST", "missing 'method'", {"keys": sorted(obj)[:20]})
    params = obj.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise RpcError("BAD_REQUEST", "'params' must be an object",
                       {"got": type(params).__name__})
    return req_id, method, params


# ---------------------------------------------------------------- stdout 纪律

_stdout_lock = threading.Lock()


def emit_frame(frame: str) -> None:
    """唯一允许写 stdout 的地方。"""
    with _stdout_lock:
        try:
            sys.stdout.write(frame.rstrip("\n") + "\n")
            sys.stdout.flush()
        except Exception as exc:  # pragma: no cover - 管道断开
            try:
                log(f"FATAL cannot write stdout frame: {exc!r}")
            except Exception:
                pass


def log(message: str, *, level: str = "INFO") -> None:
    """所有诊断信息 -> stderr（带毫秒时间戳）。"""
    try:
        ts = time.strftime("%H:%M:%S")
        ms = int((time.time() % 1) * 1000)
        sys.stderr.write(f"[{ts}.{ms:03d}] {level} {message}\n")
        sys.stderr.flush()
    except Exception:  # pragma: no cover
        pass

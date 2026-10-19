"""media-publish-plugin · Python 浏览器引擎包。

对外入口只有一个：``python -m engine.sessiond``（NDJSON JSON-RPC over stdio）。

模块边界见 ``docs/SPEC.md`` §6；本包只负责浏览器操作、账号隔离、代理绑定与
录制/回放的底层能力，不做新闻稿生成与 xlsx 流水线。
"""
from __future__ import annotations

__all__ = ["VERSION", "DATA_DIR"]

VERSION = "1.0.0"


def __getattr__(name: str):
    """``engine.DATA_DIR`` 懒解析，避免 import 顺序影响 MEDIA_DATA_DIR。"""
    if name == "DATA_DIR":
        from . import paths
        return paths.DATA_DIR
    raise AttributeError(name)

"""media-publish-plugin · Python 浏览器引擎包。

对外入口只有一个：``python -m engine.sessiond``（NDJSON JSON-RPC over stdio）。

模块边界见 ``docs/SPEC.md`` §6；本包只负责浏览器操作、账号隔离、代理绑定与
录制/回放的底层能力，不做新闻稿生成与 xlsx 流水线。
"""
from __future__ import annotations

import sys
from pathlib import Path

__all__ = ["VERSION", "DATA_DIR"]

VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# 自带依赖：插件必须能在「什么第三方包都没装」的解释器上跑起来。
#
# PyYAML 不是标准库，宿主运行时也不保证提供它 —— 实测 DSH 运行时升级后 ``yaml`` 与
# ``requests`` 一起消失，引擎在 import 阶段就崩，界面上只看到一句 ``ENGINE_EXITED``。
# 所以纯 Python 的 PyYAML 随插件分发（``engine/_vendor/yaml``），这里把它挂到
# ``sys.path`` **末尾**：解释器自带的优先（能用上用 C 加速的那份），缺失时才回落到随包副本。
#
# ``requests`` 则被彻底移除（见 ``proxy_pool.py``）：一个带 headers/timeout/代理的 HTTP 请求，
# 标准库 ``urllib.request`` 足够，没必要为它再拖 5 个传递依赖。
# ---------------------------------------------------------------------------
_VENDOR = Path(__file__).resolve().parent / "_vendor"
if _VENDOR.is_dir() and str(_VENDOR) not in sys.path:
    sys.path.append(str(_VENDOR))

try:
    import yaml as _yaml  # noqa: F401  (import 副作用即校验)
except ImportError as _exc:  # pragma: no cover - 只有随包副本也损坏时才会走到
    raise ImportError(
        "bundled PyYAML is missing or damaged, so the engine cannot start; "
        f"expected it at {_VENDOR / 'yaml'}. Reinstall the plugin bundle."
    ) from _exc


def __getattr__(name: str):
    """``engine.DATA_DIR`` 懒解析，避免 import 顺序影响 MEDIA_DATA_DIR。"""
    if name == "DATA_DIR":
        from . import paths
        return paths.DATA_DIR
    raise AttributeError(name)

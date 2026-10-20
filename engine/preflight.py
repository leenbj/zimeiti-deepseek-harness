"""启动前自检：把「引擎起不来」变成一句能照着做的提示。

依赖分两类：

1. **随包分发**（PyYAML）—— 系统升级不会再把它带走，因为代码在插件自己的目录里，
   不在宿主运行时的 site-packages 里。这里只校验它确实在。
2. **无法随包分发**（playwright 驱动）—— 它必须与宿主运行时匹配，体积也远超一个插件该带的量，
   只能由运行时提供。它缺失时引擎无法工作，但**必须报出可操作的原因**，而不是一段 traceback。

缺失时以退出码 78（``sysexits.h`` 的 ``EX_CONFIG``）退出，并在 stderr 打
``ENGINE_DEPENDENCY_MISSING <kind>: ...`` 与 ``HINT: ...`` 两行。宿主会把这两行原样放进错误信息的
「引擎日志尾部」里，所以操作者看到的就是该怎么修，而不是 ``ModuleNotFoundError``。
"""
from __future__ import annotations

import sys

# sysexits.h: 78 = EX_CONFIG，表示「配置/环境不对」，与普通崩溃区分开。
EX_CONFIG = 78


def _report(kind: str, message: str, hint: str) -> None:
    sys.stderr.write(f"ENGINE_DEPENDENCY_MISSING {kind}: {message}\n")
    sys.stderr.write(f"HINT: {hint}\n")
    sys.stderr.flush()


def ensure() -> dict:
    """校验引擎的硬依赖。不可恢复时以 78 退出；返回一份可诊断的快照。"""
    python = sys.executable
    info: dict[str, object] = {"python": python}

    # ---- 1. 随包分发的 PyYAML ----
    try:
        import yaml  # noqa: F401
    except ImportError as exc:  # pragma: no cover - 只有安装不完整时才会走到
        _report(
            "yaml",
            f"the bundled PyYAML is not importable ({exc})",
            "the plugin installation is incomplete; reinstall the plugin bundle "
            "(engine/_vendor/yaml should exist)",
        )
        raise SystemExit(EX_CONFIG) from exc
    info["yaml"] = getattr(yaml, "__version__", None)
    info["yamlBundled"] = "_vendor" in str(getattr(yaml, "__file__", ""))

    # ---- 2. 由宿主运行时提供的 playwright ----
    try:
        import playwright  # noqa: F401
        from playwright.async_api import Error as _PlaywrightError  # noqa: F401
    except ImportError as exc:
        _report(
            "playwright",
            f"{python} cannot import playwright ({exc})",
            'install it for that interpreter: "'
            + python
            + '" -m pip install playwright && "'
            + python
            + '" -m playwright install chromium',
        )
        raise SystemExit(EX_CONFIG) from exc
    info["playwright"] = True

    return info

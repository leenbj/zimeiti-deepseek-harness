"""账号 -> 稳定指纹（SPEC §4.1 / §6 fingerprint.py）。

同一账号 code 永远派生出同一套指纹；不同账号落在**不同的设备档案（profile）**上，
避免同一 IP 段下多账号指纹雷同。

分配规则（:func:`profile_slot`）：code 形如 ``前缀+数字``（``a-1``/``c-2``/``smoke-3``）时，
槽位 = ``hash(前缀) + 数字``，因此**同一前缀的相邻账号必然拿到相邻且不同的档案**；
不带数字的 code 用整体 HMAC 取槽位。所有取值只依赖 code 与固定密钥，绝不用时间/随机数。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
from typing import Any

__all__ = [
    "derive", "profile_slot", "PROFILES", "realign_user_agent", "accept_language",
    "languages_for", "summary", "to_public", "FINGERPRINT_KEYS", "DEFAULT_CHROME_MAJOR",
]

DEFAULT_CHROME_MAJOR = 153  # 与内置 chromium-1243 对齐；启动时按真实版本校正

FINGERPRINT_KEYS = (
    "user_agent", "locale", "timezone_id", "viewport", "device_scale_factor",
    "platform",
)

_WIN_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36")
_MAC_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X {osver}) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36")
_LINUX_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36")

_GPU_INTEL_UHD = ("Google Inc. (Intel)",
                  "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)")
_GPU_NVIDIA = ("Google Inc. (NVIDIA)",
               "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)")
_GPU_AMD = ("Google Inc. (AMD)",
            "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)")
_GPU_APPLE_M1 = ("Google Inc. (Apple)", "ANGLE (Apple, Apple M1, OpenGL 4.1)")
_GPU_APPLE_M2 = ("Google Inc. (Apple)", "ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)")
_GPU_MESA = ("Google Inc. (Mesa)", "ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)")

# 设备档案池：全部是真实存在的常见机型组合（OS × Chrome 主版本 × 分辨率 × 时区 × GPU）。
# Chrome 主版本刻意错开 1~2 个版本 —— 真实用户的 Chrome 是分批升级的，这比「所有人
# 都恰好是同一版本」更自然，也正好让不同账号的 UA 彼此不同（SPEC §4.1 的硬要求）。
PROFILES: tuple[dict[str, Any], ...] = (
    {"platform": "Win32", "ua_platform": "Windows", "major": 153,
     "ua": _WIN_UA, "os": None, "viewport": (1440, 900), "dsf": 1,
     "timezone_id": "Asia/Shanghai", "cores": 8, "memory": 8, "gpu": _GPU_INTEL_UHD},
    {"platform": "Win32", "ua_platform": "Windows", "major": 152,
     "ua": _WIN_UA, "os": None, "viewport": (1920, 1080), "dsf": 1,
     "timezone_id": "Asia/Chongqing", "cores": 12, "memory": 8, "gpu": _GPU_NVIDIA},
    {"platform": "Win32", "ua_platform": "Windows", "major": 153,
     "ua": _WIN_UA, "os": None, "viewport": (1366, 768), "dsf": 1,
     "timezone_id": "Asia/Urumqi", "cores": 8, "memory": 8, "gpu": _GPU_AMD},
    {"platform": "MacIntel", "ua_platform": "macOS", "major": 153,
     "ua": _MAC_UA, "os": "10_15_7", "viewport": (1512, 982), "dsf": 2,
     "timezone_id": "Asia/Shanghai", "cores": 8, "memory": 8, "gpu": _GPU_APPLE_M1},
    {"platform": "Win32", "ua_platform": "Windows", "major": 152,
     "ua": _WIN_UA, "os": None, "viewport": (1600, 900), "dsf": 1.25,
     "timezone_id": "Asia/Harbin", "cores": 16, "memory": 16, "gpu": _GPU_INTEL_UHD},
    {"platform": "MacIntel", "ua_platform": "macOS", "major": 152,
     "ua": _MAC_UA, "os": "10_15_7", "viewport": (1440, 900), "dsf": 2,
     "timezone_id": "Asia/Chongqing", "cores": 10, "memory": 8, "gpu": _GPU_APPLE_M2},
    {"platform": "Win32", "ua_platform": "Windows", "major": 153,
     "ua": _WIN_UA, "os": None, "viewport": (1536, 864), "dsf": 1.25,
     "timezone_id": "Asia/Shanghai", "cores": 12, "memory": 16, "gpu": _GPU_NVIDIA},
    {"platform": "Linux x86_64", "ua_platform": "Linux", "major": 152,
     "ua": _LINUX_UA, "os": None, "viewport": (1366, 768), "dsf": 1,
     "timezone_id": "Asia/Shanghai", "cores": 8, "memory": 8, "gpu": _GPU_MESA},
)

# 平台是中文站，locale 固定 zh-CN 才能与 languages / Accept-Language 自洽
_LOCALE = "zh-CN"

_MAJOR_RE = re.compile(r"Chrome/(\d+)")
_SUFFIX_RE = re.compile(r"^(?P<prefix>.*?)(?P<num>\d+)$")


def _secret() -> bytes:
    raw = os.environ.get("MEDIA_FP_SECRET", "").strip()
    if raw:
        return raw.encode("utf-8")
    # 非凭据：只是让指纹不可被外部按 code 猜出来
    return b"media-publish-plugin/fingerprint/v1"


def _hash_int(text: str) -> int:
    digest = hmac.new(_secret(), str(text).encode("utf-8"), hashlib.sha256).digest()
    return int.from_bytes(digest[:8], "big")


def profile_slot(code: str, pool_size: int = len(PROFILES)) -> int:
    """code -> 档案下标；``前缀+数字`` 的相邻账号必然落在不同槽位。"""
    if pool_size <= 0:
        raise ValueError("pool_size must be positive")
    key = str(code or "").strip() or "unnamed"
    m = _SUFFIX_RE.match(key)
    if m:
        # 同一前缀 + 递增数字 => 槽位递增 => 相邻账号一定不同（pool_size >= 2）
        return (_hash_int(m.group("prefix")) + int(m.group("num"))) % pool_size
    return _hash_int(key) % pool_size


def derive(code: str) -> dict:
    """``code -> {user_agent, locale, timezone_id, viewport, device_scale_factor, platform}``."""
    key = str(code or "").strip() or "unnamed"
    slot = profile_slot(key)
    p = PROFILES[slot]
    width, height = p["viewport"]
    gpu_vendor, gpu_renderer = p["gpu"]
    ua = str(p["ua"]).format(major=p["major"], osver=p["os"] or "10_15_7")
    return {
        "code": key,
        "profile_id": slot,
        "user_agent": ua,
        "locale": _LOCALE,
        "timezone_id": p["timezone_id"],
        "viewport": {"width": width, "height": height},
        "device_scale_factor": p["dsf"],
        "platform": p["platform"],
        "ua_platform": p["ua_platform"],
        "languages": languages_for(_LOCALE),
        "accept_language": accept_language(_LOCALE),
        "hardware_concurrency": p["cores"],
        "device_memory": p["memory"],
        "gpu_vendor": gpu_vendor,
        "gpu_renderer": gpu_renderer,
        "chrome_major": int(p["major"]),
    }


def languages_for(locale: str) -> list[str]:
    """locale 与 navigator.languages 必须自洽。"""
    base = str(locale or "zh-CN")
    short = base.split("-")[0] or "zh"
    out = [base]
    if short not in out:
        out.append(short)
    if "en" not in out:
        out.append("en")
    return out


def accept_language(locale: str) -> str:
    base = str(locale or "zh-CN")
    short = base.split("-")[0] or "zh"
    return f"{base},{short};q=0.9,en;q=0.8"


def realign_user_agent(fingerprint: dict, browser_version: str | None) -> dict:
    """按真实 chromium 版本校正 UA 主版本。

    档案本身就带 ``152/153`` 这类真实存在的相邻版本（真实用户分批升级），只要差距在
    ±2 以内就保留档案版本——既保证不同账号 UA 不同，又不会出现「UA 说 120、实际跑 153」
    这种一眼假的自相矛盾。
    """
    fp = dict(fingerprint)
    if not browser_version:
        return fp
    m = _MAJOR_RE.search(str(browser_version)) or re.match(r"^\s*(\d+)", str(browser_version))
    if not m:
        return fp
    major = int(m.group(1))
    try:
        own = int(fp.get("chrome_major") or major)
    except (TypeError, ValueError):
        own = major
    if abs(own - major) <= 2:
        return fp
    fp["user_agent"] = _MAJOR_RE.sub(f"Chrome/{major}", str(fp.get("user_agent", "")))
    fp["chrome_major"] = major
    return fp


def sec_ch_ua(fingerprint: dict) -> dict:
    """与 UA 自洽的 Client Hints 头（避免 sec-ch-ua 与 UA 版本打架）。"""
    fp = fingerprint or {}
    major = fp.get("chrome_major") or DEFAULT_CHROME_MAJOR
    platform = fp.get("ua_platform") or "Windows"
    return {
        "sec-ch-ua": f'"Google Chrome";v="{major}", "Chromium";v="{major}", "Not(A:Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": f'"{platform}"',
    }


def summary(fingerprint: dict) -> dict:
    """给 agent 看的短摘要（不含完整 UA）。"""
    fp = fingerprint or {}
    vp = fp.get("viewport") or {}
    return {
        "profileId": fp.get("profile_id"),
        "platform": fp.get("platform"),
        "locale": fp.get("locale"),
        "timezone_id": fp.get("timezone_id"),
        "viewport": f"{vp.get('width')}x{vp.get('height')}",
        "device_scale_factor": fp.get("device_scale_factor"),
        "ua_major": fp.get("chrome_major"),
    }


def to_public(fingerprint: dict) -> dict[str, Any]:
    return {k: fingerprint.get(k) for k in FINGERPRINT_KEYS}

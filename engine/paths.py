"""数据目录解析（SPEC §6 paths.py）。

所有运行时数据都放在包外（``MEDIA_DATA_DIR`` 或 ``~/.dsh/media-publish``），
便于升级与备份。本模块只做路径计算，不做 IO 之外的副作用。
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

__all__ = [
    "DATA_DIR", "ACCOUNTS_YAML", "PROXIES_YAML", "SECRETS_YAML", "GITIGNORE",
    "RECIPES_DIR", "BUILTIN_RECIPES_DIR", "RUNS_DIR", "TRACES_DIR", "ACCOUNTS_DIR",
    "PACKAGE_ROOT", "ensure_dirs", "account_dir", "account_state_path",
    "account_proxy_path", "account_shots_dir", "account_downloads_dir",
    "account_logs_dir", "account_profile_dir", "new_run_dir", "timestamp",
    "safe_slug", "write_gitignore",
]

PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def _resolve_data_dir() -> Path:
    raw = os.environ.get("MEDIA_DATA_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".dsh" / "media-publish").resolve()


DATA_DIR: Path = _resolve_data_dir()

ACCOUNTS_YAML: Path = DATA_DIR / "accounts.yaml"
PROXIES_YAML: Path = DATA_DIR / "proxies.yaml"
SECRETS_YAML: Path = DATA_DIR / "secrets.yaml"
GITIGNORE: Path = DATA_DIR / ".gitignore"

ACCOUNTS_DIR: Path = DATA_DIR / "accounts"
RECIPES_DIR: Path = DATA_DIR / "recipes"
BUILTIN_RECIPES_DIR: Path = PACKAGE_ROOT / "engine" / "recipes"
RUNS_DIR: Path = DATA_DIR / "runs"
TRACES_DIR: Path = DATA_DIR / "traces"
PROXIES_STATE_DIR: Path = DATA_DIR / "proxy_state"

_SLUG_RE = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._-]+")

# 需要 gitignore 的敏感路径（SPEC §4.2）
GITIGNORE_ENTRIES = (
    "secrets.yaml",
    "accounts/*/proxy.json",
    "accounts/*/storage_state.json",
    "accounts/*/profile/",
    "accounts/*/downloads/",
    "accounts/*/shots/",
    "accounts/*/logs/",
    "traces/",
    "runs/",
    "proxy_state/",
)


def ensure_dirs() -> None:
    """建好全部数据目录；幂等。"""
    for d in (DATA_DIR, ACCOUNTS_DIR, RECIPES_DIR, RUNS_DIR, TRACES_DIR,
              PROXIES_STATE_DIR):
        d.mkdir(parents=True, exist_ok=True)
    write_gitignore()


def write_gitignore() -> None:
    """生成/合并 .gitignore，保证 secrets.yaml 与 accounts/*/proxy.json 被忽略。"""
    try:
        existing = GITIGNORE.read_text(encoding="utf-8").splitlines() if GITIGNORE.exists() else []
    except OSError:
        existing = []
    have = {line.strip() for line in existing}
    added = [e for e in GITIGNORE_ENTRIES if e not in have]
    if added:
        lines = [line for line in existing if line.strip()]
        if lines:
            lines.append("")
        lines.append("# media-publish-plugin: 凭据与按账号数据（自动生成）")
        lines.extend(added)
        GITIGNORE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def account_dir(code: str) -> Path:
    """accounts/<code>/，并确保存在。"""
    d = ACCOUNTS_DIR / safe_slug(code)
    d.mkdir(parents=True, exist_ok=True)
    return d


def account_state_path(code: str) -> Path:
    return account_dir(code) / "storage_state.json"


def account_proxy_path(code: str) -> Path:
    return account_dir(code) / "proxy.json"


def account_shots_dir(code: str) -> Path:
    d = account_dir(code) / "shots"
    d.mkdir(parents=True, exist_ok=True)
    return d


def account_downloads_dir(code: str) -> Path:
    d = account_dir(code) / "downloads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def account_logs_dir(code: str) -> Path:
    d = account_dir(code) / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def account_profile_dir(code: str) -> Path:
    d = account_dir(code) / "profile"
    d.mkdir(parents=True, exist_ok=True)
    return d


def timestamp() -> str:
    """``20260909-101500``（本地时间）。"""
    return time.strftime("%Y%m%d-%H%M%S")


def safe_slug(text: str) -> str:
    """把任意文本变成可用作目录名的 slug（保留中文与 ``._-``）。"""
    s = _SLUG_RE.sub("_", (text or "").strip())
    s = s.strip("._-") or "unnamed"
    return s[:80]


def new_run_dir(recipe_id: str, code: str) -> Path:
    """``runs/<ts>-<recipe>-<code>/``；同一秒内多次调用也互不冲突。"""
    base = f"{timestamp()}-{safe_slug(recipe_id)}-{safe_slug(code)}"
    d = RUNS_DIR / base
    n = 1
    while d.exists():
        n += 1
        d = RUNS_DIR / f"{base}-{n}"
    for sub in ("shots", "logs", "downloads"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    return d

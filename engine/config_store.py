"""accounts.yaml / proxies.yaml / secrets.yaml / recipes 的读写（SPEC §1 §4 §6）。

原则：
  * ``accounts.yaml`` 只存身份（code/media/account/note），**绝不**出现代理密码；
  * 代理密码只落 ``secrets.yaml``（key = ``server|username``）；
  * 所有写入都是「临时文件 + 原子替换」，避免半截 YAML；
  * 缺省 proxies.yaml 返回 :data:`DEFAULT_PROXIES`（占位 extractor 默认禁用）。
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

import yaml

from . import paths

__all__ = [
    "ConfigError", "RecipeNotFound", "DEFAULT_PROXIES", "load_accounts",
    "save_accounts", "get_account", "list_accounts", "upsert_account",
    "remove_account", "load_proxies", "save_proxies", "load_secrets",
    "save_secrets", "set_proxy_secret", "get_proxy_secret", "proxy_secret_key",
    "load_recipe", "list_recipes", "save_recipe", "load_account_proxy",
    "save_account_proxy", "load_json", "save_json", "recipe_source",
]


class ConfigError(Exception):
    """配置文件损坏或不可写。"""


class RecipeNotFound(Exception):
    def __init__(self, recipe_id: str, searched: list[str] | None = None):
        super().__init__(f"recipe not found: {recipe_id}")
        self.recipe_id = recipe_id
        self.searched = searched or []


# 与 SPEC §4.2 对齐；extractors.apipool.url 留空 = 占位（等用户提供真实提取 URL）
DEFAULT_PROXIES: dict[str, Any] = {
    "default_policy": "sticky",
    "sticky_ttl_minutes": 30,
    "health_check": {"url": "https://api.ipify.org?format=json", "timeout_ms": 15000},
    "whitelist": [],
    "extractors": {
        "apipool": {
            "type": "http",
            "enabled": False,
            "note": "占位：等用户提供真实提取 URL 后填 url 并把 enabled 改 true",
            "url": "",
            "method": "GET",
            "headers": {},
            "parse": "json",
            "json_path": "data.list",
            "fields": {"server": "{ip}:{port}", "username": "{user}", "password": "{pass}"},
            "field_map": {"ip": "ip", "port": "port", "user": "user", "pass": "pass"},
            "text_regex": r"(?P<ip>[\d.]+):(?P<port>\d+):(?P<user>[^:]+):(?P<pass>.+)",
            "separator": ":",
            "respect_whitelist": False,
            "cooldown_seconds": 3,
        },
    },
    "static": [],
    "account_policy": {},
}


# ------------------------------------------------------------------ 基础 IO

def _read_yaml(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    if not raw.strip():
        return default
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise ConfigError(f"invalid YAML in {path}: {exc}") from exc
    if data is None:
        return default
    return data


def _write_yaml(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False)
    _atomic_write(path, text)


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise ConfigError(f"cannot write {path}: {exc}") from exc


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"invalid JSON in {path}: {exc}") from exc


def save_json(path: Path, data: Any) -> None:
    _atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


# -------------------------------------------------------------------- accounts

def load_accounts() -> dict:
    data = _read_yaml(paths.ACCOUNTS_YAML, {"accounts": []})
    if not isinstance(data, dict):
        raise ConfigError(f"{paths.ACCOUNTS_YAML}: top level must be a mapping")
    accs = data.get("accounts")
    if accs is None:
        data["accounts"] = []
    elif not isinstance(accs, list):
        raise ConfigError(f"{paths.ACCOUNTS_YAML}: 'accounts' must be a list")
    return data


def save_accounts(data: dict) -> None:
    """写 accounts.yaml；顺手剥掉任何代理/密码字段（凭据只允许在 secrets.yaml）。"""
    clean = dict(data or {})
    out = []
    for acc in clean.get("accounts", []) or []:
        if not isinstance(acc, dict):
            continue
        entry = {k: v for k, v in acc.items()
                 if k in ("code", "media", "account", "note", "createdAt", "lastRunAt")}
        entry.pop("proxy", None)
        entry.pop("password", None)
        if entry.get("code"):
            out.append(entry)
    clean["accounts"] = out
    _write_yaml(paths.ACCOUNTS_YAML, clean)


def list_accounts() -> list[dict]:
    return list(load_accounts().get("accounts", []))


def get_account(code: str) -> dict | None:
    want = str(code or "").strip()
    for acc in list_accounts():
        if str(acc.get("code", "")).strip() == want:
            return dict(acc)
    return None


def upsert_account(code: str, media: str, account: str = "", note: str = "") -> dict:
    code = str(code or "").strip()
    if not code:
        raise ConfigError("account code must not be empty")
    media = str(media or "").strip()
    if not media:
        raise ConfigError("account media must not be empty")
    data = load_accounts()
    entry = {"code": code, "media": media, "account": str(account or ""), "note": str(note or "")}
    accs = data.get("accounts", [])
    for i, acc in enumerate(accs):
        if str(acc.get("code", "")).strip() == code:
            merged = dict(acc)
            merged.update({k: v for k, v in entry.items() if v != "" or k in ("code", "media")})
            accs[i] = merged
            entry = merged
            break
    else:
        accs.append(entry)
    data["accounts"] = accs
    save_accounts(data)
    return entry


def remove_account(code: str, purge_state: bool = False) -> None:
    code = str(code or "").strip()
    data = load_accounts()
    data["accounts"] = [a for a in data.get("accounts", [])
                        if str(a.get("code", "")).strip() != code]
    save_accounts(data)
    if purge_state:
        target = paths.ACCOUNTS_DIR / paths.safe_slug(code)
        if target.exists() and target.is_dir() and target.parent == paths.ACCOUNTS_DIR:
            shutil.rmtree(target, ignore_errors=True)


# --------------------------------------------------------------------- proxies

def load_proxies() -> dict:
    data = _read_yaml(paths.PROXIES_YAML, None)
    if not isinstance(data, dict):
        return json.loads(json.dumps(DEFAULT_PROXIES))
    merged = json.loads(json.dumps(DEFAULT_PROXIES))
    deep_merge(merged, data)
    for key in ("default_policy", "sticky_ttl_minutes", "health_check", "extractors",
                "static", "account_policy", "whitelist"):
        if key in data:
            merged[key] = data[key]
    return merged


def deep_merge(base: dict, override: dict) -> dict:
    """递归合并：``override`` 里的叶子覆盖 ``base``。"""
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def save_proxies(data: dict) -> None:
    _write_yaml(paths.PROXIES_YAML, data)


# --------------------------------------------------------------------- secrets

def load_secrets() -> dict:
    data = _read_yaml(paths.SECRETS_YAML, {"proxy_passwords": {}})
    if not isinstance(data, dict):
        raise ConfigError(f"{paths.SECRETS_YAML}: top level must be a mapping")
    if not isinstance(data.get("proxy_passwords"), dict):
        data["proxy_passwords"] = {}
    return data


def save_secrets(data: dict) -> None:
    _write_yaml(paths.SECRETS_YAML, data)


def proxy_secret_key(server: str, username: str | None = None) -> str:
    return f"{str(server or '').strip()}|{str(username or '').strip()}"


def set_proxy_secret(server: str, username: str | None, password: str | None) -> None:
    data = load_secrets()
    key = proxy_secret_key(server, username)
    table = data.setdefault("proxy_passwords", {})
    if password is None or password == "":
        table.pop(key, None)
    else:
        table[key] = str(password)
    save_secrets(data)


def get_proxy_secret(server: str, username: str | None = None) -> str | None:
    table = load_secrets().get("proxy_passwords", {})
    for key in (proxy_secret_key(server, username), proxy_secret_key(server, None)):
        if key in table and table[key] not in (None, ""):
            return str(table[key])
    return None


# ------------------------------------------------------- account <-> proxy bind

def load_account_proxy(code: str) -> dict | None:
    p = paths.account_proxy_path(code)
    if not p.exists():
        return None
    data = load_json(p, None)
    if not isinstance(data, dict) or not data.get("server"):
        return None
    # 密码永不落 proxy.json
    data.pop("password", None)
    return data


def save_account_proxy(code: str, proxy: dict | None) -> None:
    p = paths.account_proxy_path(code)
    if proxy is None:
        if p.exists():
            p.unlink()
        return
    data = {
        "server": str(proxy.get("server", "")).strip(),
        "username": str(proxy.get("username", "") or "").strip(),
        "expiresAt": proxy.get("expiresAt"),
        "source": proxy.get("source"),
        "boundAt": proxy.get("boundAt"),
    }
    if proxy.get("password"):
        # 写入 secrets.yaml，而不是 proxy.json
        set_proxy_secret(data["server"], data["username"] or None, str(proxy["password"]))
    save_json(p, {k: v for k, v in data.items() if v not in (None, "")})


# --------------------------------------------------------------------- recipes

def _recipe_files() -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    for root, source in ((paths.RECIPES_DIR, "user"), (paths.BUILTIN_RECIPES_DIR, "builtin")):
        if not root.exists():
            continue
        for f in sorted(root.rglob("*.yaml")):
            out.append((f, source))
        for f in sorted(root.rglob("*.yml")):
            out.append((f, source))
    return out


def recipe_source(path: Path | str | None) -> str:
    """该 recipe 文件来自 ``user``（数据目录）还是 ``builtin``（包内）。"""
    if not path:
        return "unknown"
    p = Path(path)
    for root, source in ((paths.RECIPES_DIR, "user"), (paths.BUILTIN_RECIPES_DIR, "builtin")):
        try:
            p.resolve().relative_to(root.resolve())
            return source
        except (ValueError, OSError):
            continue
    return "unknown"


def load_recipe(recipe_id: str) -> tuple[dict, Path]:
    """用户目录优先，其次内置；找不到抛 :class:`RecipeNotFound`。

    关键：**整个 user 来源扫完才轮到 builtin**。用户录制的 recipe 落在
    ``recipes/<media>/<id>.yaml``（比内置深一层），如果按「先平铺后递归」两段快路径去
    找，内置会先命中并把用户录制结果挡在门外（曾经就是这个 bug）。
    """
    rid = str(recipe_id or "").strip()
    if not rid:
        raise RecipeNotFound(rid)
    searched: list[str] = []
    for root, _source in ((paths.RECIPES_DIR, "user"),
                          (paths.BUILTIN_RECIPES_DIR, "builtin")):
        # ① 显式路径（``<root>/<id>.yaml`` / ``<root>/<id>``，也支持 ``<root>/<media>/<id>.yaml``）
        for cand in (root / f"{rid}.yaml", root / f"{rid}.yml", root / rid):
            searched.append(str(cand))
            if cand.is_file():
                data = _read_yaml(cand, None)
                if not isinstance(data, dict):
                    raise ConfigError(f"{cand}: recipe must be a mapping")
                return data, cand
        # ② 该来源下的递归扫描（``recipes/<media>/<id>.yaml``）
        for f in sorted(list(root.rglob("*.yaml")) + list(root.rglob("*.yml"))):
            searched.append(str(f))
            if f.stem != rid:
                continue
            data = _read_yaml(f, None)
            if not isinstance(data, dict):
                raise ConfigError(f"{f}: recipe must be a mapping")
            return data, f
    raise RecipeNotFound(rid, searched)


def list_recipes() -> list[dict]:
    seen: dict[str, dict] = {}
    for f, source in _recipe_files():
        try:
            data = _read_yaml(f, {})
        except ConfigError:
            data = {}
        data = data if isinstance(data, dict) else {}
        rid = str(data.get("id") or f.stem)
        if rid in seen and seen[rid]["source"] == "user" and source != "user":
            continue
        if source == "user" or rid not in seen:
            seen[rid] = {
                "id": rid,
                "media": data.get("media") or f.parent.name,
                "label": data.get("label") or rid,
                "source": source,
                "path": str(f),
                "step_count": len(data.get("steps") or []),
            }
    return sorted(seen.values(), key=lambda r: (r["media"], r["id"]))


def save_recipe(recipe: dict, recipe_id: str | None = None) -> Path:
    data = dict(recipe or {})
    rid = str(recipe_id or data.get("id") or "").strip()
    if not rid:
        raise ConfigError("recipe id is required")
    data["id"] = rid
    media = paths.safe_slug(str(data.get("media") or "misc"))
    target = paths.RECIPES_DIR / media / f"{rid}.yaml"
    _write_yaml(target, data)
    return target

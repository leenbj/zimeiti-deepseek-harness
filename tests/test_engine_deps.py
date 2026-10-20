"""Engine dependency test — the engine must start with NOTHING installed but playwright.

The failure this locks down: `ModuleNotFoundError: No module named 'yaml'` at engine startup. PyYAML is
not part of the standard library, and a DSH runtime upgrade silently dropped both PyYAML and requests from
the interpreter the engine runs on. Because the engine process is long-lived, the breakage only appeared
the next time it had to start — and the operator saw nothing but `ENGINE_EXITED`.

Two guarantees are checked here:

1. **No engine module imports `requests`.** A request with headers, a timeout and proxy support needs only
   `urllib.request`; keeping requests would drag in urllib3, certifi, idna and charset_normalizer.
2. **The engine imports and parses its recipes on an interpreter with site-packages disabled**, where
   `import yaml` genuinely fails. The bundled pure-Python PyYAML is what has to satisfy it.

Run it as a script (pytest is not installed in this runtime):

    python tests/test_engine_deps.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
ENGINE = PLUGIN / "engine"
VENDOR = ENGINE / "_vendor"
FAILURES = 0

# The engine is a package rooted at the plugin directory, so the tests must be able to `import engine`.
if str(PLUGIN) not in sys.path:
    sys.path.insert(0, str(PLUGIN))


def check(ok: bool, label: str, detail: object = None) -> None:
    global FAILURES
    if not ok:
        FAILURES += 1
    suffix = "" if detail is None else f" — {detail!r}"
    print(f"{'PASS' if ok else 'FAIL'}  {label}{suffix}")


# --------------------------------------------------------------------------- 1. no requests
def test_no_requests() -> None:
    offenders = []
    for py in sorted(ENGINE.glob("*.py")):
        for number, line in enumerate(py.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("import requests") or stripped.startswith("from requests"):
                offenders.append(f"{py.name}:{number}")
    check(not offenders, "no engine module imports requests", offenders)

    import engine.proxy_pool as proxy_pool
    check(proxy_pool._http_fetcher.__name__ == "_http_fetcher",
          "the proxy fetcher is the standard-library implementation")


# --------------------------------------------------------------------------- 2. vendored payload
def test_vendored_payload() -> None:
    check(VENDOR.is_dir(), "the vendored dependency directory ships with the plugin", str(VENDOR))
    yaml_dir = VENDOR / "yaml"
    check(yaml_dir.is_dir(), "the bundled PyYAML package is present")
    if not yaml_dir.is_dir():
        return
    files = sorted(p.name for p in yaml_dir.glob("*.py"))
    check(len(files) >= 15, "it carries the full pure-Python implementation", len(files))
    for required in ("__init__.py", "loader.py", "dumper.py", "scanner.py", "parser.py", "constructor.py"):
        check(required in files, f"including {required}")
    binaries = [p.name for p in VENDOR.rglob("*") if p.suffix in (".pyd", ".so", ".dll")]
    check(not binaries, "no compiled binaries are shipped (they would be platform-specific)", binaries)
    check((VENDOR / "LICENSE-PyYAML.txt").is_file(), "the MIT licence travels with the code")


# --------------------------------------------------------------------------- 3. cold interpreter
PROBE = r"""
import json
import sys
from pathlib import Path

site = sys.argv[1]
if site:
    sys.path.append(site)

unavailable = []
for name in ("yaml", "requests", "urllib3", "certifi"):
    try:
        __import__(name)
    except ImportError:
        unavailable.append(name)

# Importing the engine package is what puts the bundled copy on sys.path (engine/__init__.py). This is the
# same order as the real entry point `python -m engine.sessiond`, where the package is imported first.
import engine.sessiond as sessiond
import engine.proxy_pool as proxy_pool
import engine.config_store as config_store
import engine.record as record
import yaml

out = {
    "unavailable": unavailable,
    "bare_yaml_failed": "yaml" in unavailable,
    "yaml_file": str(yaml.__file__),
    "yaml_version": yaml.__version__,
    "dependency_report": sessiond._dependency_report(),
    "recipes": sorted(p.name for p in (Path(sessiond.__file__).parent / "recipes").glob("*.yaml")),
}
print("RESULT " + json.dumps(out, ensure_ascii=False))
"""


def test_cold_interpreter() -> None:
    """Run the engine with site-packages disabled: yaml must come from the bundle."""
    import playwright

    site = str(Path(playwright.__file__).resolve().parent.parent)
    proc = subprocess.run(
        [sys.executable, "-S", "-c", PROBE, site],
        cwd=str(PLUGIN), capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        check(False, "the engine imports with site-packages disabled", (proc.stderr or "")[-600:])
        return
    check(True, "the engine imports with site-packages disabled")

    line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
    if line is None:
        check(False, "the probe reported its findings", proc.stdout[-400:])
        return
    data = json.loads(line[len("RESULT "):])

    check(data["bare_yaml_failed"] is True,
          "a bare `import yaml` really does fail there (so this is a real test)",
          data["unavailable"])
    check("yaml" in data["unavailable"],
          "yaml was unavailable to the interpreter before the engine took over",
          data["unavailable"])
    check("requests" in data["unavailable"], "and so was requests", data["unavailable"])
    check("_vendor" in Path(data["yaml_file"]).parts,
          "yaml was served by the bundled copy", data["yaml_file"])
    check(data["dependency_report"]["yaml"]["bundled"] is True,
          "engine.status reports the bundled origin", data["dependency_report"]["yaml"])
    check(data["dependency_report"]["yaml"]["version"],
          "and the version it loaded", data["dependency_report"]["yaml"].get("version"))
    check(data["dependency_report"]["requests"]["required"] is False,
          "requests is reported as no longer required")
    check(len(data["recipes"]) == 3, "all three builtin recipes are visible on the cold path",
          data["recipes"])


# --------------------------------------------------------------------------- 4. recipes actually parse
def test_recipes_parse() -> None:
    import yaml

    for path in sorted((ENGINE / "recipes").glob("*.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            check(False, f"{path.name} parses", repr(exc))
            continue
        ok = isinstance(data, dict) and bool(data.get("id")) and bool(data.get("steps"))
        check(ok, f"{path.name} parses into a recipe", None if ok else type(data).__name__)

    # Round-trip the exact dump the engine writes, including Chinese and nested flow structures.
    sample = {
        "accounts": [
            {"code": "a-1", "media": "sohu", "account": "搜狐号主号", "note": "每日限 5 篇"},
            {"code": "b-1", "media": "toutiao", "account": "13363632375", "note": ""},
        ]
    }
    dumped = yaml.safe_dump(sample, allow_unicode=True, sort_keys=False, default_flow_style=False)
    check(yaml.safe_load(dumped) == sample, "safe_dump/safe_load round-trips the accounts file")
    check("搜狐号主号" in dumped, "with unicode written literally, not escaped")


def test_preflight() -> None:
    """A missing dependency must produce an actionable line, not a traceback."""
    import engine.preflight as preflight

    # Healthy interpreter: preflight passes and reports nothing to stderr.
    info = preflight.ensure()
    check(info.get("yaml") is not None, "preflight sees the bundled PyYAML", info.get("yaml"))
    check(info.get("yamlBundled") is True, "and knows it is the bundled copy", info.get("yamlBundled"))
    check(info.get("playwright") is True, "preflight sees playwright")

    # Broken interpreter: no site-packages at all, so playwright cannot be imported.
    proc = subprocess.run(
        [sys.executable, "-S", "-c", "import engine.sessiond"],
        cwd=str(PLUGIN), capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    check(proc.returncode == preflight.EX_CONFIG,
          "a missing playwright exits with EX_CONFIG (78), not a generic crash", proc.returncode)
    err = proc.stderr or ""
    check("ENGINE_DEPENDENCY_MISSING playwright" in err,
          "and names the missing dependency", err.strip().splitlines()[:1])
    check("HINT:" in err, "and offers a fix")
    check("-m pip install playwright" in err, "with the exact install command")
    check("playwright install chromium" in err, "including the browser download")
    check("Traceback" not in err,
          "without dumping a traceback the operator cannot act on", err.strip().splitlines()[:1])

    # The report the host shows must distinguish bundled from external dependencies.
    import engine.sessiond as sessiond

    report = sessiond._dependency_report()
    check(report["yaml"]["bundled"] is True, "the report marks yaml as bundled")
    check(report["playwright"]["external"] is True, "and playwright as external", report["playwright"])
    check(report["chromium"]["external"] is True, "and chromium as external", report["chromium"])
    check(report["requests"]["required"] is False, "and requests as no longer required")


def main() -> int:
    test_no_requests()
    test_vendored_payload()
    test_cold_interpreter()
    test_recipes_parse()
    test_preflight()
    print()
    if FAILURES:
        print(f"{FAILURES} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

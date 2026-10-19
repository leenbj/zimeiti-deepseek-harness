#!/usr/bin/env python3
"""Run the engine's own ``--selftest`` and print a compact summary.

The engine prints a JSON report on stdout, but driving it from a shell risks encoding damage on
Windows (PowerShell redirection has historically written UTF-16, and the report contains Chinese
platform labels). Running it through this harness keeps the bytes intact and turns the report into
something readable, so it is the standard way to check the engine half.

Usage:
    python tests/run_selftest.py [--verbose]
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    verbose = "--verbose" in sys.argv[1:]
    proc = subprocess.run(
        [sys.executable, "-m", "engine.sessiond", "--selftest"],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout = proc.stdout.decode("utf-8", "replace").strip()
    stderr = proc.stderr.decode("utf-8", "replace").strip()

    if not stdout:
        print(f"selftest produced no stdout (exit {proc.returncode})")
        if stderr:
            print("--- stderr ---")
            print(stderr[-4000:])
        return proc.returncode or 1

    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        print(f"selftest stdout is not JSON ({exc}); raw output follows:")
        print(stdout[:4000])
        return 1

    checks = report.get("checks") or []
    failed = [c for c in checks if not c.get("ok")]
    print(
        f"engine selftest: ok={report.get('ok')} passed={report.get('passed')} "
        f"total={report.get('total')} ms={report.get('ms')} exit={proc.returncode}"
    )
    for key, value in report.items():
        if key not in {"checks", "ok", "passed", "total", "ms"}:
            print(f"  {key}: {json.dumps(value, ensure_ascii=False)}")

    for check in checks:
        mark = "PASS" if check.get("ok") else "FAIL"
        line = f"  [{mark}] {check.get('name')} ({check.get('ms')}ms)"
        if not check.get("ok") or verbose:
            line += f" :: {check.get('error') or json.dumps(check.get('detail'), ensure_ascii=False)}"
        print(line)

    if failed:
        print("\n--- failing check tracebacks ---")
        for check in failed:
            print(f"\n### {check.get('name')}")
            print(check.get("traceback") or check.get("error"))

    if stderr and (failed or verbose):
        print("\n--- engine stderr (tail) ---")
        print(stderr[-2000:])

    return 0 if report.get("ok") and proc.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

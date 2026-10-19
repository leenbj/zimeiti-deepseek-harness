"""login-probe regression test — the branch that decides "is this person signed in yet?".

Why this file exists: `_login_probe` shipped twice with a crash that nothing else caught.
 * First the probe read only the main document and only its first 20 000 characters, so a phone/SMS
   verification step inside an iframe was invisible and a sign-in was declared successful while the
   operator was still typing a code.
 * Then a `UnboundLocalError` (a dict written before it was declared) made every probe throw, which
   closed the sign-in window a couple of seconds after it opened and surfaced as an opaque INTERNAL error.

The engine self-test never exercised this function, so it stayed green through both. These cases drive it
with fake session/page objects — no browser, no network — and assert both the verdict and, crucially, that
it simply does not raise.

Run it as a script (pytest is not installed in this runtime):

    python tests/test_login_probe.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.sessiond import PLATFORMS, _login_probe  # noqa: E402

FAILURES = 0


def check(ok: bool, label: str, detail: Any = None) -> None:
    global FAILURES
    if not ok:
        FAILURES += 1
    suffix = "" if detail is None else f" — {detail!r}"
    print(f"{'PASS' if ok else 'FAIL'}  {label}{suffix}")


class FakeLocator:
    def __init__(self, count: int, visible: bool) -> None:
        self._count = count
        self._visible = visible

    @property
    def first(self) -> "FakeLocator":
        return self

    async def count(self) -> int:
        return self._count

    async def is_visible(self) -> bool:
        return self._visible


class FakeFrame:
    def __init__(self, html: str, fields: int = 0, visible: bool = True) -> None:
        self._html = html
        self._fields = fields
        self._visible = visible

    async def content(self) -> str:
        return self._html

    def locator(self, selector: str) -> FakeLocator:  # noqa: ARG002 - one stand-in for every selector
        return FakeLocator(self._fields, self._visible)


class FakePage:
    def __init__(self, html: str = "<html><body>ok</body></html>", body_len: int = 500,
                 title: str = "搜狐号", fields: int = 0, fields_visible: bool = True,
                 frame_html: str = "", selector_count: int = 1) -> None:
        self.main_frame = FakeFrame(html, fields, fields_visible)
        self.frames = [self.main_frame, FakeFrame(frame_html)] if frame_html else [self.main_frame]
        self._body_len = body_len
        self._title = title
        self._selector_count = selector_count

    async def content(self) -> str:
        return await self.main_frame.content()

    async def title(self) -> str:
        return self._title

    async def evaluate(self, expression: str) -> int:  # noqa: ARG002
        return self._body_len

    def locator(self, selector: str) -> FakeLocator:  # noqa: ARG002
        return FakeLocator(self._selector_count, True)


class FakeSession:
    def __init__(self, url: str, page: FakePage) -> None:
        self._url = url
        self.page = page

    def safe_url(self) -> str:
        return self._url


SOhu = PLATFORMS["sohu"]


async def probe(url: str, page: FakePage, signal: dict | None = None) -> dict:
    """Run one probe; a raised exception is turned into a sentinel so the test can report it."""
    try:
        return await _login_probe(FakeSession(url, page), SOhu, signal or {})
    except Exception as exc:  # the whole point: this must never happen
        return {"raised": f"{type(exc).__name__}: {exc}"}


async def main() -> int:
    # ---- 1. the basic verdicts ----
    ok = await probe("https://mp.sohu.com/mpfe/v4/index", FakePage(body_len=800))
    check("raised" not in ok, "a healthy page does not raise", ok.get("raised"))
    check(ok.get("loggedIn") is True, "a后台 page with content counts as signed in", ok.get("reasons"))
    check(ok.get("bodyTextLength") == 800, "the probe reports the body length it measured", ok.get("bodyTextLength"))

    offsite = await probe("https://example.com/", FakePage(body_len=800))
    check(offsite.get("loggedIn") is False, "a page outside the success domain is not signed in")
    check("raised" not in offsite, "and it does not raise either")

    on_login = await probe("https://mp.sohu.com/mpfe/v4/login", FakePage(body_len=800))
    check(on_login.get("loggedIn") is False, "the login URL is not signed in", on_login.get("reasons"))

    # ---- 2. the visible-verification rule (a hidden field must NOT block a finished sign-in) ----
    hidden = await probe("https://mp.sohu.com/mpfe/v4/contentManagement/first/page",
                         FakePage(body_len=1200, fields=2, fields_visible=False))
    check(hidden.get("loggedIn") is True,
          "an invisible verification field does not block a finished sign-in "
          "(this is the false negative that froze a real sign-in)", hidden.get("reasons"))

    shown = await probe("https://mp.sohu.com/mpfe/v4/index",
                        FakePage(body_len=1200, fields=1, fields_visible=True))
    check(shown.get("loggedIn") is False, "a VISIBLE verification field blocks it", shown.get("reasons"))

    # ---- 3. the risk-control rule: the right URL with an empty body is not a success ----
    intercepted = await probe("https://mp.sohu.com/mpfe/v4/index", FakePage(body_len=0))
    check(intercepted.get("loggedIn") is False,
          "a后台 URL with an empty body is treated as intercepted, not as success",
          intercepted.get("reasons"))
    check(any("正文为空" in r for r in intercepted.get("reasons", [])),
          "and it says so in the reasons", intercepted.get("reasons"))

    # ---- 4. the signal overrides still work end to end ----
    with_selector = await probe("https://mp.sohu.com/mpfe/v4/index", FakePage(body_len=800, selector_count=0),
                               {"selector": "#dashboard"})
    check(with_selector.get("loggedIn") is False, "a required selector that is missing blocks success")
    check(with_selector.get("selectorCount") == 0, "and the selector count is reported", with_selector.get("selectorCount"))

    with_text = await probe("https://mp.sohu.com/mpfe/v4/index", FakePage(body_len=800), {"text": "创作中心"})
    check(with_text.get("loggedIn") is False, "a required text that is absent blocks success")

    with_url = await probe("https://mp.sohu.com/mpfe/v4/index", FakePage(body_len=800), {"urlContains": "/home"})
    check(with_url.get("loggedIn") is False, "a required URL fragment that is absent blocks success")

    # ---- 5. text found only inside an iframe still counts (the original 20k/iframe bug) ----
    nested = await probe("https://mp.sohu.com/mpfe/v4/index",
                         FakePage(body_len=900, frame_html="<html><body>请输入验证码</body></html>"))
    check(nested.get("loggedIn") is False,
          "a failure marker inside an iframe is detected (frames are scanned)", nested.get("reasons"))

    print()
    if FAILURES:
        print(f"{FAILURES} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

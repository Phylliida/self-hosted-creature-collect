"""Fetch all listing search pages with zendriver (undetected chromium).

Fetches every source for both 1-bed and 2-bed filters. Failures per source
are tolerated (e.g. Cloudflare rate-limits) — the parse step just skips
missing/blocked pages. Usage: python scrape.py
"""
import asyncio
import glob
import os
import shutil
import zendriver as zd


def find_chrome():
    """Hardcoded nix-store chromium, else newest chromium in the store, else PATH."""
    hardcoded = "/nix/store/kvy6drb6mr45j7vjhl6dpy13c7kb66kj-chromium-148.0.7778.167/bin/chromium"
    if os.path.exists(hardcoded):
        return hardcoded
    candidates = sorted(glob.glob("/nix/store/*-chromium-*/bin/chromium"))
    if candidates:
        return candidates[-1]
    found = shutil.which("chromium") or shutil.which("google-chrome")
    if found:
        return found
    raise SystemExit("no chromium found — install one or fix the path in scrape.py")


CHROME = find_chrome()

SITES = {
    "rentcafe": "https://www.rentcafe.com/apartments-for-rent/eugene-or/2-bedroom/",
    "rentcafe_1br": "https://www.rentcafe.com/apartments-for-rent/eugene-or/1-bedroom/",
    "zillow": "https://www.zillow.com/eugene-or/apartments-2-bedrooms/",
    "zillow_1br": "https://www.zillow.com/eugene-or/apartments-1-bedrooms/",
    "craigslist": "https://eugene.craigslist.org/search/apa?min_bedrooms=2&max_bedrooms=2",
    "craigslist_1br": "https://eugene.craigslist.org/search/apa?min_bedrooms=1&max_bedrooms=1",
}
UO_BASE = "https://offcampushousing.uoregon.edu/housing/campus-UO+Campus_jtj6zh5"
UO_FILTERS = {"uo_offcampus": "beds-2", "uo_offcampus_1br": "beds-1"}


async def fetch(browser, name, url):
    try:
        page = await browser.get(url)
        await asyncio.sleep(10)
        for _ in range(6):
            await page.evaluate("window.scrollBy(0, 1500)")
            await asyncio.sleep(1.5)
        html = await page.get_content()
        title = await page.evaluate("document.title")
        if blocked(html, title):
            print(f"{name}: BLOCKED ({title!r}) — keeping previous {name}.html if any")
            return False
        with open(f"{name}.html", "w") as f:
            f.write(html)
        print(f"{name}: {len(html)} bytes, title={title!r}")
        return True
    except Exception as e:
        print(f"{name}: FAILED: {e}")
        return False


BLOCK_SIGNS = ("access to this page has been denied", "access denied",
               "attention required", "press & hold", "are you a robot",
               "captcha", "request blocked")


def blocked(html, title):
    if len(html) < 20000:
        return True
    hay = (html[:5000] + (title or "")).lower()
    return any(s in hay for s in BLOCK_SIGNS)


async def main():
    browser = await zd.start(
        browser_executable_path=CHROME,
        headless=True,
        browser_args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        for name, url in SITES.items():
            await fetch(browser, name, url)
            await asyncio.sleep(5)  # be polite, avoid rate-limiting
        for prefix, beds in UO_FILTERS.items():
            for p in range(1, 8):
                url = f"{UO_BASE}/{beds}" + (f"/page-{p}" if p > 1 else "")
                try:
                    page = await browser.get(url)
                    await asyncio.sleep(6)
                    n = await page.evaluate("document.querySelectorAll('fr-listing-card').length")
                    if not n:
                        print(f"{prefix} page {p}: 0 cards, done")
                        break
                    html = await page.get_content()
                    fn = f"{prefix}.html" if p == 1 else f"{prefix}_p{p}.html"
                    open(fn, "w").write(html)
                    print(f"{prefix} page {p}: {n} cards")
                except Exception as e:
                    print(f"{prefix} page {p}: FAILED: {e}")
                    break
    finally:
        await browser.stop()


if __name__ == "__main__":
    asyncio.run(main())

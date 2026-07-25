"""Fetch listing search pages with zendriver (undetected chromium)."""
import asyncio
import sys
import zendriver as zd

CHROME = "/nix/store/kvy6drb6mr45j7vjhl6dpy13c7kb66kj-chromium-148.0.7778.167/bin/chromium"

SITES = {
    "rentcafe": "https://www.rentcafe.com/apartments-for-rent/eugene-or/2-bedroom/",
    "apartments": "https://www.apartments.com/eugene-or/2-bedrooms/",
    "zillow": "https://www.zillow.com/eugene-or/apartments-2-bedrooms/",
}


async def fetch(name, url):
    browser = await zd.start(
        browser_executable_path=CHROME,
        headless=False,
        browser_args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        page = await browser.get(url)
        await asyncio.sleep(10)
        # scroll to trigger lazy loading
        for _ in range(6):
            await page.evaluate("window.scrollBy(0, 1500)")
            await asyncio.sleep(1.5)
        html = await page.get_content()
        with open(f"{name}.html", "w") as f:
            f.write(html)
        title = await page.evaluate("document.title")
        print(f"{name}: {len(html)} bytes, title={title!r}")
    finally:
        await browser.stop()


async def main():
    for name in sys.argv[1:] or SITES:
        await fetch(name, SITES[name])


if __name__ == "__main__":
    asyncio.run(main())

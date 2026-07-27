#!/usr/bin/env python3
"""Download a GTFS zip through a real browser (zendriver/undetected chromium).

Used by ingest-gtfs.py (browser fallback is on by default there) for feeds
plain HTTP clients (Akamai/Cloudflare "Access Denied" on CivicPlus city
sites, Cloudflare "Just a moment..." challenges, etc.). The block is usually
client-side bot detection, not a true geo block: a real browser from the
same IP gets the file fine.

Must run with a python that has zendriver installed (the housing-search venv:
housing-search/.venv/bin/python). Uses a headful chromium under Xvfb —
headless mode is what Cloudflare detects. If no DISPLAY is set (cron), an
Xvfb is spawned for the duration of the run.

Usage: browser-download.py <url> <dest.zip>
Exit 0 + a valid zip at dest on success; non-zero otherwise.

Chromium path: $GTFS_CHROME, else the nix-store chromium used by
housing-search/scrape_headful.py, else zendriver's own lookup.
"""
import asyncio
import base64
import os
import subprocess
import sys
import time
from urllib.parse import urlsplit

CHROME_DEFAULT = "/nix/store/kvy6drb6mr45j7vjhl6dpy13c7kb66kj-chromium-148.0.7778.167/bin/chromium"
BROWSER_ARGS = [
    "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
    "--disable-background-networking",
]
CHUNK = 256 * 1024          # base64 transfer chunk; spread-safe size
CHALLENGE_WAIT_S = 40       # max wait for a Cloudflare-style challenge to clear


def log(msg):
    print(f"[browser-dl] {msg}", file=sys.stderr, flush=True)


class Xvfb:
    def __init__(self):
        self.proc = None

    def __enter__(self):
        if os.environ.get("DISPLAY"):
            return self
        for disp in (99, 98, 97, 96):
            lock = f"/tmp/.X{disp}-lock"
            if os.path.exists(lock):
                continue
            self.proc = subprocess.Popen(
                ["Xvfb", f":{disp}", "-screen", "0", "1280x900x24"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.environ["DISPLAY"] = f":{disp}"
            time.sleep(1)
            log(f"spawned Xvfb on :{disp} (pid {self.proc.pid})")
            return self
        raise RuntimeError("no free X display for Xvfb")

    def __exit__(self, *exc):
        if self.proc:
            self.proc.terminate()
            self.proc.wait()
        return False


async def download(url, dest):
    import zendriver as zd

    kwargs = {}
    chrome = os.environ.get("GTFS_CHROME")
    if chrome or os.path.exists(CHROME_DEFAULT):
        kwargs["browser_executable_path"] = chrome or CHROME_DEFAULT
    browser = await zd.start(headless=False, browser_args=BROWSER_ARGS, **kwargs)
    try:
        root = f"{urlsplit(url).scheme}://{urlsplit(url).netloc}/"
        page = await browser.get(root)
        # Wait out a "Just a moment..." style challenge if one appears.
        deadline = time.time() + CHALLENGE_WAIT_S
        title = ""
        while time.time() < deadline:
            title = await page.evaluate("document.title") or ""
            if title and "moment" not in title.lower():
                break
            await asyncio.sleep(2)
        log(f"root page: {title!r}")

        js_fetch = """
        (async () => {
          try {
            const r = await fetch(%s);
            if (r.status !== 200) return {status: r.status};
            window.__dl = new Uint8Array(await r.arrayBuffer());
            return {status: r.status, size: window.__dl.length};
          } catch (e) { return {error: String(e)}; }
        })()
        """ % (repr(url),)
        res = await page.evaluate(js_fetch, await_promise=True)
        log(f"fetch: {res}")
        if not isinstance(res, dict) or res.get("status") != 200:
            return False
        size = res["size"]
        with open(dest, "wb") as f:
            for off in range(0, size, CHUNK):
                b64 = await page.evaluate(
                    "btoa(Array.from("
                    f"window.__dl.slice({off}, {off + CHUNK}), "
                    "c => String.fromCharCode(c)).join(''))")
                f.write(base64.b64decode(b64))
        return True
    finally:
        await browser.stop()


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    url, dest = sys.argv[1], sys.argv[2]
    try:
        with Xvfb():
            ok = asyncio.run(download(url, dest))
    except Exception as e:
        log(f"failed: {e}")
        return 1
    if not ok:
        return 1
    try:
        with open(dest, "rb") as f:
            if f.read(2) != b"PK":
                log("downloaded body is not a zip")
                return 1
    except OSError as e:
        log(f"output check failed: {e}")
        return 1
    log(f"OK -> {dest} ({os.path.getsize(dest)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

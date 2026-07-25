#!/usr/bin/env python3
"""Behavioral tests for the save-privacy hardening in run.py.

Covers, against a real Flask test client and a scratch saves dir:
  (1) TOFU name claiming — first tokened save claims a name (hash on
      disk, never the raw token), matching token keeps saving, wrong or
      missing token is rejected with 403
  (2) legacy clients — tokenless saves still work for UNCLAIMED names
      and never claim; the owner's first tokened save then locks it
  (3) short tokens (<16 chars) don't claim
  (4) gated-by-default reads — a process started WITHOUT CC_LAN=1 (i.e.
      any tunnel-facing or misconfigured instance) refuses /load and
      /save-names with 403 while /save keeps working; only CC_LAN=1
      (the firewalled home instance) serves reads
  (5) /load on the home instance returns the newest save INCLUDING the
      writeToken (that's how a fresh device re-learns it at home)
  (6) the request body size cap is configured

The scratch dir comes from CC_SAVES_DIR (must be exported before run.py
is imported), so the real saves/ is never touched.

Run: python3 tests/tofu-claims.test.py
(no env needed — it re-execs itself with a scratch CC_SAVES_DIR)
"""
import hashlib
import json
import os
import pathlib
import sys
import tempfile

if not os.environ.get("CC_SAVES_DIR"):
    # Re-exec ourselves with a scratch dir so a bare invocation is safe.
    scratch = tempfile.mkdtemp(prefix="cc-tofu-test-")
    os.environ["CC_SAVES_DIR"] = scratch
    os.execv(sys.executable, [sys.executable] + sys.argv)

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import run  # noqa: E402  (needs CC_SAVES_DIR set first)

SAVES = pathlib.Path(os.environ["CC_SAVES_DIR"])
assert run._SAVES_DIR == SAVES, "run.py must pick up CC_SAVES_DIR"

failed = passed = 0
def ok(cond, msg):
    global failed, passed
    if cond:
        passed += 1
    else:
        failed += 1
        print("FAIL:", msg)

client = run.app.test_client()

# ── (4a) fail-safe default: without CC_LAN=1 this import IS gated ──
ok(run._PUBLIC_INSTANCE is True, "no CC_LAN env -> instance is gated by default")
ok(client.get("/load?name=Whoever").status_code == 403,
   "default instance refuses /load before any setup")

# The rest of the suite exercises the HOME instance.
run._PUBLIC_INSTANCE = False
TOKEN = "tok_1234567890abcdef_secret"

def save(name, token=None, extra=None):
    payload = {"backupName": name, "captured": []}
    if token is not None:
        payload["writeToken"] = token
    if extra:
        payload.update(extra)
    return client.post("/save", json=payload)

# ── (1) TOFU claim lifecycle ──
r = save("TofuA", TOKEN)
ok(r.status_code == 200, f"first tokened save claims + succeeds (got {r.status_code})")
claims = json.loads((SAVES / ".claims.json").read_text())
ok("TofuA" in claims, "claim recorded in .claims.json")
ok(claims["TofuA"]["sha256"] == hashlib.sha256(TOKEN.encode()).hexdigest(),
   "claim stores the sha256 of the token")
ok(TOKEN not in (SAVES / ".claims.json").read_text(), "raw token never written to claims")

ok(save("TofuA", TOKEN).status_code == 200, "matching token keeps saving")
ok(save("TofuA", "tok_wrong_wrong_wrong").status_code == 403, "wrong token -> 403")
ok(save("TofuA").status_code == 403, "missing token on claimed name -> 403")
ok(len(list(SAVES.glob("TofuA_*.json"))) == 2, "rejected saves wrote no files")

# ── (2) legacy tokenless clients ──
ok(save("TofuLegacy").status_code == 200, "tokenless save allowed for unclaimed name")
claims = json.loads((SAVES / ".claims.json").read_text())
ok("TofuLegacy" not in claims, "tokenless save does not claim")
ok(save("TofuLegacy", TOKEN).status_code == 200, "owner's first tokened save claims it")
ok(save("TofuLegacy").status_code == 403, "…after which tokenless saves are rejected")

# ── (3) short tokens don't claim ──
ok(save("TofuShort", "abc").status_code == 200, "short-token save accepted")
claims = json.loads((SAVES / ".claims.json").read_text())
ok("TofuShort" not in claims, "short token (<16 chars) does not claim")

# ── (5) /load on the home instance returns token ──
r = client.get("/load?name=TofuA")
ok(r.status_code == 200, "home instance serves /load")
ok(r.get_json().get("writeToken") == TOKEN, "/load returns the save incl. writeToken")
r = client.get("/save-names")
ok(r.status_code == 200 and "TofuA" in r.get_json(), "home instance serves /save-names")
r = client.get("/extras")
ok(r.status_code == 200 and b"Extras workbench" in r.data
   and r.headers.get("Cache-Control") == "no-store",
   "home instance serves the /extras workbench (no-store)")

# ── (4b) gated (public/default) mode ──
run._PUBLIC_INSTANCE = True
try:
    ok(client.get("/load?name=TofuA").status_code == 403, "gated instance refuses /load")
    ok(client.get("/save-names").status_code == 403, "gated instance refuses /save-names")
    ok(client.get("/extras").status_code == 403, "gated instance refuses /extras")
    ok(save("TofuA", TOKEN).status_code == 200, "gated instance still accepts /save")
    ok(save("TofuA", "tok_wrong_wrong_wrong").status_code == 403,
       "gated instance still enforces claims")
finally:
    run._PUBLIC_INSTANCE = False

# ── (6) size cap configured ──
ok(run.app.config.get("MAX_CONTENT_LENGTH") == 64 * 1024 * 1024,
   "MAX_CONTENT_LENGTH capped at 64MB")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

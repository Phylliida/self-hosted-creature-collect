#!/usr/bin/env python3
"""Behavioral tests for the /gifts endpoint in run.py (gifts between players).

Against a real Flask test client and a scratch saves dir:
  (1) auth — needs a claimed name and its write token; wrong/missing → 403
  (2) the allowlist — created on first use from the names claimed so far;
      a name claimed later can't send or receive until it's added
  (3) a gift round trip — sender's outbox stored, recipient's inbox gets it,
      the players list excludes the caller
  (4) privacy — photo EXIF/APPn segments stripped, a sent pokémon loses
      its spawnId; its caughtAt (where/when it was caught, shown to the
      recipient) comes through with only the known, well-typed fields;
      the place keeps its POI's coordinates (bad ones are dropped)
  (5) rules — one gift per sender → recipient per day, retried uploads are
      idempotent, item counts 1/5/10/50 only, no passes, no gifts to
      yourself or unknown players, message capped at 140 characters
  (6) the inbox cursor — batches of 8 with `more`, then the rest; a new
      device (cursor 0) gets everything back

Run: python3 tests/gifts.test.py   (re-execs itself with a scratch CC_SAVES_DIR)
"""
import base64
import json
import os
import pathlib
import sys
import tempfile

if not os.environ.get("CC_SAVES_DIR"):
    scratch = tempfile.mkdtemp(prefix="cc-gifts-test-")
    os.environ["CC_SAVES_DIR"] = scratch
    os.execv(sys.executable, [sys.executable] + sys.argv)

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import run  # noqa: E402

SAVES = pathlib.Path(os.environ["CC_SAVES_DIR"])
failed = passed = 0


def ok(cond, msg):
    global failed, passed
    if cond:
        passed += 1
    else:
        failed += 1
        print("FAIL:", msg)


client = run.app.test_client()
TOK = {"Bees": "bees-token-0123456789", "Grak": "grak-token-0123456789",
       "Art2": "art2-token-0123456789", "Late": "late-token-0123456789"}


def save(name):
    r = client.post("/save", json={"backupName": name, "writeToken": TOK[name], "creatures": []})
    assert r.status_code == 200, r.get_json()


def sync(name, outbox=None, cursor=0, token=None):
    r = client.post("/gifts", json={"backupName": name, "writeToken": token or TOK[name],
                                    "cursor": cursor, "outbox": outbox or []})
    return r.status_code, r.get_json()


def jpeg_with_exif():
    app0 = b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    exif_payload = b"Exif\x00\x00GPSLatitude=45.5017;GPSLongitude=-73.5673"
    app1 = b"\xff\xe1" + (len(exif_payload) + 2).to_bytes(2, "big") + exif_payload
    com = b"\xff\xfe" + (9).to_bytes(2, "big") + b"comment"
    dqt = b"\xff\xdb" + (67).to_bytes(2, "big") + bytes(65)
    sos = b"\xff\xda" + (8).to_bytes(2, "big") + bytes(6)
    return b"\xff\xd8" + app0 + app1 + com + dqt + sos + b"\x12\x34\x56" + b"\xff\xd9"


def gift(gid, to, day="2026-10-14", **kw):
    g = {"id": gid, "to": to, "day": day, "createdAt": 1791936000000, "message": "hi!"}
    g.update(kw)
    return g


# ── (1) auth ──
for n in ("Bees", "Grak", "Art2"):
    save(n)
code, _ = sync("Bees", token="wrong-token-0123456789")
ok(code == 403, "wrong token → 403")
code = client.post("/gifts", json={"backupName": "Nobody", "writeToken": "x" * 20}).status_code
ok(code == 403, "unclaimed name → 403")
ok(client.post("/gifts", data="nope", content_type="text/plain").status_code == 400, "non-JSON → 400")

# ── (2) allowlist seeded from current claims; later claims aren't in it ──
code, body = sync("Bees")
ok(code == 200 and sorted(body["players"]) == ["Art2", "Grak"], f"players = the others ({body and body.get('players')})")
ok(json.loads((SAVES / ".gift-players.json").read_text()) == ["Art2", "Bees", "Grak"], "allowlist file created from the claims")
save("Late")
code, _ = sync("Late")
ok(code == 403, "a name claimed after the allowlist was made can't use gifts")
code, body = sync("Bees", [gift("g-late-000001", "Late")])
ok(body["rejected"] and body["rejected"][0]["error"] == "unknown player", "can't send to a player not on the allowlist")

# ── (3) round trip + (4) privacy ──
photo = "data:image/jpeg;base64," + base64.b64encode(jpeg_with_exif()).decode()
creature = {"id": "c-1", "speciesA": 1, "speciesB": 4, "level": 12, "shinyVariant": 0,
            "spawnId": "1355017:1064327:29865600:0",
            "caughtAt": {"timestamp": 1791900000000, "lat": 45.5017, "lng": -73.5673,
                         "poi": {"name": " Café X ", "lat": 45.5018, "lng": -73.5674, "distanceM": 12.5,
                                 "extra": "<script>"},
                         "place": {"city": "Montréal", "country": 7}, "secret": "drop me"}}
g1 = gift("g-bees-grak-01", "Grak", message="x" * 300, photo=photo, creature=creature,
          item={"key": "great_ball", "count": 5},
          place={"name": "Parc Jarry", "category": "park", "lat": 45.5341, "lng": -73.6276, "x": 1})
code, body = sync("Bees", [g1])
ok(code == 200 and body["accepted"] == ["g-bees-grak-01"] and not body["rejected"], f"gift accepted ({body})")
code, body = sync("Grak")
ok(code == 200 and len(body["inbox"]) == 1, "recipient's inbox has it")
got = body["inbox"][0]
ok(got["from"] == "Bees" and got["to"] == "Grak" and got["item"] == {"key": "great_ball", "count": 5}
   and got["place"] == {"name": "Parc Jarry", "category": "park", "lat": 45.5341, "lng": -73.6276},
   f"sender, item and place (with its spot) come through ({got['place']})")
ok(len(got["message"]) == 140, "message capped at 140 characters")
raw = base64.b64decode(got["photo"].split(",", 1)[1])
ok(raw.startswith(b"\xff\xd8") and b"Exif" not in raw and b"GPS" not in raw and b"comment" not in raw
   and b"JFIF" in raw and raw.endswith(b"\x12\x34\x56\xff\xd9"), "photo EXIF/GPS and comments stripped, image kept")
ok("spawnId" not in got["creature"]
   and got["creature"]["speciesA"] == 1 and got["creature"]["level"] == 12, "pokémon keeps its species/level, loses its spawn cell")
ok(got["creature"].get("caughtAt") == {
       "timestamp": 1791900000000, "lat": 45.5017, "lng": -73.5673,
       "poi": {"name": "Café X", "lat": 45.5018, "lng": -73.5674, "distanceM": 12.5},
       "place": {"city": "Montréal", "country": None}},
   f"where/when it was caught comes through, known fields only ({got['creature'].get('caughtAt')})")
ok(sorted(body["players"]) == ["Art2", "Bees"], "players list excludes the caller")
ok(body["cursor"] == got["serverMs"] and body["more"] is False, "cursor moves to the last gift")
code, body = sync("Grak", cursor=body["cursor"])
ok(code == 200 and body["inbox"] == [], "nothing new after the cursor")

# ── (5) rules ──
code, body = sync("Bees", [gift("g-bees-grak-02", "Grak")])
ok(body["rejected"] and "already sent" in body["rejected"][0]["error"], "one gift per recipient per day")
code, body = sync("Bees", [g1])
ok(body["accepted"] == ["g-bees-grak-01"], "a retried upload of the same gift is accepted again")
ok(len(run._read_gift_index("Grak")) == 1, "…without storing it twice")
# (also: junk where-caught and an off-the-map place spot are dropped, below)
code, body = sync("Bees", [gift("g-bees-grak-03", "Grak", day="2026-10-15",
                               creature={"speciesA": 2, "speciesB": 3, "level": 5,
                                         "caughtAt": {"lat": "45", "poi": "x", "place": [], "timestamp": True}},
                               place={"name": "Somewhere", "lat": 999, "lng": -73.6})])
ok(body["accepted"] == ["g-bees-grak-03"], "a different day is fine")
cases = [
    (gift("g-bad-count-01", "Art2", item={"key": "poke_ball", "count": 3}), "bad item"),
    (gift("g-bad-pass-001", "Art2", item={"key": "community_pass", "count": 1}), "passes can't be gifted"),
    (gift("g-self-000001", "Bees"), "unknown player"),
    (gift("g-photo-00001", "Art2", photo="data:image/png;base64,AAAA"), "photo must be a JPEG under ~450 KB"),
    (gift("g-photo-00002", "Art2", photo="data:image/jpeg;base64," + base64.b64encode(b"not a jpeg").decode()), "photo is not a JPEG"),
    (gift("bad id!", "Art2"), "bad gift id"),
    (gift("g-day-000001", "Art2", day="14/10/2026"), "bad day"),
]
code, body = sync("Bees", [c for c, _ in cases])
errs = {r["id"]: r["error"] for r in body["rejected"]}
for c, want in cases:
    ok(errs.get(c["id"]) == want, f"{c['id']}: {want} (got {errs.get(c['id'])})")
ok(not body["accepted"], "none of the bad gifts went through")

# ── (6) cursor batches; a new device gets everything back ──
for k in range(11):
    code, body = sync("Art2", [gift(f"g-art2-many-{k:02d}", "Grak", day=f"2026-11-{k + 1:02d}")])
    assert body["accepted"], body
code, b1 = sync("Grak", cursor=0)
ok(len(b1["inbox"]) == 8 and b1["more"] is True, "first batch of 8, more to come")
code, b2 = sync("Grak", cursor=b1["cursor"])
ok(len(b2["inbox"]) == 5 and b2["more"] is False, "then the remaining 5 (13 in all)")
ids = [g["id"] for g in b1["inbox"] + b2["inbox"]]
ok(len(set(ids)) == 13, "no gift delivered twice across batches")
ms = [g["serverMs"] for g in b1["inbox"] + b2["inbox"]]
ok(ms == sorted(ms) and len(set(ms)) == len(ms), "serverMs strictly increasing per recipient")
g3 = next(g for g in b1["inbox"] + b2["inbox"] if g["id"] == "g-bees-grak-03")
ok("caughtAt" not in g3["creature"] and g3["creature"]["speciesA"] == 2, "junk where-caught is dropped, pokémon kept")
ok(g3["place"] == {"name": "Somewhere", "category": ""}, f"an off-the-map place spot is dropped ({g3['place']})")

# The gifts folder doesn't look like a save to /load.
ok(not list(SAVES.glob("gifts_*.json*")), "gifts never land where saves are listed")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

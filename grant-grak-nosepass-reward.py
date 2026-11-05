#!/usr/bin/env python3
"""Grak's second Nosepass completion reward, delivered as a gift.

Background (poke board task 6): Grak claimed the one-time 100%-completion egg
for Nosepass back when the dex only had 150 species. He then finished the
Nosepass row again on the bigger dex, but `completionRewards.claimed` already
held 325, so no second egg. This hands him the one he missed.

Why a gift and not a save edit: a patched save only reaches his phone through
Settings -> Load, and the task asks for no load. The gifts inbox is fetched
automatically right after every save (auto-backup is on), so the reward rides
in that way and one tap puts it in the collection + dex (openGift ->
_giftAddCapture -> markFusionSeen).

The gift carries the HATCHED creature, not an egg: a gift record has no egg
slot (run.py _clean_gift: message / place / item / creature / photo). So the
record is shaped exactly like a hatch (creatures.js hatchEgg): level 1,
fromEgg true, a 0.5-2.0 m size roll, and a variant index into the cell's
custom-art list so it shows the artist's art rather than autogen.

Which legendary: the completion-egg rule (creatures.js
_pickCompletionEggLegendary) is a deck without replacement over the active
pack's legendaries, preferring ones whose fusion with the species has custom
art. Applied to Grak's dex:
  - art with Nosepass in at least one orientation: Mew 151, Raikou 243,
    Lugia 249, Ho-Oh 250, Celebi 251, Deoxys 380, Jirachi 381,
    Regirock 447, Registeel 449 (Mewtwo is the one he already got);
  - of those, never owned at all (0 legendary DNA in his 62215 captures):
    Raikou, Lugia, Ho-Oh, Regirock;
  - of those, custom art in BOTH orientations: only Ho-Oh.
So: Ho-Oh. Orientation 'ab' (Nosepass body, Ho-Oh head) -- cell 325-250 has
two custom variants, and a Nosepass rock wearing Ho-Oh's crest reads better
than the reverse.

Writes saves/gifts/Grak/<serverMs>_<id>.json plus its index.json row, the
same two files run.py _store_gift would. Idempotent: re-running refuses to
add a second copy.
"""
import gzip
import json
import re
import string
import time
from datetime import datetime
from pathlib import Path
from random import Random

try:
    from zoneinfo import ZoneInfo
    MONTREAL = ZoneInfo("America/Montreal")
except Exception:                                  # no tzdata: EST is close enough in November
    from datetime import timedelta, timezone
    MONTREAL = timezone(timedelta(hours=-5))

ROOT = Path(__file__).resolve().parent
SAVES = ROOT / "saves"
GIFTS = SAVES / "gifts"
TO = "Grak"
FROM = "Daycare"                 # the game itself; no friend is impersonated

SPECIES = 325                    # Nosepass (data/BundledData/species-names.json)
LEGENDARY = 250                  # Ho-Oh
ORIENT = "ab"                    # a = body, b = head
VARIANT = 0                      # slot 0 of cell 325-250's custom list
SEED = 20261104

MESSAGE = ("Completion reward: your Nosepass row is done again! "
           "A Ho-Oh x Nosepass for you, as if hatched from the egg "
           "you'd already claimed.")



def latest_save(name):
    cands = []
    for p in SAVES.glob(f"{name}_*.json*"):
        m = re.match(rf"^{re.escape(name)}_(\d+)\.json(\.gz)?$", p.name)
        if m:
            cands.append((int(m.group(1)), p))
    if not cands:
        raise SystemExit(f"no save for {name}")
    cands.sort()
    return cands[-1][1]


def load_save(path):
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(path.read_text(encoding="utf-8"))


def gift_id(rng):
    alnum = string.ascii_lowercase + string.digits
    parts = ["g"] + ["".join(rng.choice(alnum) for _ in range(8)) for _ in range(2)]
    return "-".join(parts)


def read_index(name):
    p = GIFTS / name / "index.json"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def main():
    rng = Random(SEED)
    save_path = latest_save(TO)
    save = load_save(save_path)
    captured = save.get("captured") or []
    rewards = save.get("completionRewards") or {}
    names = json.loads((ROOT / "data" / "BundledData" / "species-names.json").read_text())
    nm = lambda i: names[i - 1].title() if 1 <= i <= len(names) and names[i - 1] else f"#{i}"

    # Sanity: he really did claim the first one, and the legendary we pick is
    # not the one he already got.
    if SPECIES not in (rewards.get("claimed") or []):
        raise SystemExit(f"{nm(SPECIES)} is not in completionRewards.claimed — "
                         "the premise of this reward doesn't hold")
    already = {int(k) for k in (rewards.get("counts") or {})}
    if LEGENDARY in already:
        raise SystemExit(f"{nm(LEGENDARY)} was already granted by the completion rule")

    index = read_index(TO)
    folder = GIFTS / TO
    for e in index:
        try:
            rec = json.loads((folder / e["file"]).read_text(encoding="utf-8"))
        except (OSError, ValueError, KeyError):
            continue
        c = rec.get("creature") or {}
        pair = {c.get("speciesA"), c.get("speciesB")}
        if rec.get("from") == FROM and pair == {SPECIES, LEGENDARY}:
            print(f"already granted ({rec['id']}, {rec.get('day')}) — nothing to do")
            return

    a = SPECIES if ORIENT == "ab" else LEGENDARY
    b = LEGENDARY if ORIENT == "ab" else SPECIES
    cells = json.loads((ROOT / "data" / "BundledData" / "cells.json").read_text())
    variants = cells.get(f"{a}-{b}") or []
    if not variants:
        raise SystemExit(f"no custom art for {a}-{b}")
    if not 0 <= VARIANT < len(variants):
        raise SystemExit(f"variant {VARIANT} out of range for {a}-{b} ({len(variants)})")

    size_m = round((0.5 + rng.random() * 1.5) * 100) / 100
    gid = gift_id(rng)
    now = int(time.time() * 1000)
    day = datetime.fromtimestamp(now / 1000, MONTREAL).strftime("%Y-%m-%d")
    server_ms = max(now, max((e.get("serverMs", 0) for e in index), default=0) + 1)

    gift = {
        "id": gid,
        "from": FROM,
        "to": TO,
        "day": day,
        "createdAt": now,
        "message": MESSAGE,
        "place": None,
        "item": None,
        "creature": {
            "speciesA": a,
            "speciesB": b,
            "variant": VARIANT,
            "shinyVariant": None,
            "level": 1,
            "sizeM": size_m,
            "fromEgg": True,
            "spawnClass": None,
            "caughtAt": None,        # client stamps the moment he opens it
        },
        "photo": None,
        "serverMs": server_ms,
    }

    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{server_ms}_{gid}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(gift), encoding="utf-8")
    tmp.replace(path)

    index.append({"id": gid, "from": FROM, "day": day,
                  "serverMs": server_ms, "file": path.name})
    ipath = folder / "index.json"
    itmp = ipath.with_suffix(".json.tmp")
    itmp.write_text(json.dumps(index), encoding="utf-8")
    itmp.replace(ipath)

    print(f"gift {gid} -> {TO}")
    print(f"  {path.relative_to(ROOT)}  (index row added)")
    print(f"  {nm(b)} (head) x {nm(a)} (body), cell {a}-{b} variant {VARIANT}, "
          f"size {size_m} m, level 1, fromEgg")
    prev = max((e.get("serverMs", 0) for e in index[:-1]), default=0)
    print(f"  arrives on his next save (inbox cursor {prev} -> {server_ms})")


if __name__ == "__main__":
    main()

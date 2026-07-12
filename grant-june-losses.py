#!/usr/bin/env python3
"""Recover Bees's lost Jun 20-28 2026 progress.

Bees lost local progress (phone in pool) for Jun 20-28. Grak & Art2 were
playing alongside during that window. This grants Bees a random HALF of the
combined creatures those two caught in the window, with:
  - species / level / size / variant / spawnId / original caughtAt kept
    (so they appear as caught during the window, at the real locations)
  - a fresh unique capture id
  - shinyVariant REROLLED at Bees's own odds (base 1/1000 x Bees's live
    completion-dex multiplier; x10 for legendaries) -- independent of whether
    the source creature was shiny
  - each granted fusion registered into Bees's seenFusions (Pokedex/completion)

Faithful port of creatures.js: _speciesShinyBonus / _fusionShinyMultiplier /
computeSpeciesCompletion / markFusionSeen. Deterministic (seeded) so re-running
reproduces the exact same result.
"""
import json, time, string
from random import Random
from datetime import datetime, timezone, timedelta

SEED = 20260628
BEES = "saves/Bees_1783883785619.json"
SOURCES = ["saves/Grak_1783881093664.json", "saves/Art2_1783864120813.json"]
NAMES = json.load(open("data/BundledData/species-names.json"))

# --- SUPPORTED_SPECIES_SET (creatures.js:2862-2901) ---
EXTRAS = [179,180,181,200,255,214,215,262,220,221,274,227,209,210,198,256,228,229,
          300,390,391,333,405,357,311,312,313,427,428,429,395,396,336,291,292,293,
          310,421,295,297,298,299,196,197,271,272,339,325,326]
SUPPORTED = set(range(1,151)) | set(EXTRAS)
LEG = {144,145,146,150,151}
SHINY_RATE = 0.001          # shiny-store.js:48
VARIANT_COUNT = 12          # TRIPLES_PER_ENTRY
EDT = timezone(timedelta(hours=-4))   # America/Montreal, June DST
WIN_START = datetime(2026,6,20,tzinfo=EDT).timestamp()*1000
WIN_END   = datetime(2026,6,29,tzinfo=EDT).timestamp()*1000   # through end of Jun 28

def sp(i): return NAMES[i-1].title() if (i and 1<=i<=len(NAMES)) else f"#{i}"

# --- completion -> shiny multiplier, faithful to creatures.js ---
def compute_completion(seen_fusions):
    head, body = {}, {}
    for key in seen_fusions:
        dash = key.find('-')
        if dash < 0: continue
        try: a, b = int(key[:dash]), int(key[dash+1:])
        except ValueError: continue
        if a not in SUPPORTED or b not in SUPPORTED: continue
        head[a] = head.get(a,0)+1
        body[b] = body.get(b,0)+1
    total = 2*len(SUPPORTED)
    return {i: (head.get(i,0)+body.get(i,0))/total for i in SUPPORTED}, total

def species_shiny_bonus(pct):                     # creatures.js:741
    shown = round(pct*100)
    if shown < 20: return 0
    return min(10, shown//10)

def fusion_multiplier(pct_by_id, a, b):           # creatures.js:746
    m = 0
    if a is not None: m += species_shiny_bonus(pct_by_id.get(a,0))
    if b is not None: m += species_shiny_bonus(pct_by_id.get(b,0))
    return m or 1

def in_window(c):
    ca = c.get("caughtAt")
    return isinstance(ca,dict) and WIN_START <= ca.get("timestamp",0) < WIN_END

def main():
    rng = Random(SEED)
    bees = json.load(open(BEES))
    pct_by_id, total = compute_completion(bees["seenFusions"])

    # combined in-window pool
    pool = []
    per = {}
    for path in SOURCES:
        who = path.split("/")[-1].split("_")[0]
        win = [c for c in json.load(open(path))["captured"] if in_window(c)]
        per[who] = len(win)
        pool.extend(win)

    # deterministic random HALF
    rng.shuffle(pool)
    n_half = (len(pool)+1)//2
    chosen = pool[:n_half]

    # unique-id generation
    existing_ids = {c.get("id") for c in bees["captured"]}
    alphabet = string.ascii_lowercase + string.digits
    def new_id(ts):
        while True:
            sfx = "".join(rng.choice(alphabet) for _ in range(6))
            cid = f"c-{ts}-{sfx}"
            if cid not in existing_ids:
                existing_ids.add(cid); return cid

    # build granted records + reroll shiny
    granted = []
    shiny_rolled = 0
    for c in chosen:
        a, b = c.get("speciesA"), c.get("speciesB")
        rate = SHINY_RATE * fusion_multiplier(pct_by_id, a, b)
        if a in LEG: rate *= 10
        sv = rng.randrange(VARIANT_COUNT) if rng.random() < rate else None
        if sv is not None: shiny_rolled += 1
        ts = c["caughtAt"]["timestamp"]
        granted.append({
            "id": new_id(ts),
            "spawnId": c.get("spawnId"),
            "speciesA": a, "speciesB": b,
            "variant": c.get("variant"),
            "shinyVariant": sv,
            "level": c.get("level"),
            "sizeM": c.get("sizeM"),
            "caughtAt": c["caughtAt"],
        })

    # append to captured
    bees["captured"].extend(granted)

    # register into seenFusions (port of markFusionSeen); completion snapshot
    # above was taken PRE-merge so rerolls used Bees's pre-grant dex.
    seen = bees["seenFusions"]
    completion_before = sum(1 for _ in seen)  # key count (informational)
    new_keys = 0
    for c in granted:
        a, b = c["speciesA"], c["speciesB"]
        if a is None or b is None: continue
        key = f"{a}-{b}"
        ca = c["caughtAt"]; ts = ca["timestamp"]
        v = c["variant"]
        vkey = str(v) if (isinstance(v,int) and not isinstance(v,bool) and v>=0) else "auto"
        e = seen.get(key)
        if e is None:
            e = {"firstSeen": ts}
            seen[key] = e
            new_keys += 1
        e["lastSeen"] = max(e.get("lastSeen",0), ts)
        e["firstSeen"] = min(e.get("firstSeen",ts), ts)
        if e.get("lat") is None and ca.get("lat") is not None:
            e["lat"] = ca["lat"]; e["lng"] = ca["lng"]
            if ca.get("poi") is not None: e["poi"] = ca["poi"]
            if ca.get("place") is not None: e["place"] = ca["place"]
        e.setdefault("variants", {})
        e["variants"].setdefault(vkey, ts)

    # touch export metadata
    bees["exportedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
                          f"{datetime.now().microsecond//1000:03d}Z"

    # write NEW timestamped save (highest millis => /load serves it)
    now_ms = int(time.time()*1000)
    out = f"saves/Bees_{now_ms}.json"
    with open(out,"w") as f:
        json.dump(bees, f, ensure_ascii=False, separators=(",",":"))

    # completion after
    pct_after, _ = compute_completion(seen)
    def overall(pcts): return sum(pcts.values())/len(pcts)*100
    pre_pct = overall(pct_by_id); post_pct = overall(pct_after)

    print(f"SEED {SEED}")
    print(f"window Jun20-28: Grak {per.get('Grak',0)} + Art2 {per.get('Art2',0)} = {len(pool)}")
    print(f"granted (half): {len(granted)}")
    print(f"  shinies rerolled onto Bees: {shiny_rolled}")
    print(f"  new distinct fusion-pairs added to Pokedex: {new_keys}")
    print(f"captured: {len(bees['captured'])-len(granted)} -> {len(bees['captured'])}")
    print(f"seenFusions keys: {completion_before} -> {len(seen)}")
    print(f"overall completion: {pre_pct:.2f}% -> {post_pct:.2f}%")
    print(f"new save: {out}")
    # list the shinies Bees actually rolled
    got = [g for g in granted if g['shinyVariant'] is not None]
    if got:
        print("Bees's rerolled shinies:")
        for g in got:
            a,b=g['speciesA'],g['speciesB']
            nm = sp(a) if (b is None or b==a) else f"{sp(a)}/{sp(b)}"
            when = datetime.fromtimestamp(g['caughtAt']['timestamp']/1000,EDT).strftime('%b-%d %H:%M')
            print(f"  ✨ {nm}  lv{g['level']}  variant#{g['shinyVariant']}  ({when})")

if __name__ == "__main__":
    main()

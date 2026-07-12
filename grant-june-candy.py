#!/usr/bin/env python3
"""Grant candy for the Jun 20-28 recovery creatures.

Rule (as requested): 2 candy per granted creature; each candy is an
INDEPENDENT 50/50 coin flip between the first morph's family root and the
second morph's family root. If both morphs share a root, both candy go there.

Candy is keyed by EVOLUTION-FAMILY ROOT (creatures.js candyRootFor): walk back
to the earliest pre-evo, then promote past known baby forms. Faithful port,
validated to reproduce Bees's existing candy keys exactly.

NOTE: the game's *normal* 2-candy capture actually uses uniform-over-three
outcomes (1/3 each: 2A / 2B / 1+1), not independent flips. Independent flips
(this script, per request) give 25% / 25% / 50%. Same expected value (1 per
morph); only the split variance differs.

Operates only on the 2953 granted creatures (captured[3625:]). Deterministic.
"""
import json, time
from random import Random
from collections import Counter

SEED = 20260629
SRC = "saves/Bees_1783884512583.json"          # current active save (post creature-grant)
ORIG = "saves/backup-before-june-grant/Bees_1783883785619.json"  # pre-grant (3625)
EVOS = json.load(open("data/BundledData/species-evolutions.json"))
NAMES = json.load(open("data/BundledData/species-names.json"))
CANDY_ROOT_BABIES = {172,173,174,175,236,238,239,240}   # creatures.js:317
def nm(i): return NAMES[i-1].title() if (i and 1<=i<=len(NAMES) and NAMES[i-1]) else f"#{i}"

# --- candyRootFor port (validated) ---
def fwd(idx):
    raw = EVOS.get(str(idx))
    return [e[0] for e in raw] if isinstance(raw, list) else []
_rev = {}
for _src, _raw in EVOS.items():
    if isinstance(_raw, list):
        for _e in _raw:
            _rev.setdefault(int(_e[0]), []).append(int(_src))
def family_of(idx):
    cur = idx; seen = {cur}
    while True:
        pre = _rev.get(cur)
        if not pre: break
        prev = pre[0]
        if prev in seen: break
        seen.add(prev); cur = prev
    fam = []; vis = set(); q = [cur]
    while q:
        i = q.pop(0)
        if i in vis: continue
        vis.add(i); fam.append(i); q += fwd(i)
    return fam
def candy_root(idx):
    if idx is None: return None
    fam = family_of(idx)
    if not fam: return idx
    i = 0
    while i < len(fam)-1 and fam[i] in CANDY_ROOT_BABIES: i += 1
    return fam[i]

def main():
    rng = Random(SEED)
    save = json.load(open(SRC))
    orig_ids = {c["id"] for c in json.load(open(ORIG))["captured"]}
    granted = [c for c in save["captured"] if c["id"] not in orig_ids]
    assert len(granted) == 2953, len(granted)

    candy = save["candy"]
    before = Counter({int(k): v for k, v in candy.items()})
    delta = Counter()
    total_added = 0
    split = Counter()   # per-creature outcome tally
    for c in granted:
        rootA = candy_root(c.get("speciesA"))
        rootB = candy_root(c.get("speciesB"))
        if rootA is None and rootB is None:
            continue
        if rootA is None: rootA = rootB
        if rootB is None: rootB = rootA
        if rootA == rootB:
            delta[rootA] += 2; total_added += 2; split["same-root"] += 1
            continue
        a = sum(1 for _ in range(2) if rng.random() < 0.5)   # independent 50/50 x2
        b = 2 - a
        if a: delta[rootA] += a
        if b: delta[rootB] += b
        total_added += 2
        split[f"{a}A+{b}B"] += 1

    # apply
    for root, n in delta.items():
        k = str(root)
        candy[k] = candy.get(k, 0) + n

    now_ms = int(time.time()*1000)
    out = f"saves/Bees_{now_ms}.json"
    with open(out, "w") as f:
        json.dump(save, f, ensure_ascii=False, separators=(",", ":"))

    print(f"SEED {SEED}")
    print(f"granted creatures given candy: {len(granted)}")
    print(f"total candy added: {total_added}  (expected {2*len(granted)})")
    print(f"per-creature split: {dict(split)}")
    print(f"candy families touched: {len(delta)}  (dict {len(before)} -> {len(candy)} keys)")
    print(f"new save: {out}")
    print("top 15 candy gains:")
    for root, n in delta.most_common(15):
        print(f"  +{n:4d}  {nm(root)} candy  ({before.get(root,0)} -> {before.get(root,0)+n})")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Build static/scala-db.json from the Scala scale archive.

The synth's Tuning Explorer (static/synth.html) browses the ~5400 tunings
of the Scala scale archive fully offline. This script converts the archive's
.scl files into one compact JSON bundle, checked into static/ so the app
never fetches anything from the web at runtime (zero-network policy).

Usage:
    # one-time: fetch the archive (only ever run manually, at build time)
    curl -L -o /tmp/scales.zip https://www.huygens-fokker.org/docs/scales.zip
    unzip -o /tmp/scales.zip -d /tmp/scala-archive
    ./build-scala-db.py /tmp/scala-archive/scl

Archive credit: Scala scale archive, curated by Manuel Op de Coul
(https://www.huygens-fokker.org/scala/scl.html). The archive is freely
usable; the explorer UI shows an attribution line.

.scl format (see huygens-fokker.org/scala/scl_format.html):
  - lines starting with "!" are comments
  - first non-comment line: description (may be empty)
  - second: note count N
  - then N pitch lines; first token is the value — contains "." = cents,
    otherwise a ratio "a/b" or integer "a". Anything after the value is
    an ignorable comment. 1/1 (0.0 cents) is implicit degree 0.
  - the LAST value is the period (formal octave) used for equivalence.

Output JSON (v2):
  {"v":2, "credit":"...", "scales":[[name, description, fam, into, [cents...]], ...]}
  - cents rounded to 0.01c (integer values emitted as ints to save bytes)
  - fam (keyword family, first match wins): 0=other 1=gamelan 2=Partch
    3=Bohlen-Pierce 4=Wilson/CPS 5=Carlos 6=Greek&ancient 7=Middle-Eastern
    8=Indian 9=East&SE-Asian 10=historical temperament
  - into (intonation, structural): 0=tempered(cents-only) 1=just(ratio-only)
    2=mixed 3=equal-step (all steps equal within 0.02c)
  - scales with a non-positive period are skipped (unusable for octave
    stacking; 2 files in the 2026 archive)
"""

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "static" / "scala-db.json"

# keyword families, checked in order — people first (their scales often also
# contain generic words like "temperament"), then cultures, then historical
FAMILIES = [
    (2, re.compile(r"partch", re.I)),
    (3, re.compile(r"bohlen|pierce|tritave", re.I)),
    (4, re.compile(r"wilson|dekany|eikosany|hebdomek|pentadekany|\bcps\b|"
                   r"combination[- ]product|moment of symmetry|\bmos\b", re.I)),
    (5, re.compile(r"carlos", re.I)),
    (1, re.compile(r"gamelan|pelog|slendro|bali|java|indones|bonang|gender|"
                   r"gambang|degung|madura", re.I)),
    # Middle East before Greek: medieval Islamic theorists (al-Farabi, Safi
    # al-Din) built on Greek genera and their descriptions cite both
    (7, re.compile(r"maqam|arab|turk|persia|iran|ottoman|rast\b|bayati|"
                   r"syrian|dastgah", re.I)),
    (6, re.compile(r"greek|ptolem|archyta|aristox|didym|eratosthen|euclid|"
                   r"boethius|ancient", re.I)),
    (8, re.compile(r"raga|shruti|sruti|india|carnatic|hindust", re.I)),
    (9, re.compile(r"china|chinese|japan|koto|gagaku|shakuhachi|korea|"
                   r"vietnam|thai|burm|cambod|khmer", re.I)),
    (10, re.compile(r"temperament|meantone|well[- ]?temp|werckmeister|"
                    r"kirnberger|vallotti|neidhardt|marpurg|lambert|barnes|"
                    r"rameau|kellner|barca|bethisy|corrette|d.alembert|"
                    r"mercadier|rousseau|tempered", re.I)),
]


def parse_scl(text):
    """Return (description, [cents...], [is_ratio...]) or raise ValueError."""
    lines = [l.strip() for l in text.splitlines() if not l.strip().startswith("!")]
    if len(lines) < 2:
        raise ValueError("too short")
    desc = lines[0]
    n = int(lines[1].split()[0])
    vals, kinds = [], []
    for line in lines[2 : 2 + n]:
        tok = line.split()[0]
        if "." in tok:
            v = float(tok)
            kinds.append(False)
        elif "/" in tok:
            a, b = tok.split("/")
            v = 1200.0 * math.log2(int(a) / int(b))
            kinds.append(True)
        else:
            v = 1200.0 * math.log2(int(tok))
            kinds.append(True)
        vals.append(v)
    if len(vals) != n:
        raise ValueError("missing values")
    return desc, vals, kinds


def is_equal_step(cents):
    """All steps (from implicit 0) equal within 0.02c → an equal division."""
    if len(cents) < 2:
        return len(cents) == 1
    step = cents[0]
    prev = 0.0
    for c in cents:
        if abs((c - prev) - step) > 0.02:
            return False
        prev = c
    return True


def fam_for(name, desc):
    text = name + " " + desc
    for fam, rx in FAMILIES:
        if rx.search(text):
            return fam
    return 0


def into_for(cents, kinds):
    if is_equal_step(cents):
        return 3  # structural — an equal division however it was written
    # tempered scales conventionally still write the closing octave as the
    # ratio 2/1 — the period alone must not flip a cents scale to "mixed"
    body = kinds[:-1] if len(kinds) > 1 else kinds
    if all(kinds):
        return 1  # just: every degree a ratio
    if not any(body):
        return 0  # tempered: every non-period degree in cents
    return 2      # mixed


def compact(v):
    """Round to 0.01c; keep integral values as ints (smaller JSON)."""
    r = round(v * 100) / 100
    return int(r) if r == int(r) else r


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    files = sorted(src.glob("*.scl"))
    if not files:
        sys.exit(f"no .scl files in {src}")

    scales, skipped = [], []
    for f in files:
        name = f.stem
        try:
            desc, cents, kinds = parse_scl(f.read_text(encoding="latin-1"))
        except (ValueError, IndexError) as e:
            skipped.append((name, str(e)))
            continue
        if not cents or cents[-1] <= 0:
            skipped.append((name, "non-positive period"))
            continue
        desc = re.sub(r"\s+", " ", desc).strip()
        scales.append([name, desc, fam_for(name, desc), into_for(cents, kinds),
                       [compact(c) for c in cents]])

    db = {
        "v": 2,
        "credit": "Scala scale archive © Manuel Op de Coul · huygens-fokker.org/scala",
        "scales": scales,
    }
    OUT.write_text(json.dumps(db, separators=(",", ":"), ensure_ascii=False),
                   encoding="utf-8")

    sizes, fams, intos = {}, {}, {}
    for s in scales:
        sizes[len(s[4])] = sizes.get(len(s[4]), 0) + 1
        fams[s[2]] = fams.get(s[2], 0) + 1
        intos[s[3]] = intos.get(s[3], 0) + 1
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB): "
          f"{len(scales)} scales, {len(skipped)} skipped")
    for nm, why in skipped:
        print(f"  skipped {nm}: {why}")
    print(f"families: {dict(sorted(fams.items()))}")
    print(f"intonation: {dict(sorted(intos.items()))}")
    top = sorted(sizes.items(), key=lambda kv: -kv[1])[:8]
    print(f"top note-counts: {top}")


if __name__ == "__main__":
    main()

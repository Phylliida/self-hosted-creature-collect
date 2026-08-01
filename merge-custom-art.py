#!/usr/bin/env python3
"""Merge custom-battler sprite sheets from multiple game trees into one
spritesheets_custom tree (+ a merged credits CSV) for the IF2 union
build (build-bundled-data.py via CC_CUSTOM_SHEETS_DIR / CC_CREDITS_CSV).

Sources, in priority order:
  1. data/InfiniteFusion       (IF1 — the CURRENT pack's art. Its
                                variants always keep indices 0..k-1 per
                                head, so creatures storing a numeric
                                variant keep showing the same image —
                                see resolveSpawnVariant / _pickEvolvedVariant
                                in static/creatures.js.)
  2. data/InfiniteFusion2      (IF2 — in practice fully contained in IF1)
  3. data/Battlers             (legacy pre-extracted tree with ~1.8k
                                sheets found nowhere else)

Per head, variants are ordered by (source priority, source's own
canonical suffix order), deduped by content hash, then re-lettered
canonically ('', a, b, ..., z, aa, ...) — process_custom_head sorts by
(len, lex), which is the same sequence, so IF1's variant indices are
preserved BY CONSTRUCTION. Duplicates map to the kept sheet's index so
credits still resolve. Output uses hardlinks (near-zero disk cost).

Credits: each source's Data/sprites/Sprite_Credits.csv rows are remapped
from the source's suffix to the merged suffix for that head. BAT has no
CSV of its own — its rows are looked up in all three game CSVs (IFold
first, the closest era). Conflicts resolve in source priority order.

Outputs:
  data/MergedCustom/spritesheets_custom/<head>/<head><suffix>.png
  data/MergedCustom/credits.csv

Run: python3 merge-custom-art.py
"""

import hashlib
import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent

SOURCES = [
    ("IF1", ROOT / "data" / "InfiniteFusion" / "Graphics" / "CustomBattlers"
     / "spritesheets" / "spritesheets_custom",
     ROOT / "data" / "InfiniteFusion" / "Data" / "sprites" / "Sprite_Credits.csv"),
    ("IF2", ROOT / "data" / "InfiniteFusion2" / "Graphics" / "CustomBattlers"
     / "spritesheets" / "spritesheets_custom",
     ROOT / "data" / "InfiniteFusion2" / "Data" / "sprites" / "Sprite_Credits.csv"),
    ("BAT", ROOT / "data" / "Battlers" / "spritesheets_custom", None),
]

# CSVs consulted for BAT sheets (closest era first).
BAT_CREDIT_CSVS = [
    ROOT / "data" / "InfiniteFusionold" / "Data" / "sprites" / "Sprite_Credits.csv",
    SOURCES[0][2], SOURCES[1][2],
]

OUT_DIR = ROOT / "data" / "MergedCustom"
OUT_SHEETS = OUT_DIR / "spritesheets_custom"
OUT_CREDITS = OUT_DIR / "credits.csv"

SHEET_RE = re.compile(r"^(\d+)([a-z]*)\.png$")
CREDITS_KEY_RE = re.compile(r"^(\d+)\.(\d+)([a-z]*)$")


def canonical_suffix(index: int) -> str:
    """The (len, lex) variant sequence: '', a..z, aa, ab, ..."""
    if index == 0:
        return ""
    index -= 1
    letters = []
    while True:
        letters.append(chr(ord("a") + index % 26))
        index = index // 26 - 1
        if index < 0:
            break
    return "".join(reversed(letters))


def head_variants(src_dir: Path, head: int) -> list[tuple[str, Path]]:
    """A source's variants for one head in canonical (len, lex) order."""
    d = src_dir / str(head)
    if not d.is_dir():
        return []
    out = []
    for f in d.iterdir():
        m = SHEET_RE.match(f.name)
        if m and int(m.group(1)) == head:
            out.append((m.group(2), f))
    out.sort(key=lambda p: (len(p[0]), p[0]))
    return out


def parse_credits_csv(path: Path) -> dict[tuple[int, int, str], str]:
    """{(a, b, variant_suffix): artist} from a Sprite_Credits.csv."""
    out = {}
    if not path or not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = raw.split(",")
        if len(parts) < 2:
            continue
        m = CREDITS_KEY_RE.match(parts[0].strip())
        artist = parts[1].strip()
        if not m or not artist:
            continue
        key = (int(m.group(1)), int(m.group(2)), m.group(3))
        out.setdefault(key, artist)
    return out


def main() -> None:
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_SHEETS.mkdir(parents=True)

    heads = sorted({
        h
        for src_dir, _ in [(s[1], s[0]) for s in SOURCES] if src_dir.is_dir()
        for h in (int(d.name) for d in src_dir.iterdir()
                  if d.is_dir() and d.name.isdigit())
    })

    stats = {"heads": 0, "kept": 0, "dupes": 0,
             "per_source": {name: 0 for name, _, _ in SOURCES}}
    # (src_name, head, src_suffix) -> merged index
    remap: dict[tuple[str, int, str], int] = {}

    for head in heads:
        # Dedupe by content hash across ALL sheets (intra-source
        # included). Byte-identical variants collapse to the first
        # slot; the suffix remap still points the collapsed slot's
        # credits at the kept image. IF1's prefix order is preserved,
        # so stored variant indices keep their art (indices pointing
        # exactly at a collapsed dupe slot fall back to autogen —
        # accepted trade for full dedup).
        seen: dict[str, int] = {}           # sha -> merged index
        merged: list[Path] = []
        for src_name, src_dir, _ in SOURCES:
            for suffix, path in head_variants(src_dir, head):
                sha = hashlib.sha256(path.read_bytes()).hexdigest()
                if sha in seen:
                    remap[(src_name, head, suffix)] = seen[sha]
                    stats["dupes"] += 1
                    continue
                idx = len(merged)
                merged.append(path)
                seen[sha] = idx
                remap[(src_name, head, suffix)] = idx
                stats["per_source"][src_name] += 1
        if not merged:
            continue
        stats["heads"] += 1
        stats["kept"] += len(merged)
        out_head = OUT_SHEETS / str(head)
        out_head.mkdir(parents=True)
        for i, path in enumerate(merged):
            dst = out_head / f"{head}{canonical_suffix(i)}.png"
            try:
                os.link(path, dst)
            except OSError:
                shutil.copyfile(path, dst)

    # ── merged credits ────────────────────────────────────────────
    csvs = {name: parse_credits_csv(csv) for name, _, csv in SOURCES}
    bat_csvs = [parse_credits_csv(p) for p in BAT_CREDIT_CSVS]
    merged_credits: dict[tuple[int, int, str], str] = {}

    def put(a: int, b: int, suffix: str, artist: str) -> None:
        merged_credits.setdefault((a, b, suffix), artist)

    # IF1 / IF2 rows remap through their own source's variant mapping.
    for src_name, _, _ in SOURCES[:2]:
        for (a, b, suf), artist in csvs[src_name].items():
            idx = remap.get((src_name, b, suf))
            if idx is not None:
                put(a, b, canonical_suffix(idx), artist)
    # BAT rows: no CSV of its own — look the native suffix up in the
    # game CSVs (closest era first), remap through BAT's mapping.
    bat_keys = {(head, suf) for (src, head, suf) in remap if src == "BAT"}
    for csv in bat_csvs:
        for (a, b, suf), artist in csv.items():
            if (b, suf) not in bat_keys:
                continue
            idx = remap.get(("BAT", b, suf))
            if idx is not None:
                put(a, b, canonical_suffix(idx), artist)

    with OUT_CREDITS.open("w", encoding="utf-8") as f:
        for (a, b, suf), artist in sorted(merged_credits.items()):
            f.write(f"{a}.{b}{suf},{artist},main,\n")

    print(f"heads: {stats['heads']}, sheets kept: {stats['kept']}, "
          f"dupes skipped: {stats['dupes']}")
    print("kept per source:", stats["per_source"])
    print(f"credits rows: {len(merged_credits)}")
    print(f"→ {OUT_SHEETS}")
    print(f"→ {OUT_CREDITS}")


if __name__ == "__main__":
    main()

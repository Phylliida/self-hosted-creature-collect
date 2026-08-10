---
name: project_shiny_palette_pipeline
description: Shiny pipeline — master codebook (build-shiny-codebook.py, append-only, bin v3), pairs keyed by CANDY roots (baby-exclusive, mirrors candyRootFor); legacy 2-step bake retained for reference; cell-reader + root-keying bug history
metadata:
  type: project
---

Shiny variants are per-family-pair colour transforms (12 × (φ, ΔL, κ)) baked offline, NOT stored per sprite.

**Current pipeline (since 2026-08-03): the master codebook.** `python3 build-shiny-codebook.py` is the ONLY regeneration entry point for both creature-fusion and creature-if2:
- Master = `data/shiny-codebook.json`: one frozen 128-entry codebook of (φ, ΔL, κ) "types" + per-game sections (`games.creature-fusion`, `games.creature-if2`) mapping each family pair → 12 codebook indices. **Append-only**: existing entries + codebook are never recomputed — adding new art/species can no longer change shipped shiny colours (that was the point). `--init` (once, refused if master exists) derived the codebook via k-means over both legacy bakes and snapped them; re-runs only gap-fill NEW roster pairs (bake via build-shiny-palettes machinery against that game's bundle, snap; truly-grayscale pairs get a deterministic crc32-seeded default since hue transforms are no-ops on gray art). The two games share the PIF species id space (verified: all 199 overlapping names match) but keep separate sections because they were baked against different art.
- Output: `shiny-palettes.bin` **format v3** (magic 'SHIN', header's 4th u32 = K, K×4B codebook, then 16B entries of u16 a/b + 12 u8 indices) written into each game's bundle dir — same filename as v2, so pack builds (`build-content-pack.py`) unchanged. `static/shiny-store.js` and `build-if2-packs.py slice_shin` accept both v2 and v3. Sizes: 154 KB (9,801 pairs) / 1.26 MB (82,369 pairs) vs 509 KB / 4.3 MB in v2.
- k=128 rationale: `probe-shiny-codebook.py` — snapping costs mean OKLab ΔE ≈ 0.030 (~3 JND), no elbow (transforms uniformly spread by farthest-point design), pairs keep 12 distinct types down to k≈64; below ~48 within-pair diversity collapses.
- Tests: `tests/shiny-codebook.test.js` (v3+v2 loader decode), v3 slice case in `tests/if2-packs.test.js`; `--verify` round-trips bins vs master.

**Legacy pipeline (superseded, kept for the old bakes):** `build-shiny-palettes.py --all --jobs 4` → `shiny-palettes-to-bin.py` (v2). Both games' master sections were initialized by snapping these bakes, NOT re-baking — so shipped colours are preserved. ⚠ The legacy bake read custom art WRONG (see bugs below): its palettes were autogen + wrong-cell custom art. Don't re-bake legacy pairs to "fix" this unless the user explicitly accepts colour changes.

**Root-keying bug fixed 2026-08-10 (baby families invisible in IF2):** the IF2 master section was keyed by *earliest ancestor including babies* (e.g. Chansey pairs under Happiny `259`), but the client (`shiny-store.js` via `candyRootFor`) looks up *candy roots* (first non-baby, e.g. `113`). Every family with a baby (18 of them: Pichu, Happiny, Tyrogue, Munchlax, …) silently missed → shinies rendered with original colors. creature-fusion was unaffected (its bundle's evolutions have no baby links). Fix: `data/shiny-codebook.json` IF2 section re-keyed in place (bijection, verified zero collisions; transforms untouched so shipped colors are preserved for all previously-working pairs), `build-shiny-codebook.py load_roster` now mirrors candyRootFor, and `build-if2-packs.py slice_shin` re-keys entries to *pack-local* roots via `shin_rekey_map` (subset slicing changes resolution: gen-1 pack drops the Happiny→Chansey link so Chansey resolves to 113; a gen-4-only pack resolves Happiny to itself, 259). ⚠ Any future roster regeneration must keep this convention or shinies break again.

**Cell-reader bugs fixed 2026-08-03 (in `build-shiny-palettes.py`; affected every historical bake):**
1. `iter_fusion_variants(a, b, ...)` looked up `cells[f'{a}-{b}']` + `manifest[str(b)]` — but cells.json is keyed `"<body>-<head>"` and manifest by head, so for fusion head=a/body=b it must be `cells[f'{b}-{a}']` + `manifest[str(a)]`. It also treated slot 0 (suffix '') as the autogen sheet — it's actually the no-letter CUSTOM sheet `custom/<a>.png` (autogen is not in cells.json at all).
2. Custom sheets are **20 cols** (`CUSTOM_COLS` in build-bundled-data.py), not 10 — `open_fusion_cell` now takes `suffix=None`→autogen(10-col), `''/'a'/…`→custom(20-col).
3. Zero-chroma variants (blank cell/grayscale art) no longer suppress the autogen fallback in `merge_family_pair_palette`.
Effect: gap-fill recovery went from 23→140 real palettes (if2) and 4→13 (cf); remaining gaps (103 if2 + 4 cf) are genuinely grayscale fusions (hue transform = no-op → deterministic default entries).

**Parallelism — READ THIS (legacy --all bake):** ~9,801 pairs independent → `--jobs` Pool. Serial ≈ 0.8 pairs/s (~3h). **⚠ On bepis's machine (bwrap: tmpfs root, writes only to /tmp + working dir), the full-roster IF2 bake (82k pairs) OOM-crashed at `--jobs 32` AND `--jobs 5`. Use `--jobs 4` max. Keep big build outputs on real disk: `packs/creature-if2` and `data/BundledData-if2` are symlinked to `/tmp/cc-build/` (/dev/sdb2) — do not move them into tmpfs/RAM-backed paths. The bake checkpoints every 500 pairs to `<output>.checkpoint` and resumes.**

Related: [[reference_pokedex_architecture]].

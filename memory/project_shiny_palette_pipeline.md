---
name: project_shiny_palette_pipeline
description: How shiny palettes are baked; autogen-fallback fix; regen is a 2-step build (--all --jobs → to-bin)
metadata:
  type: project
---

Shiny variants are per-family-pair colour transforms (12 × (φ, ΔL, κ)) baked offline, NOT stored per sprite. Pipeline:
1. `build-shiny-palettes.py --all --jobs N` → merges each family pair's sprite palette (OKLAB), farthest-point-samples 12 transforms, writes `data/BundledData/shiny-palettes.json`. Pairs with an empty palette are **skipped** (no entry).
2. `shiny-palettes-to-bin.py` → packs JSON into `data/BundledData/shiny-palettes.bin` (format v2, 'SHIN' magic), which the app loads via `static/shiny-store.js` (`SHINY_RATE=0.001`).
Runtime: a family pair with no `.bin` entry falls back to the identity transform → every "shiny" looks the SAME as the base = the bug below.

**Bug fixed 2026-07-05 (entirely-autogen families had degenerate "same colour" shinies):** `merge_family_pair_palette` only loaded sprites listed in `cells.json`, but cells.json omits ~27% of fusions (many autogen-only) and 134 entries even lack the autogen slot 0. A family pair whose fusions are all absent → 0 sprites → empty palette → skipped → identity shiny. Fix: per fusion, if `iter_fusion_variants` yields no loadable sprite, fall back to the autogen cell (`open_fusion_cell(..., suffix='')`). Autogen sheets (`sprites/<A>/autogen/<A>.png`) exist for every fusion. Verified: e.g. roots 16×98 (Pidgey×Krabby) went 0 sprites → 6 sprites / 95 colours / 12 distinct transforms.

**Parallelism — READ THIS:** added `--jobs/-j` (default 1 serial; 0 = all CPUs) to `--all`. ~9,801 pairs are independent → `multiprocessing.Pool` with a `_worker_init` that loads the bundle once per worker. Serial ≈ 0.8 pairs/s (~3h). **⚠ On bepis's machine (64 cores / 125 GB), `--jobs 32` HARD-CRASHED the whole computer twice (2026-07-31, full-roster IF2 bake of 82k pairs) — do NOT exceed `--jobs 5` there.** Each worker pulls large RGBA sheets through PIL simultaneously; memory/IO spikes, not CPU count, are the limit. `--render-samples` is ignored when `--jobs>1`.

**To regenerate after any sprite/cells change:** `python build-shiny-palettes.py --all --jobs 5 && python shiny-palettes-to-bin.py` (safe worker count — see warning above). Related: [[reference_pokedex_architecture]].

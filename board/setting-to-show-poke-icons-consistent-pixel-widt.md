---
title: Setting to show poke icons consistent pixel width
status: in_progress
claimed_by: claude-opus
created: 2026-07-19T19:25:19Z
updated: 2026-07-19T19:25:19Z
taiga_id: 71
taiga_version: 3
synced_hash: 3ef47aaa1b71100c
---

on the map it is correct but the encounter and pokedex and silouettes etc right now crop and zoom, we need a global setting (toggle in settings menu, match the style) that doesn't do any crop and instead uses full res everywhere, may require invalidating any cached sprites when changed

## Progress
- (2026-07-19) Claimed by claude-opus. Goal: global settings toggle → render
  creature icons at full-res / consistent pixel width (no crop/zoom) everywhere
  except the map (already correct). May need to invalidate cached sprites on
  change. Mapping the crop/zoom render paths (encounter, pokedex, silhouettes),
  the map's correct path, the sprite cache, and the settings-toggle persistence
  pattern before touching code.

## Writeup
(pending)

---
title: Community day radar blips should fuse with evolved forms of the featured species
status: done
claimed_by: k3-256k
created: 2026-08-31T17:30:00Z
updated: 2026-08-31T17:30:00Z
---

During a Community Day Pass session, radar (evolved-stream) blips previously
fused the featured BASE species in one slot (e.g. Oddish itself). The radar is
the evolved stream, so the featured half should be drawn from the featured
species' own evolution line instead (Oddish ⇒ Gloom/Vileplume/Bellossom).

## Progress
- (2026-08-31) Changed the radar override in `generateEvolvedAtTick`
  (`static/spawns.js`): the featured slot now draws uniformly from the featured
  species' loaded forward-evolution set via a new cached helper
  `_communityFeaturedForms(speciesId)` (chain A→B→C ⇒ uniform over {B, C} —
  same convention as normal evolved halves). Single-stage featured species
  fall back to the base form, so they still appear on radar as themselves.
  - Partner half unchanged: uniform draw across ALL evolved forms (`_evoFlat`,
    no weather bias). Draws stay append-only inside the active-session branch
    (slot coin → partner → featured form), so inactive sessions leave the
    stream bit-identical and co-located players stay in sync.
  - Wild and incense morphs unchanged: still fuse the base featured species.
  - `spawn.community` still carries the featured base id → battle badge,
    "From Community Day" tag and +3 shiny bonus all unchanged.
- UI text updated (`static/creatures.js`): pass description + use-confirm
  dialog now say radar targets are fusions of the featured species' evolved
  forms.
- Tests (`tests/community-day.test.js`): sections 5 & 7 assert the featured
  half is in the featured line's evolution set (never the base form when the
  line has evolutions; both halves evolved then), partner half always evolved,
  live-radar transform/revert still holds. 429/429 pass.
- Verified by sweep: 80 blips during an Oddish session all carried
  gloom/vileplume/bellossom, base oddish never appeared; 60/60 blips carried
  Tauros itself during a Tauros session (single-stage fallback).

## Assumptions / limitations
- The base form is EXCLUDED from the radar draw when the species has
  evolutions (you still get plenty of base-form fusions from wild + incense).
  Including it would be a one-line change to `_communityFeaturedForms`.
- The featured-form pick consumes one extra RNG draw inside the
  active-session branch, so blip identities differ from the pre-change build
  for the same week — expected for a behavior change; inactive weeks are
  untouched.

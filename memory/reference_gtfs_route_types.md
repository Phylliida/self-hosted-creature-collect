---
name: reference_gtfs_route_types
description: Transit route.mode uses EXTENDED GTFS route_types (100s–1500s), not just the standard 0–12
metadata:
  type: reference
---

`scheduleIdx.routesById.get(rid).mode` (from schedule.sqlite `route.mode`, surfaced by `/schedule` and `schedule_query.py`) is the raw GTFS `route_type` **int**, and real feeds use the **extended** code space, not just standard 0–12. Observed in the data: `700` = 192 bus routes (STM buses come through as 700, not 3), `1501` = shared/communal taxi, plus `2` (rail), `4` (ferry), `0` (tram), `1` (metro), `5/6/7/10/11`.

Extended ranges that matter for bucketing transit into bus/subway/train:
- subway/metro/urban rail: `1`, `400–699`
- bus/coach/trolleybus/taxi: `3`, `11`, `200–299`, `700–899`, `1500–1599`
- on-rails (heavy rail, tram, monorail, cable): `0`, `2`, `5`, `12`, `100–199`, `900–999`
- ferry/aerial/funicular/unknown: `4`, `6`, `7`, `1000–1499` (none of the three)

The pathfinding mode filter (`pathBucketForMode` in index.html, the bus/subway/train toggles) handles all of these. **Latent bug to watch:** the older `gtfsModeToOsm` (index.html ~line 14941, used for the map ROUTE OVERLAY) only switches on 0–12 and defaults everything else to `'bus'` — so extended metro/rail codes (400s/100s) get mislabeled as bus in the overlay legend. Not fixed (out of scope for the pathfinding-filter work); fix `gtfsModeToOsm` if overlay mode labels look wrong. Related: [[project_transit_data_expiry]].

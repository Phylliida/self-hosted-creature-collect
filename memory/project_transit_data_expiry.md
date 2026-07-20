---
name: project_transit_data_expiry
description: Bundled GTFS transit data is a static snapshot whose service calendars expire; needs periodic re-ingest
metadata:
  type: project
---

The transit/bus schedule data is a **static GTFS snapshot** (built ~2026-04-22 for `data/schedule.sqlite`, regions repartitioned 2026-05-20). GTFS feeds only publish a few months of forward `calendar`/`calendar_dates`, so the data **expires**. As of 2026-07-05, **82% of service rows (18391/22332) had already passed their `end_date`.**

**Symptom of expiry:** a stop's popup lists the route rows ("lines at this stop") but every one says **"no upcoming — tap for full schedule."** Route/pattern rows come from static structure and always render; departures are date-filtered by `activeServicesForDate` (in `static/index.html`, ~line 14815) → when no service calendar covers today, `nextDeparturesForOsmNodes` returns zero trips. So "rows show, times empty" == expired calendar, NOT a code bug.

**The user is in the Montreal area.** Their agencies expired: STM (`stm` feed) ran 2026-01-05→**2026-06-14**; the whole **exo** commuter network →2026-06-21; STL Laval (`mdb-749`)→2026-06-19; STL Lévis (`mdb-763`). This is why "it worked until ~mid-June then stopped."

**Routing is the same data:** the transit trip planner (`static/trip-planner.js`, a time-dependent Dijkstra) reads the SAME `scheduleIdx` built from `/schedule`. So refreshing the schedule fixes the trip planner too — no separate step. `*.routes.sqlite` (built by `build-routes-db.py` from OSM `type=route` relations = the drawn route lines/overlay) and the walk graph have NO service calendar and do NOT expire; leave them alone.

**Real fix = `update-transit-schedules.py`** — one self-contained, cron-safe script (I wrote it) that rebuilds `data/schedule.sqlite` (served by `/schedule` in run.py, `SCHEDULE_PATH`) + re-exports every `regions/region-*/schedule.json` (gzipped) and touches NOTHING else (walk/poi/tiles/addresses untouched). Steps it runs: (1) fresh `ingest-gtfs.py` of the feeds TSVs into a temp DB (feed URLs already serve current data; feeds-ca.tsv line 132 = STM slug `stm`), (2) `link-gtfs-to-osm.py` → `gtfs_osm_link`, (3) sanity-check + atomic swap into schedule.sqlite (keeps `.bak`; `validate_db` refuses to swap an empty/<50%-trips rebuild), (4) export region files directly from the DB — **no running server needed**. Compares decompressed content so unchanged regions aren't rewritten; prints per-FEED expiry (expired before→after) as the "did it work" signal. Flags: `--feeds` (default all feeds-*.tsv; use `--feeds feeds-ca.tsv` for a fast CA-only Montreal fix), `--skip-rebuild` (just re-export from current DB, no network), `--dry-run`, `--only-transit`, `--allow-shrink`, `--keep-temp`. Network-heavy offline build step, so [[feedback_zero_network]] doesn't apply. Good cron candidate (example crontab in the script's docstring).

**Shared query module `schedule_query.py`** = `build_schedule_payload(conn, w,s,e,n)` + `_in_chunks` + `EMPTY_PAYLOAD`. Refactored OUT of run.py's `/schedule` endpoint (2026-07-05) so the endpoint and the offline exporter can't drift — verified byte-identical to the old inline endpoint across MTL/NYC/LA/empty bboxes. run.py now imports it (change takes effect on next server restart). `build-regions.py` remains the full all-artifacts builder; update-transit-schedules.py is the surgical schedule-only path. (An earlier server-based `refresh-schedules.py` was consolidated INTO update-transit-schedules.py and deleted.)

Needs redoing every few months — good automation candidate. Done: `scripts/update-transit-and-upload.sh` chains `update-transit-schedules.py` (full all-feeds default) → `scripts/upload-regions.sh`, with flock overlap protection + logging to `logs/transit-refresh.log`; example monthly crontab in its header.

**Optional graceful-degradation fix (not yet built):** when a feed is fully expired, fall back to the most recent equivalent weekday inside its valid window + a "schedule may be outdated" banner, instead of silently showing nothing.

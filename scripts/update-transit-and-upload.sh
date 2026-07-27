#!/usr/bin/env bash
# Refresh all transit schedules from current GTFS feeds, then upload the
# changed region files to the Hugging Face maps dataset. Built for cron.
#
#   1. update-transit-schedules.py — downloads current GTFS feeds,
#      rebuilds data/schedule.sqlite (atomic swap, keeps .bak), and
#      re-exports every regions/<id>/schedule.json. It refuses to swap a
#      suspiciously-small rebuild, so a bad download day can't poison
#      the live DB.
#   2. scripts/upload-regions.sh — uploads only the files that changed
#      (in practice just the schedule.json exports; everything else is
#      skipped by hash comparison).
#
# Cron-safety baked in:
#   * flock so overlapping runs can't stack up (a skipped run exits 0)
#   * everything logs to logs/transit-refresh.log
#   * PATH gets ~/.venv/bin prepended (hf + python3 live there and
#     cron's PATH is minimal)
#   * the upload only runs if the transit refresh succeeded
#   * exit code is non-zero on failure
#
# Download-maximizing defaults (from update-transit-schedules.py):
#   * feeds-*.tsv refreshed from the Mobility Database catalog each run
#   * failed downloads retried twice more (transient timeouts/resets)
#   * bot-blocked feeds retried through a real browser (zendriver);
#     disable with --no-browser-fallback if chromium/Xvfb is unwanted
#
# Example user crontab (`crontab -e`) — 03:30 every Sunday:
#   30 3 * * 0 /home/bepis/prog/SimpleBot/repos/self-hosted-creature-collect/scripts/update-transit-and-upload.sh
#
# Watch a running job with: tail -f logs/transit-refresh.log
#
# Any extra args are passed through to update-transit-schedules.py, e.g.
# a fast Montreal-area-only refresh (shrinks coverage, hence the flag):
#   scripts/update-transit-and-upload.sh --feeds feeds-ca.tsv --allow-shrink

set -euo pipefail
trap 'echo "=== run FAILED $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit $?) ==="' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# cron's PATH is minimal — hf and python3 both live in the user venv.
[ -d "$HOME/.venv/bin" ] && PATH="$HOME/.venv/bin:$PATH"

LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/transit-refresh.log" 2>&1

# Skip quietly if a previous run is still going: a full GTFS re-ingest
# can take a long while, and two concurrent rebuilds would trample each
# other's temp DBs.
exec 9>"$LOG_DIR/.transit-upload.lock"
if ! flock -n 9; then
  echo "another update-transit-and-upload run is still in progress — skipping"
  exit 0
fi

# huggingface_hub progress bars spam log files; the plain status-report
# lines (uploaded X/Y files) are kept.
export HF_HUB_DISABLE_PROGRESS_BARS=1

echo ""
echo "=== run started $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo "--- step 1/2: transit schedule refresh"
python3 update-transit-schedules.py "$@"

echo "--- step 2/2: upload changed region files"
scripts/upload-regions.sh

echo "=== run finished OK $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

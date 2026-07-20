#!/usr/bin/env bash
# Upload the built regions/ tree to the Hugging Face maps dataset.
#
# `hf upload-large-folder` hashes every local file, compares each hash
# against the remote repo state, and only uploads new / changed files —
# so this is safe to re-run after a rebuild; unchanged regions are
# skipped. A hash cache in regions/.cache/ makes re-runs fast, and an
# interrupted upload resumes where it left off (just run it again).
# Remote files that no longer exist locally are left untouched.
#
# The env vars + low worker count are empirically needed to actually
# finish a multi-GB upload over residential bandwidth without hanging —
# see "Upload to Hugging Face Datasets" in README.md for the details.
#
# Usage:
#   scripts/upload-regions.sh [repo-id]        # default TessaCoil/maps-dataset
#   NUM_WORKERS=4 scripts/upload-regions.sh    # default 2 (residential-safe)

set -euo pipefail

REPO_ID="${1:-TessaCoil/maps-dataset}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v hf >/dev/null 2>&1; then
  echo "ERROR: hf CLI not found — pip install huggingface_hub hf_transfer, then hf auth login" >&2
  exit 1
fi
if [ ! -d regions ]; then
  echo "ERROR: regions/ not found in $REPO_ROOT — run build-regions.py first" >&2
  exit 1
fi

export HF_HUB_DISABLE_XET=1
export HF_HUB_ENABLE_HF_TRANSFER=1

exec hf upload-large-folder "$REPO_ID" regions/ \
  --repo-type=dataset \
  --num-workers="${NUM_WORKERS:-2}"

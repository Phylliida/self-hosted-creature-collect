#!/usr/bin/env bash
# Upload a built creature content pack to a Hugging Face dataset.
#
# `hf upload-large-folder` hashes every local file, compares each hash
# against the remote repo state, and only uploads new / changed files —
# so this is safe to re-run after a rebuild; unchanged files are
# skipped. An interrupted upload resumes where it left off (just run it
# again). Remote files that no longer exist locally are left untouched.
#
# Usage:
#   scripts/upload-content-pack.sh [repo-id] [folder]
#     defaults: TessaCoil/creature-pack  packs/creature-fusion
#   scripts/upload-content-pack.sh TessaCoil/neopets-pack packs/neopets
#   NUM_WORKERS=4 scripts/upload-content-pack.sh   # default 2 (residential-safe)

set -euo pipefail

REPO_ID="${1:-TessaCoil/creature-pack}"
PACK_DIR="${2:-packs/creature-fusion}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v hf >/dev/null 2>&1; then
  echo "ERROR: hf CLI not found — pip install huggingface_hub hf_transfer, then hf auth login" >&2
  exit 1
fi
if [ ! -f "$PACK_DIR/pack.bin" ]; then
  echo "ERROR: $PACK_DIR/pack.bin not found — run the pack builder first" >&2
  exit 1
fi

export HF_HUB_DISABLE_XET=1
export HF_HUB_ENABLE_HF_TRANSFER=1

exec hf upload-large-folder "$REPO_ID" "$PACK_DIR" \
  --repo-type=dataset \
  --num-workers="${NUM_WORKERS:-2}"


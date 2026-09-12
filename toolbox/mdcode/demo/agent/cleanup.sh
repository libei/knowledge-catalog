#!/bin/bash
# Drops the demo database.
#
# Nothing else to undo: the model and the binding profile are files in this
# directory, and the demo installs its one dependency under demo/agent.
#
# Run from the mdcode package root:  bash demo/agent/cleanup.sh

set -euo pipefail

# The same question setup.sh asks, so the database dropped is the one created.
HERE=$(dirname "$0")
read -r PROJECT INSTANCE DATABASE <<<"$(bun "$HERE/target.ts")"

gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"

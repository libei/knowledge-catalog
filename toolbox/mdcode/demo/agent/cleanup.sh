#!/bin/bash
# Drops the demo database.
#
# Nothing else to undo: the model and the binding profile are files in this
# directory, and the demo installs its one dependency under demo/agent.
#
# Run from the mdcode package root:  bash demo/agent/cleanup.sh

set -euo pipefail

# The same question setup.sh asks, so the database dropped is the one created.
HERE=$(cd "$(dirname "$0")" && pwd)
KCMD=${KCMD:-$HERE/../../dist/kcmd}
IFS=/ read -r PROJECT INSTANCE DATABASE \
  <<<"$(cd "$HERE" && "$KCMD" action list --store)"

gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"

#!/bin/bash
# Drops the demo database.
#
# Nothing else to undo: the model and the binding profile are files in this
# directory, and the demo installs its one dependency under demo/agent.
#
# Run from the mdcode package root:  bash demo/agent/cleanup.sh

set -euo pipefail

PROJECT=${DEMO_CLOUD_PROJECT:-sqlgen-testing}
INSTANCE=${DEMO_SPANNER_INSTANCE:-graph-unified-solution-demo}
DATABASE=${DEMO_SPANNER_DATABASE:-semantic_agent_demo}

gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"

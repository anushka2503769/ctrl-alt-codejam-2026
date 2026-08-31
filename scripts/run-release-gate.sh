#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

stress_passes="${RUNVAULT_STRESS_PASSES:-25}"
if ! [[ "$stress_passes" =~ ^[1-9][0-9]*$ ]]; then
  echo "RUNVAULT_STRESS_PASSES must be a positive integer" >&2
  exit 2
fi

command -v docker >/dev/null
command -v terraform >/dev/null

npm run check

RUN_CONTAINER_INTEGRATION=1 ./node_modules/.bin/vitest run \
  apps/server/src/container-verification-runner.integration.test.ts

terraform fmt -check -recursive deploy/volcengine
LAUNCHPAD_ENV_FILE=.env.example docker compose config --quiet

for ((pass = 1; pass <= stress_passes; pass += 1)); do
  echo "RunVault full-suite stress pass $pass/$stress_passes"
  RUN_CONTAINER_INTEGRATION=1 npm test
done

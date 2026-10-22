#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
export COMPOSE_PROJECT_NAME="capvine-isolation-$(date +%s)-$$"
compose() { docker compose -f examples/isolation/compose.yaml "$@"; }
trap 'compose down --volumes --remove-orphans' EXIT
compose build
compose up -d --wait authority
compose run --rm --no-deps worker
compose stop authority
compose up -d --no-deps --wait authority
compose run --rm --no-deps worker
compose stop authority
compose run --rm --no-deps authority node examples/isolation/revoke.mjs
compose up -d --no-deps --wait authority
compose run --rm --no-deps worker node examples/isolation/worker.mjs --expect-denied
compose stop authority
compose up -d --no-deps --wait authority
compose run --rm --no-deps worker node examples/isolation/worker.mjs --expect-denied

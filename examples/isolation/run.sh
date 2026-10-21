#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
export COMPOSE_PROJECT_NAME="capvine-isolation-$(date +%s)-$$"
compose() { docker compose -f examples/isolation/compose.yaml "$@"; }
trap 'compose down --volumes --remove-orphans' EXIT
compose build
compose up -d --wait authority
compose run --rm --no-deps worker

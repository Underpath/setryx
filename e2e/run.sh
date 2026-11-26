#!/bin/sh
# Runs the end-to-end test against a fresh, throwaway setryx and cleans up after.
#   sh e2e/run.sh
set -u
cd "$(dirname "$0")/.."
compose="docker compose -f docker-compose.e2e.yml"
$compose down --remove-orphans >/dev/null 2>&1
$compose build --quiet app
$compose run --rm e2e
status=$?
$compose down --remove-orphans >/dev/null 2>&1
exit $status

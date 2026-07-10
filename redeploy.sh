#!/bin/sh
# Redeploys the bot: down -> build -> up, then tails logs so you can see it come online.
set -eu

cd "$(dirname "$0")"

echo "==> docker compose down"
docker compose down

echo "==> docker compose build"
docker compose build

echo "==> docker compose up -d"
docker compose up -d

echo "==> pruning dangling images left over from old builds"
docker image prune -f

#!/usr/bin/env sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CLAW_TASK_HUB_SERVE_UI=1
export CLAW_TASK_HUB_HOST=${CLAW_TASK_HUB_HOST:-127.0.0.1}
export PORT=${PORT:-4781}
printf 'Claw Task Hub %s is starting at http://%s:%s\n' "$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$package_root/package.json")" "$CLAW_TASK_HUB_HOST" "$PORT"
exec "$package_root/runtime/bun" "$package_root/server/index.ts"

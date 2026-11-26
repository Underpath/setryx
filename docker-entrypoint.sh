#!/bin/sh
# Starts Setryx as PUID:PGID (default 1000:1000). When the container starts as
# root, it first gives /data and /images to that user, so host folders and old
# volumes owned by someone else just work, then drops root before Node runs.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  for dir in "${DATA_DIR:-/data}" "${IMAGES_DIR:-/images}"; do
    mkdir -p "$dir"
    # Only touch what isn't already right, so a large folder isn't rewritten on every start.
    find "$dir" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +
  done
  exec su-exec "$PUID:$PGID" "$@"
fi

# Started as another user already (compose `user:`, rootless Docker): run as is.
exec "$@"

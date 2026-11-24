#!/bin/bash
# Creates the portal's first administrator ("admin") from the OVF property, once the portal answers; then forgets it.
set -euo pipefail
PW=/etc/holodeck-appliance/admin-password
[ -s "$PW" ] || exit 0
for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:3080/api/health >/dev/null 2>&1 && break; sleep 5; done
P="$(cat "$PW")"
if printf '%s\n%s\n' "$P" "$P" | docker exec -i holodeck-portal sh -c 'cd /opt/holodeck-portal/server && node dist/cli.js create-admin admin'; then
  echo "[holodeck] portal administrator 'admin' created"
else
  echo "[holodeck] could not create the administrator (it may exist already); see: docker exec -it holodeck-portal node /opt/holodeck-portal/server/dist/cli.js" >&2
fi
shred -u "$PW" 2>/dev/null || rm -f "$PW"

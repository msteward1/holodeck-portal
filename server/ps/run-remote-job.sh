#!/bin/bash
# Runs one portal job on a secondary Holorouter over SSH. Holodeck configures the machine it runs on,
# so jobs for a router's lab must execute there.
# Usage: run-remote-job.sh <job-dir> <router-address>
#
# The job runs remotely under the same run-job.sh/entry.ps1/lib.ps1 (copied each time, so the router
# always has the portal's current version) in its own transient unit, so an SSH drop never kills it.
# This script mirrors the remote output.log into the local one, forwards prompt answers written to
# the local input file, and finally copies result.json and exitcode back. The portal itself only
# ever looks at the local job directory.
#
# HP_ATTACH=1 re-attaches to a job already running on the router (the portal restarted and this relay with it):
# nothing is sent or started; mirroring and answer forwarding continue from the offsets saved in the job directory.
set -u
JOBDIR="$1"
HOST="$2"
PSDIR="$(cd "$(dirname "$0")" && pwd)"
ID="$(basename "$JOBDIR")"
SSHDIR="${HP_SSH_DIR:-/var/lib/holodeck-portal/ssh}"
AGENT=/opt/holodeck-portal-agent
RDIR="/var/lib/holodeck-portal-agent/jobs/$ID"
# Its own name: the portal may run on a Holorouter it also manages, where the local relay unit has the job's name.
UNIT="holoportal-remote-job-$ID"
# Give up when the router has been unreachable this long (it may be rebooting during a deployment).
UNREACHABLE_LIMIT="${HP_REMOTE_UNREACHABLE_SECS:-1800}"

cd "$JOBDIR" || exit 90
umask 077

SSH=(ssh -i "$SSHDIR/id_ed25519" -o UserKnownHostsFile="$SSHDIR/known_hosts" -o StrictHostKeyChecking=yes
  -o BatchMode=yes -o IgnoreUnknown=WarnWeakCrypto -o WarnWeakCrypto=no -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
  -o ControlMaster=auto -o ControlPath="${HP_SSH_CONTROL_DIR:-$SSHDIR}/cm-%C" -o ControlPersist=120 "root@$HOST")

note() {
  # Own line, even after a prompt that has no newline yet.
  if [ -s output.log ] && [ "$(tail -c 1 output.log | od -An -c | tr -d ' ')" != '\n' ]; then echo >> output.log; fi
  printf '\033[90m[portal] %s\033[0m\n' "$*" >> output.log
}
finish() {
  echo "$1" > exitcode
  : > input
  # However the job ended (cancelled, lost, failed), don't leave its secrets on the router; best effort.
  if [ -n "${SENT:-}" ]; then
    "${SSH[@]}" "rm -f $RDIR/result.json $RDIR/input $RDIR/job.json" >/dev/null 2>&1
  fi
  exit "$1"
}

stop_remote() {
  note "Stopping the job on $HOST"
  "${SSH[@]}" "systemctl stop $UNIT.service" >/dev/null 2>&1
  finish 143
}
trap stop_remote TERM INT

if [ "${HP_ATTACH:-}" = 1 ]; then
  [ -f .remote_started ] || { note "Nothing to re-attach to on $HOST"; finish 95; }
  SENT=1
  note "Re-attached to the job on $HOST after a portal restart"
else
note "Running on Holorouter $HOST"
if ! tar -C "$PSDIR" -cf - run-job.sh entry.ps1 lib.ps1 vi-compat.ps1 |
  "${SSH[@]}" "mkdir -p $AGENT/ps && tar -C $AGENT/ps -xf - && chmod 755 $AGENT/ps/run-job.sh"; then
  note "Could not copy the portal runner to $HOST"
  finish 91
fi
if ! "${SSH[@]}" "install -d -m 700 $RDIR && umask 077 && cat > $RDIR/job.json && : > $RDIR/input" < job.json; then
  note "Could not send the job to $HOST"
  finish 92
fi
SENT=1
# The job file holds secrets; the remote copy is deleted by entry.ps1 once read.
rm -f job.json
if ! "${SSH[@]}" "systemd-run --unit=$UNIT --collect --quiet --description='Holodeck Portal job' --setenv=HOME=/root /bin/bash $AGENT/ps/run-job.sh $RDIR"; then
  note "Could not start the job on $HOST"
  finish 93
fi
echo 0 > .remote_off
echo 0 > .input_sent
: > .remote_started
fi

# Offsets live in files so a re-attached relay continues exactly where this one stopped. The remote offset counts
# the router's log only (the local log also has these [portal] notes).
roff=$(cat .remote_off 2>/dev/null || echo 0)
sent=$(cat .input_sent 2>/dev/null || echo 0)
mirror() {
  # Appends new remote output; status on stderr (DONE once the remote job has written its exit code).
  "${SSH[@]}" "tail -c +$((roff + 1)) $RDIR/output.log 2>/dev/null; [ -f $RDIR/exitcode ] && echo DONE >&2; true" > .chunk 2> .remote_status || return 1
  cat .chunk >> output.log
  roff=$((roff + $(stat -c %s .chunk)))
  echo "$roff" > .remote_off
}
last_ok=$(date +%s)
while true; do
  if mirror; then
    last_ok=$(date +%s)
    if grep -qx DONE .remote_status; then
      mirror || true
      "${SSH[@]}" "cat $RDIR/result.json 2>/dev/null" > result.json 2>/dev/null || true
      [ -s result.json ] || rm -f result.json
      rc=$("${SSH[@]}" "cat $RDIR/exitcode" 2>/dev/null | tr -dc '0-9')
      # Results and answers can hold credentials; the log stays on the router for troubleshooting.
      "${SSH[@]}" "rm -f $RDIR/result.json $RDIR/input $RDIR/job.json" >/dev/null 2>&1
      rm -f .remote_status .chunk
      finish "${rc:-1}"
    fi
  elif [ $(($(date +%s) - last_ok)) -ge "$UNREACHABLE_LIMIT" ]; then
    note "Lost contact with $HOST for $((UNREACHABLE_LIMIT / 60)) minutes; the job may still be running there."
    finish 94
  fi

  # Forward answers typed in the portal.
  isz=$(stat -c %s input 2>/dev/null || echo 0)
  if [ "$isz" -gt "$sent" ]; then
    if tail -c +$((sent + 1)) input | head -c $((isz - sent)) | "${SSH[@]}" "cat >> $RDIR/input"; then
      sent=$isz
      echo "$sent" > .input_sent
    fi
  fi
  sleep 1 &
  wait $!
done

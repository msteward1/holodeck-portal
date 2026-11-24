#!/bin/bash
# Runs one portal job: pwsh inside a pseudo-terminal, fed from the job's input file.
# Usage: run-job.sh <job-dir>
# Writes <job-dir>/output.log, result.json (from entry.ps1) and exitcode.
set -u
JOBDIR="$1"
PSDIR="$(cd "$(dirname "$0")" && pwd)"
cd "$JOBDIR" || exit 90
umask 077

# Match an interactive root shell on the Holorouter: Holodeck shells out to kubectl,
# python kubernetes clients and ovftool.
set +u
[ -r /etc/profile ] && . /etc/profile >/dev/null 2>&1
set -u
export KUBECONFIG="${KUBECONFIG:-/etc/kubernetes/admin.conf}"
case ":$PATH:" in *:/opt/ovftool:*) ;; *) export PATH="$PATH:/opt/ovftool" ;; esac
: >> input
rm -f pwsh.pid

# script(1) only exits once its stdin reaches EOF, so this keeps it open until pwsh exits. Nothing is typed into
# the terminal: prompt answers are read from the input file by the Read-Host override (lib.ps1), and Holodeck's
# "press any key to abort" countdowns ([console]::KeyAvailable) must never see stray bytes.
feeder() {
  while [ ! -s pwsh.pid ]; do sleep 0.2; done
  exec tail -f -s 1 --pid="$(cat pwsh.pid)" /dev/null
}

export TERM=xterm-256color HOME="${HOME:-/root}"
# A trust bundle chosen by the portal (strict vCenter sign-in): OpenSSL reads it only from the process environment.
if [ -s ssl-cert-file ] && [ -r "$(cat ssl-cert-file)" ]; then export SSL_CERT_FILE="$(cat ssl-cert-file)"; fi
# util-linux 2.38's `script -e` reports 0 when its stdin is a pipe, so the shell inside records
# pwsh's own exit code in pwsh.rc (pwsh.pid is that shell, which lives exactly as long as pwsh).
rm -f pwsh.rc
script -q -f -e -c "stty -echo cols 220 rows 60; echo \$\$ > pwsh.pid; '${HP_PWSH:-/usr/bin/pwsh}' -NoProfile -File '$PSDIR/entry.ps1' -JobFile '$JOBDIR/job.json'; echo \$? > pwsh.rc" /dev/null \
  < <(feeder) >> output.log 2>&1
src=$?
if [ -s pwsh.rc ]; then
  rc=$(tr -dc '0-9' < pwsh.rc)
  rc=${rc:-97}
elif [ "$src" -ne 0 ]; then
  rc=$src
else
  rc=98   # pwsh never reported back (killed); never count that as success
fi
echo "$rc" > exitcode
# Answers to prompts may contain secrets; they are no longer needed.
: > input
exit "$rc"

#!/bin/bash
# Copies one staged installation file from one Holorouter (the source) to another, streamed through the portal.
# Usage: stage-file.sh <dest-address> <source-address> <source-file> <dest-dir>
#
# Both ends use the portal's SSH key and pinned host keys, so the routers never need to trust each other and the
# portal stores nothing (rsync isn't installed on Holorouters, and installing packages on them is avoided).
# Resumable: data goes to <dest-dir>/.<name>.holoportal-partial and a rerun continues from its size. The file only
# gets its real name once the SHA-256 sums on both routers match, so Holodeck never sees a half-copied file.
set -euo pipefail
ADDR="$1"; SRC_ADDR="$2"; SRC="$3"; DEST="$4"
NAME="$(basename "$SRC")"
PART="$DEST/.$NAME.holoportal-partial"
SSHDIR="${HP_SSH_DIR:?HP_SSH_DIR not set}"
ssh_to() {
  local host="$1"; shift
  ssh -i "$SSHDIR/id_ed25519" -o "UserKnownHostsFile=$SSHDIR/known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IgnoreUnknown=WarnWeakCrypto -o WarnWeakCrypto=no -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 \
    -o ControlMaster=auto -o "ControlPath=${HP_SSH_CONTROL_DIR:-$SSHDIR}/cm-stage-%C" -o ControlPersist=60 "root@$host" "$@"
}
DST() { ssh_to "$ADDR" "$@"; }
SRCH() { ssh_to "$SRC_ADDR" "$@"; }

case "$NAME" in *[!A-Za-z0-9._-]*) echo "Unexpected file name: $NAME" >&2; exit 2 ;; esac
SIZE=$(SRCH "stat -c %s '$SRC'" </dev/null)
human() { numfmt --to=iec --suffix=B --format='%.1f' "$1"; }

DST "mkdir -p '$DEST'" </dev/null
read -r FINAL_SIZE PART_SIZE < <(DST "echo \$(stat -c %s '$DEST/$NAME' 2>/dev/null || echo -1) \$(stat -c %s '$PART' 2>/dev/null || echo 0)" </dev/null)

if [ "$FINAL_SIZE" = "$SIZE" ]; then
  echo "$NAME is already on $ADDR ($(human "$SIZE")); verifying it."
  TARGET="$DEST/$NAME"
else
  if [ "$FINAL_SIZE" != "-1" ]; then
    echo "A different $NAME ($(human "$FINAL_SIZE")) is on $ADDR; it will be replaced once the copy is verified."
  fi
  OFF="$PART_SIZE"
  if [ "$OFF" -gt "$SIZE" ]; then DST "rm -f '$PART'" </dev/null; OFF=0; fi
  if [ "$OFF" -gt 0 ]; then
    echo "Resuming $NAME at $(human "$OFF") of $(human "$SIZE")"
  else
    echo "Copying $NAME ($(human "$SIZE")) from $SRC_ADDR to $ADDR:$DEST"
  fi
  if [ "$OFF" -lt "$SIZE" ]; then
    START=$(date +%s)
    SRCH "tail -c +$((OFF + 1)) '$SRC'" </dev/null | DST "cat >> '$PART'" &
    COPY=$!
    while kill -0 "$COPY" 2>/dev/null; do
      for _ in $(seq 1 20); do kill -0 "$COPY" 2>/dev/null || break; sleep 1; done
      kill -0 "$COPY" 2>/dev/null || break
      NOW=$(DST "stat -c %s '$PART'" </dev/null 2>/dev/null || echo "$OFF")
      ELAPSED=$(( $(date +%s) - START )); [ "$ELAPSED" -gt 0 ] || ELAPSED=1
      RATE=$(( (NOW - OFF) / ELAPSED ))
      ETA=$([ "$RATE" -gt 0 ] && echo $(( (SIZE - NOW) / RATE )) || echo 0)
      printf '  %s  %3d%%  %s of %s  %s/s  ~%dm%02ds left\n' "$NAME" $(( NOW * 100 / SIZE )) "$(human "$NOW")" "$(human "$SIZE")" "$(human "$RATE")" $((ETA / 60)) $((ETA % 60))
    done
    wait "$COPY" || { echo "The copy of $NAME was interrupted; staging again resumes it." >&2; exit 1; }
  fi
  TARGET="$PART"
fi

echo "Verifying SHA-256 of $NAME on both routers"
SRC_SUM_FILE=$(mktemp)
SRCH "sha256sum '$SRC'" </dev/null | cut -d' ' -f1 > "$SRC_SUM_FILE" &
SRC_JOB=$!
DST_SUM=$(DST "sha256sum '$TARGET'" </dev/null | cut -d' ' -f1)
wait "$SRC_JOB"
SRC_SUM=$(cat "$SRC_SUM_FILE"); rm -f "$SRC_SUM_FILE"
if [ -z "$SRC_SUM" ] || [ "$SRC_SUM" != "$DST_SUM" ]; then
  echo "Checksum mismatch for $NAME ($SRC_ADDR ${SRC_SUM:-?}, $ADDR ${DST_SUM:-?}); the copy was discarded." >&2
  DST "rm -f '$PART'" </dev/null
  [ "$TARGET" = "$DEST/$NAME" ] && DST "rm -f '$DEST/$NAME'" </dev/null
  exit 1
fi
if [ "$TARGET" = "$PART" ]; then
  DST "chmod 644 '$PART' && mv -f '$PART' '$DEST/$NAME'" </dev/null
fi
echo "Staged $NAME (sha256 $SRC_SUM)"

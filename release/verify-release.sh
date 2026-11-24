#!/bin/bash
# Verifies a Holodeck Portal release and loads its image, for container installs (the appliance does this itself).
#
#   verify-release.sh holodeck-portal-X.Y.Z.hpupdate        # the offline bundle, or
#   verify-release.sh <folder>                              # a folder with the release's three files
#   options: --key <public key PEM>   (default: keys/release-signing.pub next to this script)
#
# Checks, in order, before anything runs: the manifest is signed by the trusted key (Ed25519, exact bytes), it is for
# holodeck-portal, the image file's size and SHA-256 match it; then loads the image and checks that Docker's image ID
# is the one the manifest names (otherwise the loaded image is removed again). Prints the command to switch to it.
# Needs: bash, tar, openssl 3, sha256sum, python3, docker.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="$HERE/keys/release-signing.pub"
SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) SRC="$1" ;;
  esac
  shift
done
[ -n "$SRC" ] || { echo "usage: verify-release.sh <release.hpupdate | folder> [--key public-key.pem]" >&2; exit 2; }
[ -r "$KEY" ] || { echo "trusted public key $KEY not found" >&2; exit 2; }
fail() { echo "NOT VERIFIED: $*" >&2; exit 1; }

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
if [ -f "$SRC" ]; then
  # The bundle must hold exactly the three expected plain files.
  names=$(tar -tf "$SRC" | sort | tr '\n' ' ')
  [[ "$names" =~ ^holodeck-portal-[0-9]+\.[0-9]+\.[0-9]+\.image\.tar\.gz\ manifest\.json\ manifest\.json\.sig\ $ ]] || fail "not a Holodeck Portal update bundle ($names)"
  tar -xf "$SRC" -C "$W" --no-same-owner --no-same-permissions
  MANIFEST="$W/manifest.json"; SIG="$W/manifest.json.sig"; DIR="$W"
elif [ -d "$SRC" ]; then
  MANIFEST=$(ls "$SRC"/holodeck-portal-*.manifest.json 2>/dev/null | head -1); SIG="$MANIFEST.sig"; DIR="$SRC"
  [ -n "$MANIFEST" ] && [ -f "$SIG" ] || fail "no holodeck-portal-*.manifest.json and .sig in $SRC"
else
  fail "$SRC not found"
fi
for f in "$MANIFEST" "$SIG"; do [ -f "$f" ] && [ ! -L "$f" ] || fail "$(basename "$f") is not a plain file"; done

# 1. Signature over the manifest's exact bytes, with the trusted key.
KEY_ID=$(openssl pkey -pubin -in "$KEY" -outform DER | sha256sum | cut -c1-16)
read -r SIG_KEY SIG_B64 < <(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["keyId"], d["signature"])' "$SIG") || fail "malformed signature file"
[ "$SIG_KEY" = "$KEY_ID" ] || fail "signed with key $SIG_KEY, not the trusted key $KEY_ID"
printf '%s' "$SIG_B64" | base64 -d > "$W/sig.bin" 2>/dev/null || fail "malformed signature"
openssl pkeyutl -verify -rawin -pubin -inkey "$KEY" -in "$MANIFEST" -sigfile "$W/sig.bin" >/dev/null 2>&1 || fail "the signature does not match the manifest"

# 2. The manifest's content.
read -r VERSION FILE SIZE SHA ID TAG < <(python3 -I -c '
import json, re, sys
m = json.load(open(sys.argv[1])); i = m["image"]
ok = (m.get("product") == "holodeck-portal" and re.fullmatch(r"\d+\.\d+\.\d+", m["version"])
      and i["file"] == "holodeck-portal-%s.image.tar.gz" % m["version"] and i["tag"] == "holodeck-portal:%s" % m["version"]
      and re.fullmatch(r"[0-9a-f]{64}", i["sha256"]) and re.fullmatch(r"sha256:[0-9a-f]{64}", i["id"]) and int(i["size"]) > 0)
if not ok: sys.exit(1)
print(m["version"], i["file"], i["size"], i["sha256"], i["id"], i["tag"])' "$MANIFEST") || fail "the manifest is not a valid Holodeck Portal manifest"

# 3. The image file.
IMG="$DIR/$FILE"
[ -f "$IMG" ] && [ ! -L "$IMG" ] || fail "$FILE not found next to the manifest"
[ "$(stat -c %s "$IMG")" = "$SIZE" ] || fail "$FILE has the wrong size"
[ "$(sha256sum "$IMG" | cut -d' ' -f1)" = "$SHA" ] || fail "$FILE does not match the signed SHA-256"
echo "Signature and image file verified: Holodeck Portal $VERSION (key $KEY_ID)"

# 4. Load from the copy that was checked, then compare the image ID.
docker load -i "$IMG" >/dev/null
LOADED=$(docker image inspect -f '{{.Id}}' "$TAG" 2>/dev/null || true)
if [ "$LOADED" != "$ID" ]; then
  docker rmi "$TAG" >/dev/null 2>&1 || true
  fail "the loaded image ID ($LOADED) is not the signed one ($ID); it was removed"
fi
echo "Loaded $TAG (image $ID)."
echo "Switch to it (next to docker-compose.yml; back up the volumes first):"
echo "  HP_PORTAL_IMAGE=$TAG docker compose up -d     # or set HP_PORTAL_IMAGE in .env"

#!/bin/bash
# Builds, signs and (optionally) publishes a Holodeck Portal release.
#
#   release/build-release.sh <version> [--dev] [--min-from <version>] [--notes <file>] [--publish gitlab]
#
# Output in release/out/<version>/:
#   holodeck-portal-<v>.image.tar.gz         the container image (docker save | gzip)
#   holodeck-portal-<v>.manifest.json        version, image SHA-256/size/ID, minimum version to update from, notes
#   holodeck-portal-<v>.manifest.json.sig    Ed25519 signature of the manifest's exact bytes, with the key ID
#   holodeck-portal-<v>.hpupdate             all three in one file, for offline updates (About -> Updates -> Upload)
#
# Signing: the release key (~/.holodeck-release/release-signing.key, encrypted; openssl asks for the passphrase, or
# set HP_SIGNING_PASSFILE) or, with --dev, the development key, which only appliances set up for testing trust.
# Publishing to GitLab needs GITLAB_TOKEN_FILE (a token with api scope); GitLab URL and project come from the origin
# remote, which must be https:// (HP_ALLOW_HTTP_PUBLISH=1 accepts plain HTTP). GitHub publishing (gh release create) is added when the public repository exists.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: build-release.sh <version> [--dev] [--min-from <v>] [--notes <file>] [--publish gitlab]}"; shift
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z" >&2; exit 2; }
KEY=release; MIN_FROM=0.4.0; NOTES=""; PUBLISH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) KEY=dev ;;
    --min-from) MIN_FROM="$2"; shift ;;
    --notes) NOTES="$2"; shift ;;
    --publish) PUBLISH="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
KEYDIR="${HP_RELEASE_KEYDIR:-$HOME/.holodeck-release}"
KEYFILE="$KEYDIR/$KEY-signing.key"
[ -r "$KEYFILE" ] || { echo "signing key $KEYFILE not found" >&2; exit 2; }
for f in server/package.json web/package.json; do
  grep -q "\"version\": \"$VERSION\"" "$f" || { echo "$f is not at version $VERSION" >&2; exit 2; }
done
[ -z "$(git status --porcelain)" ] || { echo "the working tree has uncommitted changes; commit first" >&2; exit 2; }
COMMIT=$(git rev-parse HEAD)
OUT="release/out/$VERSION"; rm -rf "$OUT"; mkdir -p "$OUT"
P="holodeck-portal-$VERSION"

echo "==> Building the image ($COMMIT)"
docker build -q --network host --build-arg HP_VERSION="$VERSION" --build-arg HP_COMMIT="$COMMIT" -t "holodeck-portal:$VERSION" . >/dev/null
echo "==> Saving it"
docker save "holodeck-portal:$VERSION" | gzip -6 > "$OUT/$P.image.tar.gz"
IMAGE_ID=$(docker image inspect -f '{{.Id}}' "holodeck-portal:$VERSION")

echo "==> Writing the manifest"
NOTES_TEXT=""; [ -n "$NOTES" ] && NOTES_TEXT=$(cat "$NOTES")
NOTES_TEXT="$NOTES_TEXT" node -e '
const fs = require("fs"), crypto = require("crypto");
const [out, p, version, minFrom, id] = process.argv.slice(1);
const file = `${p}.image.tar.gz`;
const data = fs.readFileSync(`${out}/${file}`);
const m = { product: "holodeck-portal", version, published: new Date().toISOString(), minFromVersion: minFrom,
  image: { file, sha256: crypto.createHash("sha256").update(data).digest("hex"), size: data.length, id, tag: `holodeck-portal:${version}` },
  notes: process.env.NOTES_TEXT || "" };
fs.writeFileSync(`${out}/${p}.manifest.json`, JSON.stringify(m, null, 2) + "\n");
' "$OUT" "$P" "$VERSION" "$MIN_FROM" "$IMAGE_ID"

echo "==> Signing with the $KEY key"
PASS=(); [ -n "${HP_SIGNING_PASSFILE:-}" ] && PASS=(-passin "file:$HP_SIGNING_PASSFILE")
openssl pkeyutl -sign -rawin -inkey "$KEYFILE" "${PASS[@]}" -in "$OUT/$P.manifest.json" -out "$OUT/sig.bin"
KEY_ID=$(openssl pkey -pubin -in "$KEYDIR/$KEY-signing.pub" -outform DER | sha256sum | cut -c1-16)
openssl pkeyutl -verify -rawin -pubin -inkey "$KEYDIR/$KEY-signing.pub" -in "$OUT/$P.manifest.json" -sigfile "$OUT/sig.bin" >/dev/null
printf '{"keyId":"%s","signature":"%s"}\n' "$KEY_ID" "$(base64 -w0 "$OUT/sig.bin")" > "$OUT/$P.manifest.json.sig"
rm -f "$OUT/sig.bin"

echo "==> Offline bundle"
B=$(mktemp -d); cp "$OUT/$P.manifest.json" "$B/manifest.json"; cp "$OUT/$P.manifest.json.sig" "$B/manifest.json.sig"; ln "$OUT/$P.image.tar.gz" "$B/$P.image.tar.gz" 2>/dev/null || cp "$OUT/$P.image.tar.gz" "$B/"
tar -C "$B" -cf "$OUT/$P.hpupdate" manifest.json manifest.json.sig "$P.image.tar.gz"; rm -rf "$B"
( cd "$OUT" && sha256sum "$P".* > SHA256SUMS )
ls -la "$OUT" | awk 'NR>1 && $NF!="." && $NF!=".." {printf "  %-45s %8.1f MB\n", $NF, $5/1048576}'

if [ "$PUBLISH" = gitlab ]; then
  TOKEN=$(tr -d '\r\n ' < "${GITLAB_TOKEN_FILE:?set GITLAB_TOKEN_FILE}")
  REMOTE=$(git remote get-url origin)
  BASE=$(echo "$REMOTE" | sed -E 's#^(https?://)([^@/]+@)?([^/]+)/.*#\1\3#')
  # The publishing token has api scope: never send it unencrypted unless explicitly allowed (lab GitLab without TLS).
  if [[ "$BASE" == http://* && "${HP_ALLOW_HTTP_PUBLISH:-}" != 1 ]]; then
    echo "The GitLab remote is plain HTTP ($BASE): the api token would be sent unencrypted. Use https://, or set HP_ALLOW_HTTP_PUBLISH=1 to accept that." >&2
    exit 2
  fi
  PROJECT=$(echo "$REMOTE" | sed -E 's#^https?://([^@/]+@)?[^/]+/##; s#\.git$##')
  API="$BASE/api/v4/projects/$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$PROJECT")"
  links='[]'
  for f in "$P.manifest.json" "$P.manifest.json.sig" "$P.image.tar.gz" "$P.hpupdate"; do
    echo "==> Uploading $f"
    URL="$API/packages/generic/holodeck-portal/$VERSION/$f"
    curl -fsS -H "PRIVATE-TOKEN: $TOKEN" --upload-file "$OUT/$f" "$URL" >/dev/null
    links=$(node -e 'const l=JSON.parse(process.argv[1]);l.push({name:process.argv[2],url:process.argv[3],link_type:process.argv[2].endsWith(".tar.gz")||process.argv[2].endsWith(".hpupdate")?"package":"other"});console.log(JSON.stringify(l))' "$links" "$f" "$URL")
  done
  echo "==> Creating release v$VERSION"
  body=$(node -e 'console.log(JSON.stringify({tag_name:"v"+process.argv[1],ref:process.argv[2],name:"Holodeck Portal "+process.argv[1],description:process.argv[3]||("Holodeck Portal "+process.argv[1]),assets:{links:JSON.parse(process.argv[4])}}))' "$VERSION" "$COMMIT" "$NOTES_TEXT" "$links")
  curl -fsS -H "PRIVATE-TOKEN: $TOKEN" -H 'content-type: application/json' -d "$body" "$API/releases" >/dev/null
  echo "Published: $BASE/$PROJECT/-/releases/v$VERSION"
fi

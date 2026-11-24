# Releasing Holodeck Portal

Appliances update themselves from signed releases (About → Updates). A release is four files:

| File | What it is |
|---|---|
| `holodeck-portal-X.Y.Z.image.tar.gz` | the container image (`docker save`, gzip) |
| `holodeck-portal-X.Y.Z.manifest.json` | version, image SHA-256, size and image ID, the oldest version it updates from, release notes |
| `holodeck-portal-X.Y.Z.manifest.json.sig` | Ed25519 signature of the manifest's exact bytes, with the signing key's ID |
| `holodeck-portal-X.Y.Z.hpupdate` | the three above in one file, for sites without internet access and for container hosts |

Container hosts verify a release with `release/verify-release.sh <file.hpupdate | folder> [--key …]` (signature with
`keys/release-signing.pub`, size and SHA-256, then `docker load` and a check of the image ID). The portal image
ships the script and keys under `/opt/holodeck-portal/release/`, so an operator can take them from the portal they
already run.

## Keys

* `keys/release-signing.pub` — the release key. Its private half is encrypted with a passphrase and kept offline by the
  maintainer (password manager); it is never stored in this repository or in CI.
* A development key signs test releases (`--dev`). It is kept outside the public repository, and only test
  appliances that were set up to trust it accept those releases.

Appliances trust the keys in `/etc/holodeck-appliance/trusted-keys/`; releases never change that folder. Replacing
the release key therefore means installing the new public key on each appliance by hand.

## Making a release

1. Set the version in `server/package.json` and `web/package.json`, commit.
2. `release/build-release.sh X.Y.Z --notes notes.md --min-from 0.4.0 [--publish gitlab]`
   (`--dev` signs with the development key). The script builds the image, writes and signs the manifest
   (openssl asks for the release key's passphrase), verifies the signature, writes the offline bundle and
   `SHA256SUMS` in `release/out/X.Y.Z/`, and with `--publish gitlab` uploads the files to the project's package
   registry and creates the release `vX.Y.Z` (needs `GITLAB_TOKEN_FILE`, a token with `api` scope; the GitLab remote
   must be `https://` unless `HP_ALLOW_HTTP_PUBLISH=1` is set, since the token would travel unencrypted).
3. Test the release on a throwaway appliance before announcing it.

`--min-from` is the oldest installed version the release can update directly (raise it when a release depends on
a change in an earlier one; older appliances then update in steps).

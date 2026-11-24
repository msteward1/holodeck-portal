#!/bin/bash
# Installs VMware PowerCLI (only the modules the portal uses, at one tested version) into the portal's data volume on
# first start. PowerCLI is Broadcom software whose licence does not allow redistributing it, so the image doesn't
# contain it: each installation downloads it from the PowerShell Gallery (accepting Broadcom's licence), once.
# Runs in the background from entrypoint.sh; retries every 10 minutes until it succeeds. State for the portal:
# $HP_PS_MODULES/../powercli.json  {"state":"installing"|"ready"|"failed","version":…,"message":…,"at":…}
set -uo pipefail
MODULES="${HP_PS_MODULES:?}"
VERSION="${POWERCLI_VERSION:?}"
STATUS="$(dirname "$MODULES")/powercli.json"
mkdir -p "$MODULES"
status() { printf '{"state":"%s","version":"%s","message":"%s","at":"%s"}\n' "$1" "$VERSION" "${2//\"/\'}" "$(date -u +%FT%TZ)" > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"; }
installed() { [ -f "$MODULES/VMware.VimAutomation.Vds/$VERSION/VMware.VimAutomation.Vds.psd1" ] && [ -d "$MODULES/VMware.VimAutomation.Core/$VERSION" ]; }

while ! installed; do
  status installing "Downloading VMware PowerCLI $VERSION from the PowerShell Gallery"
  TMP="$(dirname "$MODULES")/.powercli-download"
  rm -rf "$TMP"; mkdir -p "$TMP"
  if out=$(pwsh -NoProfile -NonInteractive -Command "
      \$ErrorActionPreference = 'Stop'; \$ProgressPreference = 'SilentlyContinue'
      if (-not (Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue)) { Register-PSRepository -Default }
      Save-Module -Name VMware.VimAutomation.Vds -RequiredVersion '$VERSION' -Repository PSGallery -Path '$TMP' -AcceptLicense -Force
  " 2>&1); then
    # Move each module into place (keeps other versions an administrator may have copied in).
    for m in "$TMP"/*; do
      name=$(basename "$m"); mkdir -p "$MODULES/$name"
      for v in "$m"/*; do rm -rf "$MODULES/$name/$(basename "$v")"; mv "$v" "$MODULES/$name/"; done
    done
    rm -rf "$TMP"
  else
    rm -rf "$TMP"
    status failed "$(echo "$out" | tail -3 | tr '\n' ' ' | cut -c1-300)"
    sleep 600
  fi
done
# Every start: no CEIP prompt or warning (this setting lives in the container, not the volume).
pwsh -NoProfile -NonInteractive -Command "Import-Module VMware.VimAutomation.Core; Set-PowerCLIConfiguration -Scope AllUsers -ParticipateInCEIP \$false -Confirm:\$false | Out-Null" >/dev/null 2>&1 || true
status ready "VMware PowerCLI $VERSION is installed"

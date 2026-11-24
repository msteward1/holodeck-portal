# Holodeck Portal appliance (Photon OS OVA)

The OVA is Photon OS 5 running the portal's container image (`holodeck-portal:current`, see the repository's
Dockerfile) as `holodeck-portal.service`, with its data on a second disk (`/data`: Docker storage and the portal's
`/var/lib/holodeck-portal` and `/etc/holodeck-portal`).

## Deploying

Deploy the OVA with vCenter or directly on an ESXi host (Host Client, or `ovftool --X:injectOvfEnv`); both pass
the deployment properties to the VM. Properties: hostname, DNS domain, IPv4 address (empty = DHCP), prefix, gateway, DNS
servers, NTP servers, portal DNS name (defaults to hostname.domain), portal administrator password (user `admin`),
root password, SSH on/off. At the first boot `firstboot.py` applies them, gives the appliance its own SSH host keys
and machine-id, then the portal starts and `bootstrap-admin.sh` creates the administrator once.

Defaults: 2 vCPU, 4 GB RAM, 16 GB system disk, 60 GB data disk (thin). Open in the firewall: 22, 80, 443 and
8441-8472 (optional webtop gateway). Replace the temporary certificate in `/data/portal/etc/ssl/portal.{crt,key}`.

## Updates

The appliance updates itself from signed releases (About → Updates → Update, or an uploaded `.hpupdate` file). The
portal downloads and verifies the release, then `holodeck-updater.path` starts `updater.py` on the host, which
verifies it again with the keys in `/etc/holodeck-appliance/trusted-keys/`, backs up the database, keys and settings
to `/data/backups/pre-<version>-<time>` (the newest five are kept), switches the `holodeck-portal:current` image
(the old one stays as `:previous`), and rolls image and database back automatically if the new version isn't healthy
within five minutes. Progress and results are in `/data/portal/lib/updates/status.json` and
`journalctl -u holodeck-updater`. Each update also refreshes the updater and the systemd units from the new image.


## Building (maintainers)

1. Deploy the official Photon OS 5 OVA (packages.broadcom.com/photon/5.0/GA/ova) with vCenter; seed root's SSH key
   and an unexpired random password through cloud-init guestinfo; add a 60 GB data disk.
2. On the VM: format the data disk (`LABEL=hp-data`, mounted at `/data`), `tdnf update`, install `tar`, Docker
   `data-root` on `/data/docker`, enable Docker, open 80/443/8441-8472 and ping in `/etc/systemd/scripts/ip4save`
   (and 443 etc. in `ip6save`), load the image and tag it `holodeck-portal:current`, copy this folder to
   `/opt/holodeck-appliance`, install `holodeck-*.service` / `holodeck-updater.path` in `/etc/systemd/system` and
   enable them (portal, first boot, admin bootstrap, updater path and updater service), put
   `release/keys/release-signing.pub` (only) in `/etc/holodeck-appliance/trusted-keys/` and create
   `/data/portal/lib/updates`.
3. Generalise: stop the portal, empty `/data/portal/*`, remove `/etc/holodeck-appliance/*` state, disable and clean
   cloud-init, lock root's password, remove `authorized_keys` and SSH host keys, truncate `/etc/machine-id`, clear
   logs and caches, power off; clear the guestinfo cloud-init seed on the VM.
4. Export the VM as OVF (PowerCLI `Export-VApp`) and run `build-ova.py <export-dir> <version> <out.ova>`: neutral
   names, the deployment properties, SHA-256 manifest, OVA. Deploy the result once to test before releasing.

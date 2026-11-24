# Holodeck Portal

A self-service web portal for [VMware Holodeck](https://vmware.github.io/Holodeck/) 9.x. Users deploy, open and
manage nested VCF and VVF labs from a browser; administrators control configurations, users, quotas, leases,
networking and a fleet of Holorouters, one lab per router.

> A community project. Not an official Broadcom or VMware product, and not supported by Broadcom.

```
Users ──HTTPS──► Holodeck Portal (appliance or container: nginx, Node.js, SQLite, PowerShell + PowerCLI)
                        │ SSH (portal key, pinned host keys)                 │ HTTPS
                        ▼                                                    ▼
          Holorouter (slot 1)   Holorouter (slot 2)   …            vCenter or ESXi host
          Holodeck · webtop     Holodeck · webtop                  router VMs, nested lab hosts
```

## Features

- **Labs from a browser**: every `New-HoloDeckInstance` option (VVF, management-only, full stack, vSAN mode,
  Supervisor, VCF Automation, …) with a live preview of the exact command; live job console where Holodeck's
  questions are answered in the page; power, suspend, day-2 (`Update-HoloDeckInstance`), diagnostics, removal.
- **Access** through each lab's webtop, directly or through the portal over HTTPS (one origin per router, signed in
  by the portal); console addresses and every DNS record of the lab; a credentials dialog (audited).
- **Holorouter fleet**: deploy routers from the Holorouter OVA (SHA-256 checked, vCenter certificate approved,
  onboarded through vCenter with their own SSH host keys) or import existing ones; capacity profiles tie routers to
  a configuration and its placement; installation files are copied between routers (resumable, SHA-256 verified).
- **Networking**: automatic CIDR and VLAN allocation per network slot, blocked VLANs and networks, a guard against
  overlapping management networks, slot-based lab names (`s06`, `lab06.vcf.lab`).
- **Policy**: quotas, leases in days with warnings, optional suspend / shut down of idle labs.
- **Sign-in**: local accounts, OpenID Connect and SAML 2.0 with group → role mapping.
- **Operations**: certificate management (CSR, install, PFX, roll back), signed one-click updates with automatic
  rollback (or offline update bundles), audit log.
- Holodeck itself is never modified, and the portal never resets a Holorouter.

## Install

Releases are on the [Releases page](https://github.com/msteward1/holodeck-portal/releases).

**Appliance (recommended).** Deploy `holodeck-portal-<version>.ova` with vCenter or the ESXi Host Client and fill in its settings (network,
portal DNS name, administrator and root passwords). Open `https://<portal name>/` and sign in as `admin`.

**Container.** On a Docker host, in a clone of this repository (for `docker-compose.yml` and `release/`), with the
release's `holodeck-portal-<version>.hpupdate`:

```bash
./release/verify-release.sh holodeck-portal-<version>.hpupdate   # signature, digest and image ID, then docker load
printf 'HP_HOSTNAME=holodeck.example.com\nHP_PORTAL_IMAGE=holodeck-portal:<version>\n' > .env
docker compose up -d
docker exec -it holodeck-portal sh -c 'cd /opt/holodeck-portal/server && node dist/cli.js create-admin admin'
```

Then follow the administrator guide's first-time setup: import a Holorouter, create a configuration, stage the
installation files and deploy a test lab.

## Documentation

| Guide | For |
| --- | --- |
| [Installation and operations](docs/HOLODECK_PORTAL_OPERATIONS_GUIDE.html) | Installing the appliance or container, certificate, updates, backup, maintenance |
| [Administrator guide](docs/HOLODECK_PORTAL_ADMIN_GUIDE.html) | Configurations, users and sign-on, Holorouters, network pool, leases and idle labs |
| [User guide](docs/HOLODECK_PORTAL_USER_GUIDE.html) | Deploying, opening and managing labs |

The guides are self-contained HTML pages; the portal also shows them in its **Documentation** tab.

## Requirements

- Holodeck 9.x Holorouters (tested with Holodeck 9.1.0.20) and a vCenter or standalone ESXi host for them and
  their labs, with trunk port groups for the lab VLANs.
- The VCF installation files (the ESX ISO and the VCF Installer or Cloud Builder OVA), named exactly as Holodeck's
  bill of materials lists them.
- For the appliance: vCenter or an ESXi host to deploy it; 2 vCPU, 4 GB memory, 76 GB disk (thin).

## Repository layout

| Path | Contents |
| --- | --- |
| `server/` | Fastify API (TypeScript, SQLite via `node:sqlite`), job runner and PowerShell helpers (`server/ps/`) |
| `web/` | React UI (Vite, Tailwind) |
| `docs/` | The three HTML guides |
| `deploy/container/`, `Dockerfile`, `docker-compose.yml` | The container image |
| `deploy/appliance/` | Photon OS appliance: first boot, updater, OVA builder (see its README) |
| `release/` | Release build, signing and publishing; public signing keys (see its README) |

## Development

```bash
cd server && npm ci && npm test          # unit tests (no Holodeck needed)
HP_DATA_DIR=/tmp/hp HP_PUBLIC_URL=http://localhost:3080 npm run dev
cd web && npm ci && npm run dev          # Vite on :5173, proxies /api to :3080
docker compose build                     # the container image
```

## How this was built

Holodeck Portal was designed, tested and is maintained by Mike Steward. Much of the code and documentation was written
with the help of an AI coding assistant, under his direction and review. Every change is tested against real
Holodeck environments before release.

## Security

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md). Changes per version: [CHANGELOG.md](CHANGELOG.md).

## Acknowledgements

Holodeck Portal builds on VMware Holodeck. Thanks to the Holodeck team at Broadcom for creating and maintaining it;
the portal would not exist without their work.

## Contributing

Bug reports and ideas are welcome as GitHub issues. Contributions are accepted under the Apache License 2.0; by
contributing you agree that the maintainer may also offer your contribution under another open-source licence
(for example, if the project joins a vendor program that requires one).

## License

Apache License 2.0. Copyright 2026 Mike Steward. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party
components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
VMware PowerCLI is not included; the portal downloads it on first start under Broadcom's licence.

## Trademarks

Holodeck Portal is an independent community project. It is not affiliated with, endorsed by or supported by
Broadcom. VMware, VCF, vSphere and Holodeck are trademarks of Broadcom.

# Changelog

All notable changes for users of Holodeck Portal. Versions follow [semantic versioning](https://semver.org/).

## 1.0.1

Source-only release: no change to the portal, and no new downloads (use 1.0.0's).

- Tests: the network-slot tests no longer depend on the network of the machine they run on (they failed on build
  machines whose own subnet overlaps the test lab pool).

## 1.0.0

First public release, under the Apache License 2.0.

- Self-service labs on Holodeck 9.x: deploy VCF and VVF labs with every `New-HoloDeckInstance` option, answer
  Holodeck's questions in the browser, power, suspend, day-2 operations, diagnostics and removal.
- A fleet of Holorouters, one lab each: deploy them from the Holorouter OVA or import existing ones, capacity
  profiles per configuration, installation files copied between routers.
- Lab access through each router's webtop, opened through the portal over HTTPS by default.
- Network pool with blocked VLANs and networks, slot-based lab names, quotas, leases in days, optional suspend and
  shut down of idle labs.
- Sign-in with local accounts, OpenID Connect or SAML 2.0.
- Photon OS appliance (OVA) with signed one-click updates and automatic rollback; container image for Docker hosts
  with a release verifier.
- Certificate management (CSR, install, upload, roll back) and an audit log.

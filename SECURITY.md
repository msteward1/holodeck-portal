# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability** ([private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Don't open a public issue for a vulnerability.

Include what you found, the version (About dialog), how to reproduce it, and the impact you expect. You'll get an
answer within a week; fixes are released as signed updates and announced in the release notes.

## Supported versions

Security fixes go into the newest release. The appliance updates itself from the About dialog; container
installations update with `release/verify-release.sh` (see the Installation and operations guide).

## Scope

In scope: the portal (server, web UI, container image, appliance, updater, release verification). Out of scope:
Holodeck itself, VMware/Broadcom products, and the Holorouter appliance's own services; report those to their vendors.

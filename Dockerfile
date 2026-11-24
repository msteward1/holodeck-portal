# Holodeck Portal: one image for every form factor (container, Photon OVA).
# The portal, its web UI, nginx (TLS, sign-in rate limits, webtop gateway) and PowerShell 7. VMware PowerCLI is
# downloaded on first start (its licence doesn't allow redistribution). Holodeck itself is not included: it runs on
# the Holorouters, which the portal drives over SSH.

# ---- build -------------------------------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY server/package.json server/package-lock.json server/
COPY web/package.json web/package-lock.json web/
RUN cd server && npm ci --ignore-scripts && cd ../web && npm ci --ignore-scripts
COPY server server
COPY web web
RUN cd server && npm run build && npm prune --omit=dev && cd ../web && npm run build

# ---- runtime -----------------------------------------------------------------------------------------------------
FROM node:24-bookworm-slim
ARG PWSH_VERSION=7.4.6
ARG POWERCLI_VERSION=13.5.1.25718932
ARG HP_VERSION=dev
ARG HP_COMMIT=
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx openssh-client socat curl ca-certificates unzip openssl procps tini bsdutils libicu72 \
 && rm -f /etc/nginx/sites-enabled/default \
 && curl -fsSL -o /tmp/pwsh.deb "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell_${PWSH_VERSION}-1.deb_amd64.deb" \
 && apt-get install -y --no-install-recommends /tmp/pwsh.deb \
 && rm -rf /tmp/pwsh.deb /var/lib/apt/lists/*
# PowerCLI is not part of the image (Broadcom's licence doesn't allow redistributing it): the container downloads the
# pinned version into its data volume on first start (deploy/container/install-powercli.sh).

WORKDIR /opt/holodeck-portal
COPY --from=build /src/server/package.json server/package.json
COPY --from=build /src/server/node_modules server/node_modules
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/web/dist web/dist
COPY server/ps server/ps
COPY docs docs
COPY README.md LICENSE* NOTICE THIRD_PARTY_NOTICES* ./
COPY deploy deploy
COPY release/keys release/keys
COPY release/verify-release.sh release/verify-release.sh
RUN chmod 755 server/ps/*.sh deploy/container/entrypoint.sh

# Containers have no systemd: jobs and webtop relays are the portal's own processes. Lab jobs keep running on the
# routers under their systemd across portal restarts and updates; the portal re-attaches to them.
ENV NODE_ENV=production \
    HP_VERSION=${HP_VERSION} \
    HP_COMMIT=${HP_COMMIT} \
    HP_HOST=127.0.0.1 \
    HP_PORT=3080 \
    HP_DATA_DIR=/var/lib/holodeck-portal \
    HP_ETC_DIR=/etc/holodeck-portal \
    HP_SYSTEMD_RUN=0 \
    HP_RELAY_MODE=process \
    HP_PWSH=/usr/bin/pwsh \
    POWERCLI_VERSION=${POWERCLI_VERSION} \
    HP_PS_MODULES=/var/lib/holodeck-portal/powershell/Modules
VOLUME ["/var/lib/holodeck-portal", "/etc/holodeck-portal"]
EXPOSE 80 443 8441-8472
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS http://127.0.0.1:3080/api/health || exit 1
ENTRYPOINT ["tini", "--", "/opt/holodeck-portal/deploy/container/entrypoint.sh"]

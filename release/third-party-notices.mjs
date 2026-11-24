// Writes THIRD_PARTY_NOTICES.md: every production npm package of the server and the web UI (both ship in the
// image) with its licence text, plus the system components the image and appliance include.
// Usage: node release/third-party-notices.mjs > THIRD_PARTY_NOTICES.md   (after npm ci in server/ and web/)
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkgs = new Map();
for (const part of ['server', 'web']) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, part, 'package-lock.json'), 'utf8'));
  for (const [p, info] of Object.entries(lock.packages)) {
    if (!p || info.dev || info.devOptional) continue;
    const dir = path.join(root, part, p);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    const key = `${meta.name}@${meta.version}`;
    if (pkgs.has(key)) continue;
    const licFile = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : undefined;
    const license = typeof meta.license === 'string' ? meta.license : meta.license?.type ?? (meta.licenses ?? []).map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
    pkgs.set(key, { name: meta.name, version: meta.version, license: license || 'UNKNOWN', repo: typeof meta.repository === 'string' ? meta.repository : meta.repository?.url ?? '', text: licFile ? fs.readFileSync(path.join(dir, licFile), 'utf8').trim() : '' });
  }
}
const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = [];
out.push('# Third-party notices', '', 'Holodeck Portal includes the following third-party software. Each component is subject to its own licence.', '');
out.push('## System components', '');
out.push('| Component | Licence | Where |', '|---|---|---|');
out.push('| Node.js (container base image `node:24-bookworm-slim`) | MIT and others; see `/usr/local/share/doc/node` and https://github.com/nodejs/node/blob/main/LICENSE | Container image |');
out.push('| Debian 12 packages (nginx, OpenSSH client, socat, curl, tini, OpenSSL, …) | Various free software licences; each package\'s terms are in `/usr/share/doc/<package>/copyright` in the image | Container image |');
out.push('| PowerShell 7 | MIT; https://github.com/PowerShell/PowerShell/blob/master/LICENSE.txt | Container image |');
out.push('| Photon OS 5 | Apache-2.0, GPL-2.0 and others; per-package licences in `/usr/share/licenses` on the appliance | Appliance (OVA) |');
out.push('| Docker Engine | Apache-2.0 | Appliance (OVA) |');
out.push('', 'VMware PowerCLI is **not** included: the portal downloads it from the PowerShell Gallery on first start, under Broadcom\'s licence. The Holodeck PowerShell module is not included either; it is part of each Holorouter.', '');
out.push('## npm packages', '', `${list.length} packages.`, '', '| Package | Version | Licence |', '|---|---|---|');
for (const p of list) out.push(`| ${p.name} | ${p.version} | ${p.license} |`);
out.push('', '## Licence texts', '');
for (const p of list) {
  out.push(`### ${p.name} ${p.version} (${p.license})`, '');
  out.push(p.text ? '```\n' + p.text.replace(/```/g, "'''") + '\n```' : `No licence file in the package; licence: ${p.license}${p.repo ? `, source: ${p.repo}` : ''}.`, '');
}
process.stdout.write(out.join('\n') + '\n');

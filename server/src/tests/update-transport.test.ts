/** the GitLab token goes only to the configured origin, never over a redirect to another one, and plain HTTP needs the switch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-updtx-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_VERSION = '0.4.0';
process.env.HP_LOG_LEVEL = 'silent';

const { updateSettings, setSecret } = await import('../settings.js');
const u = await import('../updates.js');

const seen: { server: string; path: string; token: string | undefined }[] = [];
function server(name: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const s = http.createServer((req, res) => {
    seen.push({ server: name, path: req.url ?? '', token: req.headers['private-token'] as string | undefined });
    handler(req, res);
  });
  return new Promise<{ s: http.Server; base: string }>((r) => s.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` })));
}
const other = await server('other', (_q, res) => res.end('{}'));
const gitlab = await server('gitlab', (req, res) => {
  if (req.url?.includes('/releases')) {
    res.setHeader('content-type', 'application/json');
    // A release whose manifest link redirects to another host.
    res.end(JSON.stringify([{ tag_name: 'v0.4.1', assets: { links: [
      { name: 'holodeck-portal-0.4.1.manifest.json', url: `${gitlabBase}/redir` },
      { name: 'holodeck-portal-0.4.1.manifest.json.sig', url: `${gitlabBase}/redir` },
    ] } }]));
  } else if (req.url === '/redir') {
    res.writeHead(302, { location: `${other.base}/steal` });
    res.end();
  } else res.end('{}');
});
const gitlabBase = gitlab.base;

test('token rules: configured origin only; plain HTTP only when allowed', () => {
  setSecret('updates.gitlabToken', 'glpat-secret');
  updateSettings('updates', { autoCheck: false, allowInsecureHttp: false, source: { type: 'gitlab', url: 'https://gitlab.example.com', project: 'g/p' } });
  assert.equal(u.sourceHeaders('https://gitlab.example.com/api/v4/x')['PRIVATE-TOKEN'], 'glpat-secret');
  assert.equal(u.sourceHeaders('https://evil.example.com/x')['PRIVATE-TOKEN'], undefined);
  assert.equal(u.sourceHeaders('http://gitlab.example.com/x')['PRIVATE-TOKEN'], undefined, 'not over http (also a different origin)');
  updateSettings('updates', { autoCheck: false, allowInsecureHttp: false, source: { type: 'gitlab', url: 'http://gitlab.example.com', project: 'g/p' } });
  assert.equal(u.sourceHeaders('http://gitlab.example.com/x')['PRIVATE-TOKEN'], undefined, 'http source without the switch');
  updateSettings('updates', { autoCheck: false, allowInsecureHttp: true, source: { type: 'gitlab', url: 'http://gitlab.example.com', project: 'g/p' } });
  assert.equal(u.sourceHeaders('http://gitlab.example.com/x')['PRIVATE-TOKEN'], 'glpat-secret');
});

test('a plain-HTTP GitLab is refused until allowed', async () => {
  seen.length = 0;
  updateSettings('updates', { autoCheck: false, allowInsecureHttp: false, source: { type: 'gitlab', url: gitlabBase, project: 'g/p' } });
  await u.checkForUpdates();
  assert.match(u.updatesView().checkError ?? '', /plain HTTP/);
  assert.equal(seen.length, 0, 'nothing was sent');
});

test('a redirect to another host is refused before anything (or the token) reaches it', async () => {
  seen.length = 0;
  updateSettings('updates', { autoCheck: false, allowInsecureHttp: true, source: { type: 'gitlab', url: gitlabBase, project: 'g/p' } });
  await u.checkForUpdates();
  assert.equal(seen.find((x) => x.path.includes('/releases'))?.token, 'glpat-secret');
  assert.equal(seen.some((x) => x.server === 'other'), false, 'the other host was never contacted');
  assert.match(u.updatesView().checkError ?? '', /only HTTPS is allowed/);
  gitlab.s.close();
  other.s.close();
});

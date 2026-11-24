import { startUpdateChecks } from './updates.js';
import { checkCertificateExpiry } from './certificate.js';
import { config } from './config.js';
import { buildApp } from './app.js';
import { pruneJobs, startJobLoop, stopJobLoop } from './holodeck/jobs.js';
import { startLeaseLoop } from './lease.js';
import { expireStalePrompts } from './labs.js';
import { purgeExpiredSessions } from './auth/session.js';
import { pruneSamlCache } from './auth/sso.js';
import { notify, pruneAudit } from './audit.js';
import { all } from './db.js';
import { backfillHostKeys, ensureSshKey, listRouters, startHealthLoop, stopHealthLoop } from './holorouters.js';
import { adoptLocalConfigFiles } from './holodeck/configstore.js';
import { syncRelays } from './webtop-gateway.js';

const app = await buildApp();

await ensureSshKey();
await backfillHostKeys();
// Installations that ran on a Holorouter: take over its Holodeck configuration files once.
const adopted = adoptLocalConfigFiles();
if (adopted) console.log(`adopted ${adopted} Holodeck configuration file(s) from this host`);
await syncRelays(listRouters()).catch((err) => console.error('webtop relays failed', err));
startJobLoop();
startHealthLoop();
startLeaseLoop();
startUpdateChecks();
setInterval(() => void expireStalePrompts().catch((err) => console.error('prompt expiry failed', err)), 5 * 60_000).unref();
const certificateExpiry = () => {
  try {
    checkCertificateExpiry((n) => {
      for (const a of all<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND enabled = 1")) notify(a.id, n);
    });
  } catch (err) {
    console.error('certificate expiry check failed', err);
  }
};
setTimeout(certificateExpiry, 30_000).unref();
setInterval(() => {
  certificateExpiry();
  purgeExpiredSessions();
  pruneJobs();
  pruneSamlCache();
  pruneAudit();
}, 3600_000).unref();

await app.listen({ host: config.host, port: config.port });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    // Jobs run in their own systemd units and keep going; the portal picks them up on restart.
    stopJobLoop();
    stopHealthLoop();
    await app.close();
    process.exit(0);
  });
}

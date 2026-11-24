import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(config.dataDir, 'portal.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

/**
 * Ordered schema migrations. Append only — never edit a migration that has shipped.
 */
const migrations: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    first_name    TEXT NOT NULL DEFAULT '',
    last_name     TEXT NOT NULL DEFAULT '',
    email         TEXT,
    role          TEXT NOT NULL CHECK (role IN ('admin','user')),
    auth_source   TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local','oidc','saml')),
    external_id   TEXT,
    password_hash TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    lab_quota     INTEGER,            -- NULL = use default from settings
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX users_external ON users(auth_source, external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,      -- sha256 of the cookie token
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Holodeck configurations registered with the portal (one row per Holodeck ConfigID).
  CREATE TABLE configs (
    id            INTEGER PRIMARY KEY,
    config_id     TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    enabled       INTEGER NOT NULL DEFAULT 1,
    entitle_all   INTEGER NOT NULL DEFAULT 1,
    defaults      TEXT NOT NULL DEFAULT '{}',  -- default deploy options (JSON)
    placement     TEXT NOT NULL DEFAULT '{}',  -- cluster/datastore/portgroup names for unattended precheck (JSON)
    depot_secret  TEXT,                        -- encrypted JSON: depot token, proxy and offline-depot credentials
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE config_entitlements (
    config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (config_id, user_id)
  );

  CREATE TABLE labs (
    id               INTEGER PRIMARY KEY,
    instance_id      TEXT NOT NULL,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    owner_id         INTEGER NOT NULL REFERENCES users(id),
    config_id        INTEGER NOT NULL REFERENCES configs(id),
    slot             INTEGER NOT NULL,
    sites            TEXT NOT NULL,            -- JSON: [{site, cidr, vlanStart, reserved}]
    deploy_site      TEXT NOT NULL DEFAULT 'a',
    version          TEXT NOT NULL,
    mode             TEXT NOT NULL CHECK (mode IN ('VVF','ManagementOnly','FullStack')),
    options          TEXT NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL,
    power_state      TEXT NOT NULL DEFAULT 'unknown',
    lease_expires_at TEXT NOT NULL,
    lease_expired    INTEGER NOT NULL DEFAULT 0,
    warned_level     INTEGER NOT NULL DEFAULT 0, -- 0 none, 1 first warning, 2 second warning
    uses_shared_routed INTEGER NOT NULL DEFAULT 0, -- Supervisor / VCF Automation (ctgw 10.100.x)
    network          TEXT,                     -- JSON snapshot of subnets
    nodes            TEXT,                     -- JSON snapshot of instance nodes
    endpoints        TEXT,                     -- JSON snapshot of app network (FQDN/IP)
    credentials_enc  TEXT,                     -- encrypted JSON snapshot of lab credentials
    last_job_id      TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deployed_at      TEXT,
    removed_at       TEXT
  );
  CREATE UNIQUE INDEX labs_active_instance ON labs(instance_id) WHERE status <> 'removed';
  CREATE UNIQUE INDEX labs_active_slot ON labs(slot) WHERE status <> 'removed';
  CREATE INDEX labs_owner ON labs(owner_id);

  CREATE TABLE jobs (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    lab_id      INTEGER REFERENCES labs(id),
    config_id   INTEGER REFERENCES configs(id),
    user_id     INTEGER REFERENCES users(id),
    status      TEXT NOT NULL,
    exclusive   INTEGER NOT NULL DEFAULT 1,   -- needs the Holodeck lock
    params      TEXT NOT NULL DEFAULT '{}',   -- non-secret parameters, for display
    prompt      TEXT,                         -- JSON of the prompt currently awaiting input
    result      TEXT,
    error       TEXT,
    exit_code   INTEGER,
    unit        TEXT,
    pid         INTEGER,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at  TEXT,
    finished_at TEXT
  );
  CREATE INDEX jobs_lab ON jobs(lab_id);
  CREATE INDEX jobs_status ON jobs(status);

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lab_id     INTEGER REFERENCES labs(id),
    level      TEXT NOT NULL DEFAULT 'info',
    title      TEXT NOT NULL,
    message    TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    read_at    TEXT
  );
  CREATE UNIQUE INDEX notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

  CREATE TABLE audit (
    id      INTEGER PRIMARY KEY,
    ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    user_id INTEGER,
    action  TEXT NOT NULL,
    target  TEXT,
    details TEXT,
    ip      TEXT
  );
  `,
  // 2: multiple Holorouters. Each router owns one network slot and hosts at most one lab.
  `
  CREATE TABLE capacity_profiles (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    config_id     INTEGER NOT NULL REFERENCES configs(id),  -- vCenter source (a Holodeck configuration's target)
    datacenter    TEXT NOT NULL DEFAULT '',
    cluster       TEXT NOT NULL DEFAULT '',
    resource_pool TEXT NOT NULL DEFAULT '',
    folder        TEXT NOT NULL DEFAULT '',
    datastore     TEXT NOT NULL,
    mgmt_network  TEXT NOT NULL,
    trunk_a       TEXT NOT NULL,
    trunk_b       TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE holorouters (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    address          TEXT NOT NULL,           -- SSH address (IP or FQDN); 'localhost' for the primary
    mgmt_ip          TEXT,
    slot             INTEGER NOT NULL UNIQUE,
    is_primary       INTEGER NOT NULL DEFAULT 0,
    origin           TEXT NOT NULL CHECK (origin IN ('primary','imported','deployed')),
    profile_id       INTEGER REFERENCES capacity_profiles(id),
    status           TEXT NOT NULL,           -- onboarding, deploying, ready, attention, offline, error, removing
    vm_name          TEXT,
    holodeck_version TEXT,
    inspection       TEXT,                    -- JSON of the last health / cleanliness check
    last_seen_at     TEXT,
    last_job_id      TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO holorouters (id, name, address, slot, is_primary, origin, status)
    VALUES (1, 'Primary', 'localhost', 1, 1, 'primary', 'ready');

  CREATE TABLE vcenter_inventory (
    config_id  INTEGER PRIMARY KEY REFERENCES configs(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  ALTER TABLE labs ADD COLUMN holorouter_id INTEGER REFERENCES holorouters(id);
  UPDATE labs SET holorouter_id = 1;
  CREATE UNIQUE INDEX labs_active_router ON labs(holorouter_id) WHERE status <> 'removed';

  ALTER TABLE jobs ADD COLUMN holorouter_id INTEGER REFERENCES holorouters(id);
  CREATE INDEX jobs_router ON jobs(holorouter_id);
  `,
  // 3: staged installation files per Holorouter (cached for secondaries; the primary is read live).
  `
  ALTER TABLE holorouters ADD COLUMN staging TEXT;
  `,
  // 4: security hardening. All additive.
  `
  CREATE TABLE saml_cache (            -- SAML request IDs we issued, and assertion IDs already used
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at INTEGER NOT NULL        -- epoch ms
  );
  ALTER TABLE holorouters ADD COLUMN webtop_password TEXT;   -- encrypted; NULL = use the portal-wide one
  ALTER TABLE holorouters ADD COLUMN host_key TEXT;          -- pinned SSH host key line, as approved
  ALTER TABLE capacity_profiles ADD COLUMN vcenter_thumbprint TEXT;  -- approved vCenter TLS thumbprint
  ALTER TABLE labs ADD COLUMN vm_ids TEXT;                   -- JSON list of VM morefs from the last snapshot
  `,
  // 5: more security hardening. All additive.
  `
  ALTER TABLE labs ADD COLUMN snapshot_at TEXT;              -- when the lab's host list was last confirmed
  UPDATE labs SET snapshot_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status <> 'removed';
  ALTER TABLE users ADD COLUMN sso_issuer TEXT;              -- IdP issuer / entity ID the external_id belongs to
  `,
  // 6: optional webtop gateway. Additive.
  `
  ALTER TABLE holorouters ADD COLUMN webtop_mode TEXT;       -- direct | portal | portal-only; NULL = the default in settings
  ALTER TABLE holorouters ADD COLUMN webtop_firewall TEXT;   -- 'closed' while the portal keeps the router's webtop ports closed
  `,
  // 7: the portal is no longer installed on a Holorouter (no primary). It owns the Holodeck configuration files.
  `
  CREATE TABLE holodeck_configs (      -- the portal's master copy of each Holodeck config file, pushed to routers
    config_id  TEXT NOT NULL,
    site       TEXT NOT NULL CHECK (site IN ('a','b')),
    data_enc   TEXT NOT NULL,          -- encrypted JSON (holds the target credentials)
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (config_id, site)
  );
  -- No primary Holorouter: the one the portal was installed on becomes an ordinary router, reached over SSH at its
  -- management address. A fresh installation's placeholder row (never synced, no address) is removed.
  UPDATE holorouters SET is_primary = 0, origin = 'imported', address = mgmt_ip WHERE is_primary = 1 AND mgmt_ip IS NOT NULL;
  DELETE FROM holorouters WHERE is_primary = 1;
  `,
  // 8: idle labs are suspended / shut down automatically (Settings → Leases, per router, per lab exemption).
  `
  ALTER TABLE labs ADD COLUMN last_activity_at TEXT;               -- last sign of use (portal, webtop)
  ALTER TABLE labs ADD COLUMN idle_warned INTEGER NOT NULL DEFAULT 0;  -- bits: 1 = suspend warning sent, 2 = shutdown warning sent
  ALTER TABLE labs ADD COLUMN idle_exempt INTEGER NOT NULL DEFAULT 0;  -- an administrator exempted this lab
  ALTER TABLE holorouters ADD COLUMN idle_policy TEXT;             -- JSON override of the default; NULL = follow the default
  -- Existing labs start their idle clock now, so enabling the feature never acts on them at once.
  UPDATE labs SET last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status <> 'removed';
  `,
  // 9: new defaults (0.4.6) — webtop gateway on, portal-only; plain-HTTP update sources need an explicit switch.
  // Installations that already have Holorouters keep what they had: their effective values are written down.
  `
  INSERT INTO settings (key, value)
    SELECT 'holorouters', '{"webtopGateway":{"enabled":false,"defaultMode":"direct"}}'
    WHERE EXISTS (SELECT 1 FROM holorouters) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'holorouters');
  UPDATE settings SET value = json_set(value, '$.webtopGateway', json('{"enabled":false,"defaultMode":"direct"}'))
    WHERE key = 'holorouters' AND json_extract(value, '$.webtopGateway') IS NULL;
  UPDATE settings SET value = json_set(value, '$.allowInsecureHttp', json('true'))
    WHERE key = 'updates' AND json_extract(value, '$.source.type') = 'gitlab' AND json_extract(value, '$.source.url') LIKE 'http://%';
  -- Notices an administrator chose not to see again (JSON array of notice IDs).
  ALTER TABLE users ADD COLUMN dismissed_notices TEXT;
  `,
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let current = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (current < migrations.length) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[current]);
      current += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(current);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
migrate();

export function nowIso(): string {
  return new Date().toISOString();
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

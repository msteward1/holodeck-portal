/**
 * OIDC and SAML sign-in. Both map IdP groups to portal roles and provision users on first login.
 */
import * as oidc from 'openid-client';
import { SAML, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { config } from '../config.js';
import { get, run } from '../db.js';
import { getSecret, getSettings } from '../settings.js';
import { audit } from '../audit.js';
import { HttpError, type UserRow } from '../labs.js';

export interface SsoIdentity {
  source: 'oidc' | 'saml';
  /** OIDC issuer or SAML IdP entity ID: a subject is only unique within its issuer. */
  issuer: string;
  externalId: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  groups: string[];
}

interface RoleRules {
  adminGroups: string[];
  userGroups: string[];
  autoProvision: boolean;
}

function lower(xs: string[]) {
  return xs.map((x) => x.toLowerCase());
}

/** admin if in an admin group; user if in a user group (or no user groups configured); otherwise denied. */
export function roleFor(groups: string[], rules: RoleRules): 'admin' | 'user' | null {
  const g = new Set(lower(groups));
  if (lower(rules.adminGroups).some((x) => g.has(x))) return 'admin';
  if (rules.userGroups.length === 0 || lower(rules.userGroups).some((x) => g.has(x))) return 'user';
  return null;
}

/** Issuers compare case-insensitively and without a trailing slash (IdPs differ in how they print them). */
export function normalIssuer(issuer: string | null | undefined): string {
  return String(issuer ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

export function upsertSsoUser(id: SsoIdentity, rules: RoleRules, ip?: string): UserRow {
  const role = roleFor(id.groups, rules);
  if (!role) throw new HttpError(403, 'Your account is not in a group that is allowed to use this portal.');
  const issuer = id.issuer.trim();

  let user = get<UserRow>('SELECT * FROM users WHERE auth_source = ? AND external_id = ?', id.source, id.externalId);
  if (user) {
    if (user.sso_issuer && issuer && normalIssuer(user.sso_issuer) !== normalIssuer(issuer)) {
      // Same subject value from a different IdP: not the same person until an admin says so.
      audit(user.id, 'auth.sso.issuer-conflict', `user:${user.id}`, { source: id.source, existing: user.sso_issuer, presented: issuer }, ip);
      throw new HttpError(409, `The portal account '${user.username}' is linked to a different identity provider. Ask an administrator to unlink it.`);
    }
    // Links made before issuers were recorded adopt the issuer of their next sign-in.
    if (!user.sso_issuer && issuer) run('UPDATE users SET sso_issuer = ? WHERE id = ? AND sso_issuer IS NULL', issuer, user.id);
  } else {
    const clash = get<UserRow>('SELECT * FROM users WHERE username = ?', id.username);
    if (clash) {
      if (clash.auth_source !== id.source) {
        throw new HttpError(409, `A ${clash.auth_source} account named '${id.username}' already exists. Ask an administrator to resolve the conflict.`);
      }
      // Same source and no identity recorded yet (pre-created by an admin, or unlinked by one): link it.
      // An account already bound to a different subject is never re-bound from a sign-in; usernames can be
      // reassigned at the IdP, the subject can't. The conditional update also stops two sign-ins racing.
      const linked = clash.external_id === null && run('UPDATE users SET external_id = ?, sso_issuer = ? WHERE id = ? AND external_id IS NULL', id.externalId, issuer || null, clash.id).changes === 1;
      if (!linked) {
        audit(clash.id, 'auth.sso.identity-conflict', `user:${clash.id}`, { source: id.source, username: id.username, existing: clash.external_id, presented: id.externalId }, ip);
        throw new HttpError(409, `The portal account '${clash.username}' is linked to a different ${id.source.toUpperCase()} identity. Ask an administrator to unlink it.`);
      }
      audit(clash.id, 'auth.sso.linked', `user:${clash.id}`, { source: id.source, externalId: id.externalId }, ip);
      user = get<UserRow>('SELECT * FROM users WHERE id = ?', clash.id)!;
    } else {
      if (!rules.autoProvision) throw new HttpError(403, 'Your account has not been registered in the portal.');
      const res = run(
        `INSERT INTO users (username, first_name, last_name, email, role, auth_source, external_id, sso_issuer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id.username,
        id.firstName ?? '',
        id.lastName ?? '',
        id.email ?? null,
        role,
        id.source,
        id.externalId,
        issuer || null,
      );
      user = get<UserRow>('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid))!;
      audit(user.id, 'user.provisioned', `user:${user.id}`, { source: id.source, role }, ip);
    }
  }
  if (!user.enabled) throw new HttpError(403, 'Your portal account is disabled.');
  // Keep profile and role in sync with the IdP on every sign-in.
  run(
    `UPDATE users SET role = ?, email = COALESCE(?, email),
       first_name = CASE WHEN ? <> '' THEN ? ELSE first_name END,
       last_name = CASE WHEN ? <> '' THEN ? ELSE last_name END
     WHERE id = ?`,
    role,
    id.email ?? null,
    id.firstName ?? '',
    id.firstName ?? '',
    id.lastName ?? '',
    id.lastName ?? '',
    user.id,
  );
  return get<UserRow>('SELECT * FROM users WHERE id = ?', user.id)!;
}

// ---------------------------------------------------------------------------
// OIDC
// ---------------------------------------------------------------------------

export const oidcRedirectUri = () => `${config.publicUrl}/api/auth/oidc/callback`;

let oidcCache: { key: string; cfg: oidc.Configuration } | null = null;

async function oidcConfiguration(): Promise<oidc.Configuration> {
  const s = getSettings().auth.oidc;
  if (!s.enabled || !s.issuer || !s.clientId) throw new HttpError(400, 'OIDC sign-in is not configured');
  const secret = getSecret('oidc.clientSecret');
  const key = `${s.issuer}|${s.clientId}|${secret.length}`;
  if (oidcCache?.key === key) return oidcCache.cfg;
  const cfg = await oidc.discovery(new URL(s.issuer), s.clientId, secret || undefined);
  oidcCache = { key, cfg };
  return cfg;
}

export function resetOidcCache() {
  oidcCache = null;
}

export async function oidcStart() {
  const s = getSettings().auth.oidc;
  const cfg = await oidcConfiguration();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: oidcRedirectUri(),
    scope: s.scopes,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, transaction: { verifier, state, nonce } };
}

function claimString(claims: Record<string, unknown>, name: string): string | undefined {
  const v = claims[name];
  return typeof v === 'string' && v ? v : undefined;
}

function claimList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return v.split(/[,\s]+/).filter(Boolean);
  return [];
}

export async function oidcFinish(callbackUrl: URL, tx: { verifier: string; state: string; nonce: string }, ip?: string) {
  const s = getSettings().auth.oidc;
  const cfg = await oidcConfiguration();
  const tokens = await oidc.authorizationCodeGrant(cfg, callbackUrl, {
    pkceCodeVerifier: tx.verifier,
    expectedState: tx.state,
    expectedNonce: tx.nonce,
  });
  let claims: Record<string, unknown> = { ...(tokens.claims() ?? {}) };
  if (!claims[s.groupsClaim] || !claims[s.usernameClaim]) {
    const info = await oidc.fetchUserInfo(cfg, tokens.access_token, String(claims.sub));
    claims = { ...info, ...claims, [s.groupsClaim]: claims[s.groupsClaim] ?? info[s.groupsClaim] };
  }
  const username = claimString(claims, s.usernameClaim) ?? claimString(claims, 'email') ?? String(claims.sub);
  return upsertSsoUser(
    {
      source: 'oidc',
      issuer: claimString(claims, 'iss') ?? s.issuer,
      externalId: String(claims.sub),
      username,
      email: claimString(claims, 'email'),
      firstName: claimString(claims, 'given_name'),
      lastName: claimString(claims, 'family_name'),
      groups: claimList(claims[s.groupsClaim]),
    },
    s,
    ip,
  );
}

// ---------------------------------------------------------------------------
// SAML
// ---------------------------------------------------------------------------

export const samlAcsUrl = () => `${config.publicUrl}/api/auth/saml/acs`;
export const samlEntityId = () => getSettings().auth.saml.spEntityId || `${config.publicUrl}/api/auth/saml/metadata`;

/** A login must come back within this long of starting at the portal. */
export const SAML_REQUEST_TTL_MS = 10 * 60_000;

/**
 * node-saml's cache, kept in SQLite so it is shared by every request and survives a restart: the IDs of
 * AuthnRequests the portal issued (consumed once, atomically) and the IDs of assertions already accepted
 * (kept until they expire), so a response can't be delivered unsolicited or used twice.
 */
class SqliteSamlCache implements CacheProvider {
  constructor(private onSave?: (key: string) => void) {}
  async saveAsync(key: string, value: string) {
    const createdAt = Date.now();
    run(
      'INSERT INTO saml_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      key,
      value,
      createdAt + SAML_REQUEST_TTL_MS,
    );
    this.onSave?.(key);
    return { value, createdAt };
  }
  async getAsync(key: string) {
    return get<{ value: string }>('SELECT value FROM saml_cache WHERE key = ? AND expires_at > ?', key, Date.now())?.value ?? null;
  }
  async removeAsync(key: string | null) {
    if (!key) return null;
    return get<{ value: string }>('DELETE FROM saml_cache WHERE key = ? RETURNING value', key)?.value ?? null;
  }
  async consumeAsync(key: string) {
    return get<{ value: string; expires_at: number }>('DELETE FROM saml_cache WHERE key = ? RETURNING value, expires_at', key)
      ?.value ?? null;
  }
  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number) {
    run('DELETE FROM saml_cache WHERE key = ? AND expires_at <= ?', key, Date.now());
    return run('INSERT INTO saml_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING', key, value, expiresAtMs).changes === 1;
  }
}

export function pruneSamlCache() {
  run('DELETE FROM saml_cache WHERE expires_at <= ?', Date.now());
}

function samlClient(onSave?: (key: string) => void): SAML {
  const s = getSettings().auth.saml;
  if (!s.enabled || !s.entryPoint || !s.idpCert) throw new HttpError(400, 'SAML sign-in is not configured');
  return new SAML({
    callbackUrl: samlAcsUrl(),
    entryPoint: s.entryPoint,
    issuer: samlEntityId(),
    audience: samlEntityId(),
    idpIssuer: s.idpIssuer || undefined,
    idpCert: s.idpCert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, ''),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    identifierFormat: null,
    acceptedClockSkewMs: 60_000,
    // SP-initiated only: every response must answer a request this portal issued, at most once.
    validateInResponseTo: 'always' as never,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    rejectReplayedAssertions: true,
    cacheProvider: new SqliteSamlCache(onSave),
  });
}

export function samlMetadata(): string {
  const s = getSettings().auth.saml;
  // Metadata only needs SP values, so build a client even if the IdP isn't configured yet.
  const sp = new SAML({
    callbackUrl: samlAcsUrl(),
    issuer: samlEntityId(),
    idpCert: s.idpCert ? s.idpCert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '') : 'unset',
    identifierFormat: null,
  });
  return sp.generateServiceProviderMetadata(null, null);
}

/** Starts an SP-initiated login; the request ID is also bound to the browser by the caller (a cookie). */
/** Outstanding SAML request/assertion IDs we keep at most; nginx rate-limits the start route as well. */
export const SAML_CACHE_MAX = 5000;

export async function samlStart(): Promise<{ url: string; requestId: string }> {
  // Every start stores a request ID for ten minutes; bound the table so unauthenticated starts can't grow it without limit.
  const outstanding = get<{ n: number }>('SELECT COUNT(*) AS n FROM saml_cache WHERE expires_at > ?', Date.now())!.n;
  if (outstanding >= SAML_CACHE_MAX) throw new HttpError(503, 'Too many sign-ins are in progress. Please try again in a few minutes.');
  let requestId = '';
  const url = await samlClient((key) => (requestId = key)).getAuthorizeUrlAsync('', undefined, {});
  if (!requestId) throw new Error('SAML request ID was not recorded');
  return { url, requestId };
}

function attr(profile: Profile, name: string): string | undefined {
  if (!name) return undefined;
  const v = (profile as Record<string, unknown>)[name];
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return typeof v === 'string' && v ? v : undefined;
}

export async function samlFinish(body: Record<string, string>, browserRequestId: string | null, ip?: string) {
  const s = getSettings().auth.saml;
  // Unsolicited or foreign responses: only a browser that started this login may finish it (login CSRF).
  if (!browserRequestId) throw new HttpError(401, 'Sign-in session expired or was not started here; please try again from the portal.');
  const { profile } = await samlClient().validatePostResponseAsync(body);
  if (!profile) throw new HttpError(401, 'SAML response contained no profile');
  if (profile.inResponseTo !== browserRequestId) throw new HttpError(401, 'This sign-in response belongs to a different browser session; please try again.');
  const username = attr(profile, s.usernameAttribute) ?? profile.nameID;
  return upsertSsoUser(
    {
      source: 'saml',
      issuer: profile.issuer || s.idpIssuer || s.entryPoint,
      externalId: profile.nameID,
      username,
      email: attr(profile, s.emailAttribute) ?? (profile.email as string | undefined),
      firstName: attr(profile, s.firstNameAttribute),
      lastName: attr(profile, s.lastNameAttribute),
      groups: claimList((profile as Record<string, unknown>)[s.groupsAttribute]),
    },
    s,
    ip,
  );
}

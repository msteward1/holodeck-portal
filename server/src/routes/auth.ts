import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { z } from 'zod';
import { config } from '../config.js';
import { all, get, nowIso, run } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { getSettings } from '../settings.js';
import { audit } from '../audit.js';
import { HttpError, userQuota, type UserRow } from '../labs.js';
import {
  createSession,
  currentSessionId,
  destroySession,
  revokeOtherSessions,
  rotateSession,
  withPasswordSlot,
  reserveLoginAttempt,
  requireUser,
  secureCookies,
} from '../auth/session.js';
import { SAML_REQUEST_TTL_MS, oidcFinish, oidcStart, samlFinish, samlMetadata, samlStart } from '../auth/sso.js';

const OIDC_TX_COOKIE = 'hp_oidc_tx';
/**
 * Binds a SAML login to the browser that started it. The IdP returns with a cross-site POST, which drops
 * SameSite=Lax cookies, so this one is SameSite=None. It holds only the request ID, never a session.
 */
const SAML_TX_COOKIE = 'hp_saml_tx';

export function userView(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    firstName: u.first_name,
    lastName: u.last_name,
    email: u.email,
    role: u.role,
    authSource: u.auth_source,
    enabled: Boolean(u.enabled),
    labQuota: u.lab_quota,
    effectiveQuota: userQuota(u),
  };
}

function loginError(reply: import('fastify').FastifyReply, message: string) {
  return reply.redirect(`/login?error=${encodeURIComponent(message)}`);
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/providers', async () => {
    const s = getSettings();
    return {
      portalName: s.general.portalName,
      local: s.auth.localEnabled,
      oidc: s.auth.oidc.enabled ? { displayName: s.auth.oidc.displayName } : null,
      saml: s.auth.saml.enabled ? { displayName: s.auth.saml.displayName } : null,
    };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user ? userView(req.user) : null }));

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) }).parse(req.body);
    const attempt = reserveLoginAttempt(req.ip, body.username);
    if (!attempt.allowed) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
    const user = get<UserRow & { password_hash: string | null }>('SELECT * FROM users WHERE username = ?', body.username);
    // Admins can always sign in locally so a broken IdP can't lock everyone out.
    const localAllowed = getSettings().auth.localEnabled || user?.role === 'admin';
    const ok =
      user &&
      user.auth_source === 'local' &&
      user.enabled &&
      localAllowed &&
      (await withPasswordSlot(() => verifyPassword(body.password, user.password_hash)));
    if (!ok) {
      // One audit row per account and address per window, not one per guess.
      if (attempt.accountCount === 1) audit(user?.id ?? null, 'auth.login.failed', `user:${body.username.slice(0, 100)}`, null, req.ip);
      throw new HttpError(401, 'Invalid username or password');
    }
    // The check above waited for a password slot; an admin may have reset the password, disabled the account
    // or switched sign-in source meanwhile. Re-read and create the session in the same synchronous step,
    // so nothing can change in between.
    const current = get<UserRow & { password_hash: string | null }>('SELECT * FROM users WHERE id = ?', user.id);
    const stillValid =
      current &&
      current.password_hash === user.password_hash &&
      current.auth_source === 'local' &&
      current.enabled &&
      (getSettings().auth.localEnabled || current.role === 'admin');
    if (!stillValid) throw new HttpError(401, 'Invalid username or password');
    attempt.succeeded();
    createSession(req, reply, user.id);
    audit(user.id, 'auth.login', `user:${user.id}`, { method: 'local' }, req.ip);
    return { user: userView(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) audit(req.user.id, 'auth.logout', `user:${req.user.id}`, null, req.ip);
    destroySession(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const user = requireUser(req);
    const body = z.object({ current: z.string(), next: z.string().min(10).max(500) }).parse(req.body);
    const row = get<{ password_hash: string | null; auth_source: string }>('SELECT password_hash, auth_source FROM users WHERE id = ?', user.id);
    if (row?.auth_source !== 'local') throw new HttpError(400, 'Your password is managed by your identity provider');
    if (!(await withPasswordSlot(() => verifyPassword(body.current, row.password_hash)))) throw new HttpError(400, 'Current password is incorrect');
    const nextHash = await hashPassword(body.next);
    // Only replace the hash that was just verified: a reset or another change that landed while we were
    // hashing wins, and this request must not undo it.
    const changed = run('UPDATE users SET password_hash = ? WHERE id = ? AND enabled = 1 AND password_hash IS ?', nextHash, user.id, row.password_hash).changes === 1;
    if (!changed) throw new HttpError(409, 'Your password was changed elsewhere in the meantime. Sign in again with the new password.');
    // A stolen session must not survive a password change: drop the others and re-issue this one.
    const revoked = revokeOtherSessions(user.id, currentSessionId(req));
    rotateSession(req, reply, user.id);
    audit(user.id, 'auth.password.changed', `user:${user.id}`, { revokedSessions: revoked }, req.ip);
    return { ok: true, revokedSessions: revoked };
  });

  app.get('/api/auth/sessions', async (req) => {
    const user = requireUser(req);
    const current = currentSessionId(req);
    const rows = all<{ id: string; created_at: string; expires_at: string; ip: string | null; user_agent: string | null }>(
      'SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
      user.id,
      nowIso(),
    );
    return {
      sessions: rows.map((r) => ({ current: r.id === current, createdAt: r.created_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent })),
    };
  });

  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const user = requireUser(req);
    const revoked = revokeOtherSessions(user.id, currentSessionId(req));
    audit(user.id, 'auth.sessions.revoked', `user:${user.id}`, { revokedSessions: revoked }, req.ip);
    return { ok: true, revokedSessions: revoked };
  });

  // --- OIDC -----------------------------------------------------------------

  app.get('/api/auth/oidc/login', async (req, reply) => {
    try {
      const { url, transaction } = await oidcStart();
      reply.setCookie(OIDC_TX_COOKIE, JSON.stringify(transaction), {
        path: '/api/auth/oidc',
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
        signed: true,
        maxAge: 600,
      });
      return reply.redirect(url);
    } catch (err) {
      req.log.error(err, 'OIDC start failed');
      return loginError(reply, (err as Error).message);
    }
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const raw = req.cookies[OIDC_TX_COOKIE];
    reply.clearCookie(OIDC_TX_COOKIE, { path: '/api/auth/oidc' });
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return loginError(reply, 'Sign-in session expired; please try again.');
    try {
      const user = await oidcFinish(new URL(req.url, config.publicUrl), JSON.parse(unsigned.value), req.ip);
      createSession(req, reply, user.id);
      audit(user.id, 'auth.login', `user:${user.id}`, { method: 'oidc' }, req.ip);
      return reply.redirect('/');
    } catch (err) {
      req.log.warn(err, 'OIDC callback failed');
      return loginError(reply, (err as Error).message);
    }
  });

  // --- SAML -----------------------------------------------------------------

  app.get('/api/auth/saml/metadata', async (_req, reply) => {
    reply.type('application/samlmetadata+xml');
    return samlMetadata();
  });

  app.get('/api/auth/saml/login', async (req, reply) => {
    try {
      const { url, requestId } = await samlStart();
      reply.setCookie(SAML_TX_COOKIE, requestId, {
        path: '/api/auth/saml',
        httpOnly: true,
        secure: secureCookies,
        sameSite: secureCookies ? 'none' : 'lax',
        signed: true,
        maxAge: SAML_REQUEST_TTL_MS / 1000,
      });
      return reply.redirect(url);
    } catch (err) {
      req.log.error(err, 'SAML start failed');
      return loginError(reply, (err as Error).message);
    }
  });

  // The IdP POSTs a form here; form parsing is enabled only inside this scope.
  await app.register(async (scope) => {
    await scope.register(formbody);
    scope.post('/api/auth/saml/acs', async (req, reply) => {
      try {
        const raw = req.cookies[SAML_TX_COOKIE];
        reply.clearCookie(SAML_TX_COOKIE, { path: '/api/auth/saml' });
        const unsigned = raw ? req.unsignCookie(raw) : null;
        const user = await samlFinish(req.body as Record<string, string>, unsigned?.valid ? unsigned.value : null, req.ip);
        createSession(req, reply, user.id);
        audit(user.id, 'auth.login', `user:${user.id}`, { method: 'saml' }, req.ip);
        return reply.redirect('/');
      } catch (err) {
        req.log.warn(err, 'SAML assertion rejected');
        return loginError(reply, (err as Error).message);
      }
    });
  });
}

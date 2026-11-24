import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { get, nowIso, run } from '../db.js';
import { randomToken, sha256 } from '../crypto.js';
import { HttpError, type UserRow } from '../labs.js';

export const SESSION_COOKIE = 'hp_session';
export const secureCookies = config.publicUrl.startsWith('https://');

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
  }
}

export function createSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    nowIso(),
    expires.toISOString(),
    req.ip,
    String(req.headers['user-agent'] ?? '').slice(0, 300),
  );
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), userId);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    expires,
  });
}

/** Hash of the request's own session token, if any. */
export function currentSessionId(req: FastifyRequest): string | null {
  const token = req.cookies[SESSION_COOKIE];
  return token ? sha256(token) : null;
}

/** Deletes every session of the user except `keepId` (all of them when null). Returns how many were removed. */
export function revokeOtherSessions(userId: number, keepId: string | null): number {
  const res = keepId
    ? run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, keepId)
    : run('DELETE FROM sessions WHERE user_id = ?', userId);
  return Number(res.changes);
}

/** Replaces the request's session with a fresh token (after a password change). */
export function rotateSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const old = currentSessionId(req);
  if (old) run('DELETE FROM sessions WHERE id = ?', old);
  createSession(req, reply, userId);
}

export function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function loadSessionUser(req: FastifyRequest): UserRow | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = get<UserRow & { expires_at: string }>(
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sha256(token),
  );
  if (!row || Date.parse(row.expires_at) < Date.now() || !row.enabled) return null;
  return row;
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
}

export function requireUser(req: FastifyRequest): UserRow {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): UserRow {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'Administrator access required');
  return u;
}

// --- Brute-force protection for local sign-in -------------------------------
//
// Two budgets, both over a sliding 15-minute window that starts at the first attempt:
//   per (IP, username)  - stops guessing one account from one place;
//   per IP              - stops spraying many usernames from one place.
// An attempt is counted *before* the password is checked, so simultaneous requests can't all slip past
// the limit; a successful sign-in gives its attempts back. Accounts are never locked as such, so nobody
// can lock a real user out from elsewhere. State is in memory, swept regularly and capped in size.

const WINDOW_MS = 15 * 60_000;
const MAX_KEYS = 10_000;
const limits = {
  perAccount: Number(process.env.HP_LOGIN_MAX_PER_ACCOUNT ?? 10),
  perIp: Number(process.env.HP_LOGIN_MAX_PER_IP ?? 50),
};
const counters = new Map<string, { count: number; first: number }>();

function counter(key: string, now: number) {
  let c = counters.get(key);
  if (c && now - c.first > WINDOW_MS) {
    counters.delete(key);
    c = undefined;
  }
  return c;
}

function bump(key: string, now: number) {
  const c = counter(key, now);
  if (c) c.count += 1;
  else {
    if (counters.size >= MAX_KEYS) counters.delete(counters.keys().next().value!);
    counters.set(key, { count: 1, first: now });
  }
}

function giveBack(key: string, now: number) {
  const c = counter(key, now);
  if (c && --c.count <= 0) counters.delete(key);
}

export interface LoginAttempt {
  /** False when either budget is used up; the password must not be checked. */
  allowed: boolean;
  /** 1 for the first counted attempt in a window, used to keep the audit log short. */
  accountCount: number;
  succeeded(): void;
}

export function reserveLoginAttempt(ip: string, username: string, now = Date.now()): LoginAttempt {
  const acct = `a|${ip}|${username.toLowerCase()}`;
  const host = `i|${ip}`;
  const a = counter(acct, now);
  const h = counter(host, now);
  if ((a?.count ?? 0) >= limits.perAccount || (h?.count ?? 0) >= limits.perIp) {
    return { allowed: false, accountCount: a?.count ?? 0, succeeded: () => {} };
  }
  bump(acct, now);
  bump(host, now);
  return {
    allowed: true,
    accountCount: counters.get(acct)!.count,
    succeeded: () => {
      counters.delete(acct);
      giveBack(host, Date.now());
    },
  };
}

export function sweepLoginCounters(now = Date.now()) {
  for (const [k, c] of counters) if (now - c.first > WINDOW_MS) counters.delete(k);
}

/** For tests. */
export function resetLoginCounters() {
  counters.clear();
}

setInterval(() => sweepLoginCounters(), 5 * 60_000).unref();

// --- Bounded password hashing --------------------------------------------------
// scrypt is deliberately expensive; at most a few checks run at once, a short queue waits, the rest get 503.

const MAX_HASHING = 4;
const MAX_WAITING = 32;
let hashing = 0;
const waiting: (() => void)[] = [];

export async function withPasswordSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (hashing >= MAX_HASHING) {
    if (waiting.length >= MAX_WAITING) throw new HttpError(503, 'The portal is busy. Try again in a moment.');
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else hashing += 1;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else hashing -= 1;
  }
}

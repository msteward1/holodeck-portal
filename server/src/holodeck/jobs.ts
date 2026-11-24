import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { all, get, nowIso, parseJson, run } from '../db.js';

const execFileP = promisify(execFile);
const JOBS_DIR = path.join(config.dataDir, 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });

const PROMPT_MARKER = '@@HOLOPORTAL_PROMPT@@';
/** The Holorouter running the portal (migration 2 creates it with id 1). */
/** Lock key for jobs that run in the portal itself (holorouter_id NULL). */
const PORTAL_LOCK = 0;

export type JobStatus = 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled';
export const ACTIVE_JOB_STATUSES: JobStatus[] = ['queued', 'running', 'waiting_input'];

export interface JobStep {
  title: string;
  command: string;
  params?: Record<string, unknown>;
  capture?: string;
  redact?: string[];
}

export interface JobSpec {
  type: string;
  labId?: number | null;
  configId?: number | null;
  userId?: number | null;
  /** Holorouter the job runs on (over SSH); null/undefined = in the portal itself (control jobs). */
  routerId?: number | null;
  steps: JobStep[];
  /** Environment for Holodeck -DeveloperMode (depot tokens, placement names). Never stored in the DB. */
  env?: Record<string, string>;
  /** Prompts answered automatically: { match: regex, value }. Never stored in the DB. */
  answers?: { match: string; value: string }[];
  /** Exclusive jobs hold the Holodeck lock of their Holorouter (module state is global per router). */
  exclusive?: boolean;
  /** Display-only summary shown in the UI. */
  display?: Record<string, unknown>;
}

export interface JobRow {
  id: string;
  type: string;
  lab_id: number | null;
  config_id: number | null;
  user_id: number | null;
  holorouter_id: number | null;
  status: JobStatus;
  exclusive: number;
  params: string;
  prompt: string | null;
  result: string | null;
  error: string | null;
  exit_code: number | null;
  unit: string | null;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobPrompt {
  prompt: string;
  secure: boolean;
  index: number;
}

type CompletionHandler = (job: JobRow, result: Record<string, unknown>, ok: boolean) => void | Promise<void>;
const handlers = new Map<string, CompletionHandler>();
const startHandlers = new Map<string, (job: JobRow) => void>();

export function onJobComplete(type: string, handler: CompletionHandler) {
  handlers.set(type, handler);
}
export function onJobStart(type: string, handler: (job: JobRow) => void) {
  startHandlers.set(type, handler);
}

export function jobDir(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job id');
  return path.join(JOBS_DIR, id);
}

export function createJob(spec: JobSpec): JobRow {
  const id = crypto.randomUUID();
  const dir = jobDir(id);
  fs.mkdirSync(dir, { mode: 0o700 });
  const payload = {
    id,
    type: spec.type,
    env: spec.env ?? {},
    answers: spec.answers ?? [],
    steps: spec.steps,
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(payload), { mode: 0o600 });
  // OpenSSL (used by .NET for certificate trust) reads SSL_CERT_FILE from the real process environment, which
  // variables set inside PowerShell never reach; the runner exports it before starting pwsh.
  const trust = spec.env?.SSL_CERT_FILE;
  if (trust) {
    if (!path.resolve(trust).startsWith(path.join(config.dataDir, 'trust') + path.sep)) throw new Error('Unexpected trust bundle path');
    fs.writeFileSync(path.join(dir, 'ssl-cert-file'), path.resolve(trust), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(dir, 'input'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'output.log'), '', { mode: 0o600 });
  run(
    `INSERT INTO jobs (id, type, lab_id, config_id, user_id, holorouter_id, status, exclusive, params)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    id,
    spec.type,
    spec.labId ?? null,
    spec.configId ?? null,
    spec.userId ?? null,
    spec.routerId ?? null,
    spec.exclusive === false ? 0 : 1,
    JSON.stringify(spec.display ?? {}),
  );
  setImmediate(tick);
  return getJob(id)!;
}

export function getJob(id: string): JobRow | undefined {
  return get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await startQueued();
    await monitorRunning();
  } catch (err) {
    console.error('job tick failed', err);
  } finally {
    ticking = false;
  }
}

async function startQueued() {
  const queued = all<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at");
  // Holodeck state is per Holorouter, so each router has its own exclusive lock.
  const busy = new Set(
    all<{ r: number }>(
      "SELECT DISTINCT COALESCE(holorouter_id, 0) AS r FROM jobs WHERE exclusive = 1 AND status IN ('running','waiting_input')",
    ).map((x) => x.r),
  );
  for (const job of queued) {
    const router = job.holorouter_id ?? PORTAL_LOCK;
    if (job.exclusive) {
      if (busy.has(router)) continue;
      busy.add(router);
    }
    await launch(job);
  }
}

async function launch(job: JobRow, opts: { attach?: boolean } = {}) {
  const dir = jobDir(job.id);
  // Jobs for a Holorouter run there over SSH (the wrapper mirrors them into this job directory); jobs without one
  // (vCenter inventory, router deployment, onboarding, staging) run in the portal itself.
  const router = job.holorouter_id ? get<{ address: string }>('SELECT address FROM holorouters WHERE id = ?', job.holorouter_id) : null;
  if (job.holorouter_id && !router) return finish(job, 'failed', {}, 'The Holorouter for this job no longer exists.', null);
  const remote = Boolean(router);
  const runner = path.join(config.psDir, remote ? 'run-remote-job.sh' : 'run-job.sh');
  const runnerArgs = remote ? [runner, dir, router!.address] : [runner, dir];
  const env: Record<string, string> = { HOME: process.env.HOME ?? '/root', HP_PWSH: config.pwsh, PATH: process.env.PATH ?? '/usr/bin:/bin', HP_SSH_DIR: config.sshDir, HP_SSH_CONTROL_DIR: config.sshControlDir };
  if (opts.attach) env.HP_ATTACH = '1';
  let unit: string | null = null;
  let pid: number | null = null;
  try {
    if (config.useSystemdRun) {
      unit = `holoportal-job-${job.id}`;
      // A transient unit outlives portal restarts, so multi-hour deployments are never orphaned.
      await execFileP('systemd-run', [
        `--unit=${unit}`,
        '--collect',
        '--quiet',
        '--description=Holodeck Portal job',
        `--setenv=HOME=${env.HOME}`,
        `--setenv=HP_PWSH=${env.HP_PWSH}`,
        `--setenv=PATH=${env.PATH}`,
        `--setenv=HP_SSH_DIR=${env.HP_SSH_DIR}`,
        `--setenv=HP_SSH_CONTROL_DIR=${env.HP_SSH_CONTROL_DIR}`,
        ...(opts.attach ? ['--setenv=HP_ATTACH=1'] : []),
        '/bin/bash',
        ...runnerArgs,
      ]);
    } else {
      const child = spawn('/bin/bash', runnerArgs, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
      child.unref();
      pid = child.pid ?? null;
    }
    if (opts.attach) {
      run('UPDATE jobs SET unit = ?, pid = ? WHERE id = ?', unit, pid, job.id);
      return;
    }
    run("UPDATE jobs SET status = 'running', started_at = ?, unit = ?, pid = ? WHERE id = ?", nowIso(), unit, pid, job.id);
    startHandlers.get(job.type)?.(getJob(job.id)!);
  } catch (err) {
    await finish(job, 'failed', {}, `Failed to start job: ${(err as Error).message}`, null);
  }
}

async function isProcessAlive(job: JobRow): Promise<boolean> {
  if (job.unit) {
    try {
      const { stdout } = await execFileP('systemctl', ['is-active', `${job.unit}.service`]);
      return ['active', 'activating'].includes(stdout.trim());
    } catch {
      return false;
    }
  }
  if (job.pid) {
    try {
      process.kill(job.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Prompts emitted by the job vs. answers written to its input: more prompts than answers = waiting. */
export function pendingPrompt(id: string): JobPrompt | null {
  const dir = jobDir(id);
  let log = '';
  let answered = 0;
  try {
    log = fs.readFileSync(path.join(dir, 'output.log'), 'utf8');
    answered = Number(fs.readFileSync(path.join(dir, 'answered'), 'utf8')) || 0;
  } catch {
    /* files may not exist yet */
  }
  const prompts: JobPrompt[] = [];
  let at = log.indexOf(PROMPT_MARKER);
  while (at !== -1) {
    const end = log.indexOf('\n', at);
    const raw = log.slice(at + PROMPT_MARKER.length, end === -1 ? undefined : end).trim();
    const parsed = parseJson<{ prompt: string; secure: boolean } | null>(raw, null);
    if (parsed) prompts.push({ ...parsed, index: prompts.length });
    at = log.indexOf(PROMPT_MARKER, at + PROMPT_MARKER.length);
  }
  return prompts.length > answered ? prompts[prompts.length - 1] : null;
}

async function monitorRunning() {
  const active = all<JobRow>("SELECT * FROM jobs WHERE status IN ('running','waiting_input')");
  for (const job of active) {
    const dir = jobDir(job.id);
    const exitFile = path.join(dir, 'exitcode');
    if (fs.existsSync(exitFile)) {
      const code = Number(fs.readFileSync(exitFile, 'utf8').trim());
      const result = parseJson<Record<string, unknown>>(readIfExists(path.join(dir, 'result.json')), {});
      const ok = code === 0 && !result.error;
      await finish(job, ok ? 'succeeded' : 'failed', result, ok ? null : String(result.error ?? `Exit code ${code}`), code);
      continue;
    }
    if (!(await isProcessAlive(job))) {
      // Give the runner a moment to write exitcode before declaring it lost.
      const started = job.started_at ? Date.parse(job.started_at) : 0;
      if (Date.now() - started > 10_000 && !fs.existsSync(exitFile)) {
        // A job on a Holorouter keeps running there under the router's systemd; only the relay in the portal died
        // (e.g. the portal restarted without systemd, in a container). Re-attach instead of losing the job.
        if (job.holorouter_id && fs.existsSync(path.join(dir, '.remote_started')) && reattachAttempts(job.id) < 20) {
          await launch(job, { attach: true });
          continue;
        }
        await finish(job, 'failed', {}, 'Job process ended unexpectedly (no exit code recorded).', null);
      }
      continue;
    }
    const prompt = pendingPrompt(job.id);
    const nextStatus: JobStatus = prompt ? 'waiting_input' : 'running';
    // Remember when this prompt first appeared, for the answer deadline.
    const prev = parseJson<{ index?: number; since?: string } | null>(job.prompt, null);
    const promptJson = prompt ? JSON.stringify({ ...prompt, since: prev?.index === prompt.index && prev.since ? prev.since : nowIso() }) : null;
    if (nextStatus !== job.status || promptJson !== job.prompt) {
      run('UPDATE jobs SET status = ?, prompt = ? WHERE id = ?', nextStatus, promptJson, job.id);
    }
  }
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

async function finish(job: JobRow, status: JobStatus, result: Record<string, unknown>, error: string | null, exitCode: number | null) {
  // Credentials in the result are stored (encrypted) by the completion handler, not in the jobs table.
  const { snapshot, ...publicResult } = result;
  run(
    'UPDATE jobs SET status = ?, result = ?, error = ?, exit_code = ?, prompt = NULL, finished_at = ? WHERE id = ?',
    status,
    JSON.stringify({ ...publicResult, hasSnapshot: Boolean(snapshot) }),
    error,
    exitCode,
    nowIso(),
    job.id,
  );
  const handler = handlers.get(job.type);
  if (handler) {
    try {
      await handler(getJob(job.id)!, result, status === 'succeeded');
    } catch (err) {
      console.error(`completion handler for ${job.type} failed`, err);
    }
  }
  // Result files can hold credentials; the handler has consumed them. The job file (secrets in its environment)
  // is normally deleted by entry.ps1 once read, but not if the job never started or died early; answers too.
  scrubJobFiles(job.id);
  setImmediate(tick);
}

/** Counts re-attachments of a job's relay (kept in its folder), so a relay that can't start isn't retried forever. */
function reattachAttempts(id: string): number {
  const file = path.join(jobDir(id), '.reattached');
  let n = 0;
  try {
    n = Number(fs.readFileSync(file, 'utf8')) || 0;
  } catch {
    /* first time */
  }
  fs.writeFileSync(file, String(n + 1));
  return n;
}

/** Deletes the parts of a finished job's folder that can hold secrets; the log stays for troubleshooting. */
export function scrubJobFiles(id: string) {
  const dir = jobDir(id);
  for (const f of ['result.json', 'job.json']) fs.rmSync(path.join(dir, f), { force: true });
  try {
    if (fs.statSync(path.join(dir, 'input')).size > 0) fs.truncateSync(path.join(dir, 'input'), 0);
  } catch {
    /* no input file */
  }
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export function answerPrompt(id: string, value: string) {
  const job = getJob(id);
  if (!job || job.status !== 'waiting_input') throw new Error('This job is not waiting for input');
  if (/[\r\n]/.test(value)) throw new Error('Answer must be a single line');
  const dir = jobDir(id);
  const answeredFile = path.join(dir, 'answered');
  const answered = Number(readIfExists(answeredFile) ?? '0') || 0;
  fs.writeFileSync(answeredFile, String(answered + 1), { mode: 0o600 });
  fs.appendFileSync(path.join(dir, 'input'), `${value}\n`);
  run("UPDATE jobs SET status = 'running', prompt = NULL WHERE id = ?", id);
}

export async function cancelJob(id: string) {
  const job = getJob(id);
  if (!job || !ACTIVE_JOB_STATUSES.includes(job.status)) throw new Error('Job is not active');
  if (job.status !== 'queued') {
    if (job.unit) await execFileP('systemctl', ['stop', `${job.unit}.service`]).catch(() => undefined);
    else if (job.pid) {
      try {
        process.kill(-job.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  await finish(job, 'cancelled', {}, 'Cancelled by user', null);
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/**
 * Returns log text from `offset` (bytes). Terminal control sequences other than colours are
 * removed and prompt markers are hidden; the UI renders the remaining ANSI colours.
 */
export function readLog(id: string, offset: number, max = 256 * 1024): { text: string; next: number; size: number } {
  const file = path.join(jobDir(id), 'output.log');
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: '', next: 0, size: 0 };
  }
  const start = Math.max(0, Math.min(offset, size));
  const length = Math.min(size - start, max);
  if (length <= 0) return { text: '', next: start, size };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, start);
  fs.closeSync(fd);
  // Only hand back whole lines so escape sequences are never split.
  let end = buf.lastIndexOf(0x0a);
  if (end === -1) end = start + length === size ? length - 1 : -1;
  if (end === -1) return { text: '', next: start, size };
  const chunk = buf.subarray(0, end + 1).toString('utf8');
  return { text: cleanTerminal(chunk), next: start + end + 1, size };
}

export function cleanTerminal(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.includes(PROMPT_MARKER))
    .join('\n')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '') // OSC (window title)
    .replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '') // CSI except SGR colour (…m)
    .replace(/\x1b[=>]/g, '')
    .replace(/\r+\n/g, '\n')
    .replace(/[^\n]*\r(?!\n)/g, ''); // carriage-return overwrites: keep the final text
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

export function startJobLoop() {
  if (timer) return;
  timer = setInterval(tick, 2000);
  setImmediate(tick);
}

export function stopJobLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Clean up job directories for finished jobs older than `days`. Logs remain readable until then. */
export function pruneJobs(days = 90) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  for (const j of all<{ id: string }>("SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?", cutoff)) {
    fs.rmSync(jobDir(j.id), { recursive: true, force: true });
  }
  // Leftovers from jobs that ended before files were scrubbed on completion (or while the portal was down).
  for (const j of all<{ id: string }>('SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at >= ?', cutoff)) scrubJobFiles(j.id);
}

export function jobView(job: JobRow) {
  return {
    id: job.id,
    type: job.type,
    labId: job.lab_id,
    configId: job.config_id,
    userId: job.user_id,
    routerId: job.holorouter_id,
    status: job.status,
    display: parseJson(job.params, {}),
    prompt: parseJson<JobPrompt | null>(job.prompt, null),
    result: parseJson(job.result, null),
    error: job.error,
    exitCode: job.exit_code,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

// Progress tracking for the long write calls (mint, create-collection), so a UI
// (paywindow) can show where a call is while it runs.
//
// Every tracked call is a "job". The step comes from the existing trace() calls in
// midnight-service.ts: tracer() reports into the job of the current async context
// (AsyncLocalStorage), so the service code needs no job plumbing.
//
// Jobs live in memory only (lost on restart, not shared between servers) and are
// dropped 2 h after they finish. Job views never contain seeds.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type JobStep =
  | 'queued' | 'preparing' | 'deploying' | 'proving' | 'balancing'
  | 'submitting' | 'confirming' | 'done' | 'failed';

export type JobState = 'running' | 'done' | 'failed';

const STEP_INFO: Record<JobStep, { label: string; percent: number }> = {
  queued:     { label: 'Warteschlange',                         percent: 0 },
  preparing:  { label: 'Wallets werden vorbereitet',            percent: 5 },
  deploying:  { label: 'Collection wird angelegt',              percent: 10 },
  proving:    { label: 'Zero-Knowledge-Beweis wird erstellt',   percent: 20 },
  balancing:  { label: 'Gebühren werden berechnet und bewiesen', percent: 45 },
  submitting: { label: 'Transaktion wird gesendet',             percent: 60 },
  confirming: { label: 'Warten auf Bestätigung im Block',       percent: 80 },
  done:       { label: 'Fertig',                                percent: 100 },
  failed:     { label: 'Fehlgeschlagen',                        percent: 100 },
};

export interface Job {
  id: string;
  type: string;
  state: JobState;
  step: JobStep;
  phase?: 'collection' | 'mint';
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  history: { step: JobStep; at: number }[];
  httpStatus?: number;
  result?: any;
  error?: string;
}

const jobs = new Map<string, Job>();
const als = new AsyncLocalStorage<Job>();
const KEEP_MS = 2 * 60 * 60_000;
const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Finished write calls (for /api/status: recent durations).
const recent: { type: string; ok: boolean; at: number; ms: number }[] = [];

function prune() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > KEEP_MS) jobs.delete(id);
}

/** Create a job. A caller-supplied id must match JOB_ID_RE (a finished job with that id is replaced). */
export function createJob(type: string, requestedId?: unknown): Job | { error: string } {
  prune();
  let id: string;
  if (requestedId !== undefined && requestedId !== null && requestedId !== '') {
    if (typeof requestedId !== 'string' || !JOB_ID_RE.test(requestedId)) {
      return { error: 'jobId must be 8-64 characters [A-Za-z0-9_-]' };
    }
    id = requestedId;
  } else {
    id = randomUUID();
  }
  const now = Date.now();
  const job: Job = { id, type, state: 'running', step: 'queued', startedAt: now, updatedAt: now, history: [{ step: 'queued', at: now }] };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined { return jobs.get(id); }

export function runInJob<T>(job: Job, fn: () => Promise<T>): Promise<T> { return als.run(job, fn); }

function setStep(job: Job, step: JobStep) {
  if (job.state !== 'running' || job.step === step) return;
  const now = Date.now();
  job.step = step; job.updatedAt = now; job.history.push({ step, at: now });
}

/** Called from tracer(): maps the trace text of the service code to a step. */
export function reportTrace(kind: string, msg: string) {
  const job = als.getStore();
  if (!job) return;
  if (kind === 'collection') job.phase = 'collection';
  if (/^owner wallet|^dust wallet|^provider bridge/.test(msg)) setStep(job, 'preparing');
  else if (/^deploying collection/.test(msg)) { job.phase = 'collection'; setStep(job, 'deploying'); }
  else if (/^minting/.test(msg)) { job.phase = 'mint'; setStep(job, 'proving'); }
  else if (/^contract proof done|^balanced/.test(msg)) setStep(job, 'balancing');
  else if (/^submitting/.test(msg)) setStep(job, 'submitting');
  else if (/^submitted/.test(msg)) setStep(job, 'confirming');
}

function stripSecrets(v: any): any {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const [k, x] of Object.entries(v)) if (!/seed|mnemonic|secret|private/i.test(k)) out[k] = stripSecrets(x);
    return out;
  }
  return v;
}

export function finishJob(job: Job, httpStatus: number, body: any) {
  const now = Date.now();
  job.httpStatus = httpStatus;
  job.finishedAt = now; job.updatedAt = now;
  if (httpStatus < 400) {
    job.state = 'done'; job.result = stripSecrets(body);
    job.step = 'done'; job.history.push({ step: 'done', at: now });
  } else {
    job.state = 'failed'; job.error = String(body?.error ?? `HTTP ${httpStatus}`).slice(0, 500);
    if (body && typeof body === 'object') { const { error: _e, ...rest } = body; if (Object.keys(rest).length) job.result = stripSecrets(rest); }
    job.step = 'failed'; job.history.push({ step: 'failed', at: now });
  }
  // Stats: real outcomes only (not validation errors or refused duplicates).
  if (httpStatus < 400 || httpStatus >= 500) recent.push({ type: job.type, ok: job.state === 'done', at: now, ms: now - job.startedAt });
  if (recent.length > 50) recent.shift();
}

export function jobView(job: Job) {
  const now = Date.now();
  const info = STEP_INFO[job.step];
  return {
    jobId: job.id,
    type: job.type,
    state: job.state,
    step: job.step,
    stepLabel: info.label,
    phase: job.phase,
    percent: info.percent,
    startedAt: new Date(job.startedAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
    elapsedMs: (job.finishedAt ?? now) - job.startedAt,
    history: job.history.map(h => ({ step: h.step, at: new Date(h.at).toISOString(), afterMs: h.at - job.startedAt })),
    httpStatus: job.httpStatus,
    result: job.result,
    error: job.error,
  };
}

export function jobStats() {
  const running = [...jobs.values()].filter(j => j.state === 'running');
  const mints = recent.filter(r => r.type === 'mint');
  const okMints = mints.filter(r => r.ok);
  const last = okMints.slice(-10).map(r => r.ms).sort((a, b) => a - b);
  return {
    running: running.length,
    runningByStep: running.reduce((a: any, j) => { a[j.step] = (a[j.step] || 0) + 1; return a; }, {}),
    lastMints: mints.slice(-10).map(r => ({ at: new Date(r.at).toISOString(), ok: r.ok, durationMs: r.ms })),
    medianMintMs: last.length ? last[Math.floor(last.length / 2)] : null,
  };
}

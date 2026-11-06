import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors';
import type { CreateJobRequest, JobCounts, JobSnapshot, JobStatus, Report } from '../types';

export type JobEventType = 'status' | 'log' | 'done' | 'error' | 'cancelled';

export interface JobEvent {
  type: JobEventType;
  data: unknown;
}

export interface JobLogEntry {
  level: string;
  message: string;
  at: string;
  [key: string]: unknown;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  stage: string;
  progress: number;
  message?: string;
  counts: JobCounts;
  logs: JobLogEntry[];
  error?: { code: string; message: string; detail?: string };
  report?: Report;
  apiKey?: string;
  abort: AbortController;
  request: CreateJobRequest;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface JobStoreOptions {
  retentionMs?: number;
  maxActive?: number;
  now?: () => number;
  maxLogs?: number;
}

type Listener = (event: JobEvent) => void;

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly retentionMs: number;
  private readonly maxActive: number;
  private readonly now: () => number;
  private readonly maxLogs: number;

  constructor(opts: JobStoreOptions = {}) {
    this.retentionMs = opts.retentionMs ?? 60 * 60 * 1000;
    this.maxActive = opts.maxActive ?? 2;
    this.now = opts.now ?? Date.now;
    this.maxLogs = opts.maxLogs ?? 200;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  activeCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === 'queued' || job.status === 'running') n += 1;
    return n;
  }

  create(input: { request: CreateJobRequest; apiKey?: string; dataDir: string }): JobRecord {
    this.cleanupExpired();
    if (this.activeCount() >= this.maxActive) {
      throw new AppError('JOB_LIMIT', `同时最多 ${this.maxActive} 个任务`);
    }
    const ts = this.timestamp();
    const record: JobRecord = {
      id: randomUUID(),
      status: 'queued',
      stage: 'queued',
      progress: 0,
      counts: {},
      logs: [],
      apiKey: input.apiKey,
      abort: new AbortController(),
      request: input.request,
      dataDir: input.dataDir,
      createdAt: ts,
      updatedAt: ts,
    };
    this.jobs.set(record.id, record);
    this.listeners.set(record.id, new Set());
    return record;
  }

  get(id: string): JobRecord | undefined {
    this.cleanupExpired();
    return this.jobs.get(id);
  }

  require(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw new AppError('JOB_NOT_FOUND');
    return job;
  }

  snapshot(record: JobRecord): JobSnapshot {
    return {
      jobId: record.id,
      status: record.status,
      stage: record.stage,
      progress: record.progress,
      counts: { ...record.counts },
      logs: record.logs.map((l) => ({ level: l.level, message: l.message, at: l.at })),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.error ? { error: record.error } : {}),
      ...(record.report ? { report: record.report } : {}),
    };
  }

  private emit(record: JobRecord, event: JobEvent): void {
    const set = this.listeners.get(record.id);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // A broken SSE client must not break the job.
      }
    }
  }

  private statusEvent(record: JobRecord): JobEvent {
    return {
      type: 'status',
      data: {
        status: record.status,
        stage: record.stage,
        progress: record.progress,
        message: record.message ?? '',
        counts: { ...record.counts },
      },
    };
  }

  update(
    record: JobRecord,
    patch: { status?: JobStatus; stage?: string; progress?: number; counts?: JobCounts; message?: string },
  ): void {
    if (record.status === 'cancelled' && patch.status !== 'cancelled') return;
    if (patch.status) record.status = patch.status;
    if (patch.stage !== undefined) record.stage = patch.stage;
    if (patch.progress !== undefined) record.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
    if (patch.counts !== undefined) record.counts = { ...record.counts, ...patch.counts };
    if (patch.message !== undefined) record.message = patch.message;
    record.updatedAt = this.timestamp();
    this.emit(record, this.statusEvent(record));
  }

  log(record: JobRecord, level: string, message: string, extra?: Record<string, unknown>): void {
    if (record.status === 'cancelled') return;
    const entry: JobLogEntry = { level, message, at: this.timestamp(), ...(extra ?? {}) };
    record.logs.push(entry);
    if (record.logs.length > this.maxLogs) record.logs.splice(0, record.logs.length - this.maxLogs);
    record.updatedAt = this.timestamp();
    this.emit(record, { type: 'log', data: { level, message, at: entry.at } });
  }

  private finish(record: JobRecord): void {
    record.finishedAt = this.timestamp();
    record.apiKey = undefined;
    const timer = setTimeout(() => {
      this.remove(record.id);
    }, this.retentionMs);
    timer.unref?.();
  }

  complete(record: JobRecord, report: Report): void {
    if (record.status === 'cancelled') return;
    record.status = 'completed';
    record.stage = 'completed';
    record.progress = 100;
    record.report = report;
    record.updatedAt = this.timestamp();
    this.emit(record, this.statusEvent(record));
    this.emit(record, { type: 'done', data: { report } });
    this.finish(record);
  }

  fail(record: JobRecord, error: { code: string; message: string; detail?: string }): void {
    if (record.status === 'cancelled') return;
    record.status = 'failed';
    record.error = error;
    record.updatedAt = this.timestamp();
    this.emit(record, this.statusEvent(record));
    this.emit(record, { type: 'error', data: error });
    this.finish(record);
  }

  cancel(id: string): JobRecord {
    const record = this.get(id);
    if (!record) throw new AppError('JOB_NOT_FOUND');
    if (record.status === 'cancelled') throw new AppError('CANCELLED', '任务已取消');
    if (record.status === 'completed' || record.status === 'failed') {
      throw new AppError('CANCELLED', '任务已结束，无法取消');
    }
    record.abort.abort();
    record.apiKey = undefined;
    record.status = 'cancelled';
    record.stage = 'cancelled';
    record.updatedAt = this.timestamp();
    this.emit(record, this.statusEvent(record));
    this.emit(record, { type: 'cancelled', data: {} });
    this.finish(record);
    return record;
  }

  getReport(id: string): Report {
    const record = this.require(id);
    if (record.status !== 'completed' || !record.report) {
      throw new AppError('CONFLICT', '任务尚未完成或已取消');
    }
    return record.report;
  }

  subscribe(id: string, listener: Listener): () => void {
    const record = this.require(id);
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    // Recover the current state immediately for reconnecting clients. A broken
    // listener (typically a dropped SSE connection) must not throw here or
    // affect other subscribers.
    const safe = (event: JobEvent) => {
      try {
        listener(event);
      } catch {
        // ignore broken client during replay
      }
    };
    safe(this.statusEvent(record));
    if (record.status === 'completed' && record.report) safe({ type: 'done', data: { report: record.report } });
    if (record.status === 'failed' && record.error) safe({ type: 'error', data: record.error });
    if (record.status === 'cancelled') safe({ type: 'cancelled', data: {} });
    return () => {
      set?.delete(listener);
    };
  }

  cleanupExpired(): void {
    const now = this.now();
    for (const [id, record] of this.jobs) {
      if (!record.finishedAt) continue;
      if (now - Date.parse(record.finishedAt) >= this.retentionMs) this.remove(id);
    }
  }

  remove(id: string): void {
    this.jobs.delete(id);
    this.listeners.delete(id);
  }

  clear(): void {
    this.jobs.clear();
    this.listeners.clear();
  }

  ids(): string[] {
    return [...this.jobs.keys()];
  }
}

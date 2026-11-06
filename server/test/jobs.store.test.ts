import { describe, expect, it } from 'vitest';
import { JobStore, type JobEvent } from '../src/jobs/store';
import type { CreateJobRequest, Report } from '../src/types';

const request = { appid: 570 } as CreateJobRequest;

function makeStore() {
  return new JobStore({ now: () => Date.parse('2026-01-01T00:00:00.000Z') });
}

describe('job store SSE recovery', () => {
  it('replays the current status to a reconnecting subscriber', () => {
    const store = makeStore();
    const record = store.create({ request, apiKey: 'sk-secret', dataDir: '/tmp/data' });
    store.update(record, { status: 'running', stage: 'fetching_reviews', progress: 30, message: '抓取中' });

    const first: JobEvent[] = [];
    const unsubscribe = store.subscribe(record.id, (event) => first.push(event));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: 'status',
      data: { status: 'running', stage: 'fetching_reviews', progress: 30, message: '抓取中' },
    });
    unsubscribe();

    // After disconnecting, updates continue but are not delivered to the gone client.
    store.update(record, { progress: 60 });
    expect(first).toHaveLength(1);

    // A reconnect immediately receives the latest state.
    const second: JobEvent[] = [];
    store.subscribe(record.id, (event) => second.push(event));
    expect(second[0]).toMatchObject({ type: 'status', data: { progress: 60 } });
  });

  it('replays done after completion and clears the API key', () => {
    const store = makeStore();
    const record = store.create({ request, apiKey: 'sk-secret', dataDir: '/tmp/data' });
    const report = { version: '1.0', game: { appid: 570, name: 'Test' } } as Report;
    store.complete(record, report);

    const events: JobEvent[] = [];
    store.subscribe(record.id, (event) => events.push(event));
    expect(events.map((e) => e.type)).toEqual(['status', 'done']);
    expect(events[0].data).toMatchObject({ status: 'completed', progress: 100 });
    expect(events[1].data).toMatchObject({ report });
    expect(record.apiKey).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('sk-secret');
  });

  it('replays error and cancelled terminal events', () => {
    const store = makeStore();
    const failed = store.create({ request, apiKey: 'sk-1', dataDir: '/tmp/data' });
    store.fail(failed, { code: 'STEAM_UNAVAILABLE', message: 'down' });
    const failedEvents: JobEvent[] = [];
    store.subscribe(failed.id, (event) => failedEvents.push(event));
    expect(failedEvents.map((e) => e.type)).toEqual(['status', 'error']);
    expect(failedEvents[1].data).toMatchObject({ code: 'STEAM_UNAVAILABLE' });

    const running = store.create({ request, apiKey: 'sk-2', dataDir: '/tmp/data' });
    store.update(running, { status: 'running' });
    store.cancel(running.id);
    const cancelledEvents: JobEvent[] = [];
    store.subscribe(running.id, (event) => cancelledEvents.push(event));
    expect(cancelledEvents.map((e) => e.type)).toEqual(['status', 'cancelled']);
    expect(running.apiKey).toBeUndefined();
  });

  it('isolates broken SSE listeners from the job and other subscribers', () => {
    const store = makeStore();
    const record = store.create({ request, dataDir: '/tmp/data' });
    const received: JobEvent[] = [];
    store.subscribe(record.id, () => {
      throw new Error('client gone');
    });
    store.subscribe(record.id, (event) => received.push(event));
    expect(() => store.update(record, { status: 'running', progress: 10 })).not.toThrow();
    expect(record.status).toBe('running');
    expect(received.some((e) => e.type === 'status')).toBe(true);
  });
});

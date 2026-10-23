import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisState, START_GRACE_MS } from '../js/runs.js';

const T = Date.parse('2026-10-23T06:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let nextId = 1;
const run = (event, status, conclusion, at, extra = {}) => ({
  id: nextId++, event, status, conclusion, created_at: iso(at), updated_at: iso(at), html_url: `https://github.com/run/${at}`, ...extra,
});
const state = (runs, opts) => analysisState(runs, { now: T, ...opts }).state;

test('a fresh capture is starting until a newer run appears, then stalls', () => {
  const old = run('workflow_dispatch', 'completed', 'success', T - 3_600_000);
  assert.equal(state([old], { started: { at: T - 5_000, afterRunId: old.id } }), 'starting');
  assert.equal(state([old], { started: { at: T - START_GRACE_MS - 1, afterRunId: old.id } }), 'stalled');
  assert.equal(state([], { started: { at: T - 5_000, afterRunId: null } }), 'starting');
  assert.equal(state([]), 'stalled');
});

test("this computer's clock doesn't matter once the new run exists", () => {
  const old = run('workflow_dispatch', 'completed', 'success', T - 3_600_000);
  // GitHub says the new run started a minute "before" the capture.
  const fresh = run('push', 'in_progress', null, T - 60_000);
  assert.equal(state([fresh, old], { started: { at: T, afterRunId: old.id } }), 'starting');
  const analysis = run('workflow_dispatch', 'in_progress', null, T - 60_000);
  assert.equal(state([analysis, fresh, old], { started: { at: T, afterRunId: old.id } }), 'running');
});

test('the dispatcher run counts as starting', () => {
  assert.equal(state([run('push', 'in_progress', null, T - 3_000)]), 'starting');
  assert.equal(state([run('push', 'completed', 'success', T - 10_000)]), 'starting');
  assert.equal(state([run('push', 'completed', 'success', T - START_GRACE_MS - 1)]), 'stalled');
  assert.equal(state([run('push', 'completed', 'failure', T - 10_000)]), 'failed');
});

test('the analysis run reports queued, running with its start time, or failed', () => {
  assert.equal(state([run('workflow_dispatch', 'queued', null, T - 4_000)]), 'queued');
  const running = analysisState([run('workflow_dispatch', 'in_progress', null, T - 40_000, { run_started_at: iso(T - 30_000) })], { now: T });
  assert.deepEqual([running.state, running.since], ['running', T - 30_000]);
  assert.equal(state([run('workflow_dispatch', 'completed', 'failure', T - 9_000)]), 'failed');
  assert.equal(state([run('workflow_dispatch', 'completed', 'cancelled', T - 9_000)]), 'failed');
});

test('a successful run that left a case waiting is stalled', () => {
  assert.equal(state([run('workflow_dispatch', 'completed', 'success', T - 9_000)]), 'stalled');
});

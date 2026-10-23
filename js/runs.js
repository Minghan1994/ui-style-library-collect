// Turns the analyze-cases workflow's runs into one state the page can show
// while a case waits for its draft. Pure, so it's easy to test.
//
// The workflow runs twice per capture: a `push` run that only dispatches,
// then a `workflow_dispatch` run that does the analysis.

/** How long a new capture may go without a visible analysis run. */
export const START_GRACE_MS = 90_000;

const ACTIVE = new Set(['queued', 'waiting', 'pending', 'requested']);

/**
 * runs: newest first, from the Actions API.
 * started: the last capture or retry from this browser, if any:
 *   { at: ms, afterRunId: id of the newest run before it, or null }.
 *   Matching by run id avoids comparing this computer's clock with GitHub's.
 * → { state, since, url }
 *   state: 'starting' | 'queued' | 'running' | 'failed' | 'stalled'
 */
export function analysisState(runs, { now, started = null }) {
  const latest = runs[0];
  const time = (iso) => (iso ? Date.parse(iso) : 0);
  const withinGrace = (from) => now - from < START_GRACE_MS;

  // Started from here, but no newer run exists yet.
  if (started && (latest?.id ?? null) === started.afterRunId) {
    return { state: withinGrace(started.at) ? 'starting' : 'stalled', since: started.at, url: latest?.html_url };
  }
  if (!latest) return { state: 'stalled', since: now, url: undefined };

  const url = latest.html_url;
  const failed = latest.status === 'completed' && latest.conclusion !== 'success';
  if (failed) return { state: 'failed', since: time(latest.updated_at), url };

  if (latest.event === 'push') {
    // The dispatcher; the analysis run appears right after it finishes.
    const since = time(latest.updated_at);
    return { state: latest.status !== 'completed' || withinGrace(since) ? 'starting' : 'stalled', since, url };
  }
  if (ACTIVE.has(latest.status)) return { state: 'queued', since: time(latest.created_at), url };
  if (latest.status === 'in_progress') return { state: 'running', since: time(latest.run_started_at || latest.created_at), url };

  // Finished successfully, yet a case is still waiting: it was skipped.
  return { state: 'stalled', since: time(latest.updated_at), url };
}

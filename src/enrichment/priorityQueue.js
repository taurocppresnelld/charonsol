// Priority queue for outbound API calls — one instance PER PROVIDER (Jupiter, GMGN), never
// shared/mixed across providers, since each has its own independent rate limit.
//
// Bucket-based, not a heap: a handful of discrete priority tiers (see PRIORITY below), not a
// continuous range, so a small array of FIFO buckets is simpler and plenty fast at this volume.
// Within a bucket, plain FIFO — first request at a given priority is served first.
//
// 2026-08-21: two extensions on top of the original plain-serial (one-in-flight-at-a-time)
// design:
//
// 1. Reserved fast lane — a SECOND, independent processing loop that exclusively pulls
//    POSITION_MONITOR-priority items. Without this, a POSITION_MONITOR item that arrives while
//    a lower-priority item is ALREADY running still has to wait for that in-flight call to
//    finish — priority ordering alone only controls what's picked NEXT, it can't preempt
//    something already started. The fast lane gives position checks a slot that's never
//    contended by lower-priority work. This is a genuine, bounded increase in how hard the
//    provider gets hit — exactly 2 concurrent requests max per provider, not unbounded — worth
//    knowing since it's a real behavior change from the original strictly-serial queue.
//
// 2. isAllowed(priority) predicate — optional, injected by the provider module (jupiter.js/
//    gmgn.js), not known by this module. Lets a queue pause pulling low-priority work while a
//    provider's own backoff is active, without this file needing to know what "backoff" means.
//    A skipped-for-now item stays in its bucket; the queue self-retries shortly after rather
//    than requiring the provider to explicitly signal "backoff cleared, wake up."
//
// IMPORTANT for anyone adding new queued functions: never call queue.enqueue() from inside a
// function that's already running as a queued task on the SAME lane (general calling general,
// or fast calling fast) — confirmed directly that this deadlocks the queue permanently (the
// draining/fastLaneDraining re-entrancy guard means the inner enqueue's item can never be
// picked, since nothing will run _drainLoop again until the outer task — which is now stuck
// awaiting the inner one — finishes). See fetchSolUsdPrice and fetchJupiterChartWindow in
// jupiter.js for two real examples that must stay unqueued for exactly this reason.

export const PRIORITY = {
  // 2026-08-22: real logs showed a lot of [quote] 429s despite the quote queue work earlier —
  // root cause was liveExecutor.js's jupiterOrder()/jupiterExecute() hitting the exact same
  // Jupiter endpoint (api.jup.ag/swap/v2) completely independently of this queue and its shared
  // backoff state. Two uncoordinated paths hitting the same provider will always eventually
  // collide, regardless of how careful either one is on its own. LIVE_EXECUTION is the fix's
  // priority tier — above ENTRY_EXECUTION, since this represents a trade that's already been
  // decided and signed, real capital actually moving right now, not just a price check ahead of
  // a decision.
  LIVE_EXECUTION: 110,     // an actual swap order/execute call — capital literally moving now
  ENTRY_EXECUTION: 100,    // a confirmed buy decision's entry-quote fetch — real capital about to commit
  POSITION_MONITOR: 90,    // open position price/exit checks — real capital already at risk
  GRADUATION_TRACKING: 70, // deciding whether a brand-new token should become a candidate at all
  CANDIDATE_SCREENING: 50, // building/filtering candidates that haven't passed anything yet
  BACKGROUND: 10,          // trending refresh, non-time-critical enrichment
};

const SUSPENDED_RETRY_MS = 500;

class PriorityQueue {
  constructor(name, { isAllowed = null, fastLaneMinPriority = PRIORITY.POSITION_MONITOR, taskTimeoutMs = 20_000 } = {}) {
    this.name = name;
    this.buckets = new Map(); // priority -> array of { work, resolve, reject, enqueuedAt }
    this.draining = false;         // general lane
    this.fastLaneDraining = false; // reserved lane, fastLaneMinPriority and above only
    this.isAllowed = isAllowed;    // (priority) => boolean, or null = always allowed
    this.fastLaneMinPriority = fastLaneMinPriority;
    // 2026-08-25: hard ceiling on how long a single queued task can hold up its lane. Without
    // this, one item.work() promise that never settles (any cause — a hung request, a nested
    // enqueue() deadlock as warned about above, anything) leaves `draining` stuck true forever,
    // since _drainLoop's `await item.work()` never returns. Every future request on that lane
    // then silently no-ops via the `if (this.draining) return` guard — permanently, with zero
    // error logged, since nothing ever actually throws. Confirmed as the real-world cause of a
    // multi-hour post-close-tracking outage: individual axios calls in jupiter.js already carry
    // their own 10s timeout, but that only bounds ONE request inside a task — it does nothing if
    // the hang happens elsewhere in that task's own logic. This is now the queue's own backstop,
    // independent of whatever any individual task does or forgets to do. 20s default — comfortably
    // above the 10s axios timeouts already used throughout jupiter.js/gmgn.js, so a normal slow
    // response is never mistaken for a hang, but a task that's still not done at 20s almost
    // certainly never will be.
    this.taskTimeoutMs = taskTimeoutMs;
    this._suspendedRetryTimer = null;
    // 2026-08-21: per-priority counters + wait-time stats (time between enqueue() and work()
    // actually starting — the metric that answers "is this priority genuinely being served
    // promptly," not just "is it picked first when things are otherwise equal"). sumMs/maxMs
    // rather than storing every sample, to stay O(1) memory on a long-running process.
    // suspendedPasses: how many times a drain pass found nothing pickable while isAllowed was
    // blocking something pending — a direct proxy for how often backoff is actually biting.
    this.metrics = new Map(); // priority -> { enqueued, completed, failed, waitCount, waitSumMs, waitMaxMs }
    this.suspendedPasses = 0;
  }

  _metricsFor(priority) {
    if (!this.metrics.has(priority)) {
      this.metrics.set(priority, { enqueued: 0, completed: 0, failed: 0, waitCount: 0, waitSumMs: 0, waitMaxMs: 0 });
    }
    return this.metrics.get(priority);
  }

  enqueue(work, priority = PRIORITY.BACKGROUND) {
    return new Promise((resolve, reject) => {
      if (!this.buckets.has(priority)) this.buckets.set(priority, []);
      this.buckets.get(priority).push({ work, resolve, reject, enqueuedAt: Date.now() });
      this._metricsFor(priority).enqueued++;
      this._drain();
      if (priority >= this.fastLaneMinPriority) this._drainFastLane();
    });
  }

  _sortedPriorities() {
    return [...this.buckets.keys()].sort((a, b) => b - a); // highest first
  }

  // General lane: highest allowed priority BELOW the fast-lane threshold. Deliberately excludes
  // fastLaneMinPriority-and-above — those are the fast lane's exclusive job, so the two lanes
  // never race each other for the same item.
  _pickNext() {
    for (const p of this._sortedPriorities()) {
      if (p >= this.fastLaneMinPriority) continue;
      if (this.isAllowed && !this.isAllowed(p)) continue;
      const bucket = this.buckets.get(p);
      if (bucket.length) return { item: bucket.shift(), priority: p };
    }
    return null;
  }

  // Fast lane: ONLY fastLaneMinPriority-and-above.
  _pickNextFastLane() {
    for (const p of this._sortedPriorities()) {
      if (p < this.fastLaneMinPriority) continue;
      if (this.isAllowed && !this.isAllowed(p)) continue;
      const bucket = this.buckets.get(p);
      if (bucket.length) return { item: bucket.shift(), priority: p };
    }
    return null;
  }

  _hasAnyPending() {
    for (const bucket of this.buckets.values()) if (bucket.length) return true;
    return false;
  }

  // Races item.work() against taskTimeoutMs so a task that never settles can't hold this lane's
  // _drainLoop hostage forever (see the constructor comment on taskTimeoutMs for why this
  // exists). If work() DOES eventually settle after the timeout already fired, its result is
  // just discarded — the caller already got a timeout rejection, so there's nothing left to
  // resolve/reject a second time — and a .catch is attached so a late rejection from the
  // abandoned promise never surfaces as an unhandled rejection warning.
  _runWithTimeout(work, priority) {
    if (!this.taskTimeoutMs) return work();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._metricsFor(priority).timedOut = (this._metricsFor(priority).timedOut || 0) + 1;
        reject(new Error(`task exceeded ${this.taskTimeoutMs}ms timeout on queue "${this.name}" (priority ${priority}) — abandoned so the queue can keep draining`));
      }, this.taskTimeoutMs);
      work().then(
        (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } },
        (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
      ).catch(() => {});
    });
  }

  async _drainLoop(pick) {
    let picked;
    while ((picked = pick())) {
      const { item, priority } = picked;
      const m = this._metricsFor(priority);
      const waitMs = Date.now() - item.enqueuedAt;
      m.waitCount++;
      m.waitSumMs += waitMs;
      if (waitMs > m.waitMaxMs) m.waitMaxMs = waitMs;
      try {
        const result = await this._runWithTimeout(item.work, priority);
        m.completed++;
        item.resolve(result);
      } catch (err) {
        m.failed++;
        item.reject(err);
      }
    }
    // Nothing pickable right now on this pass, but something may be suspended by isAllowed
    // (e.g. provider backoff active). Self-retry rather than needing the provider to explicitly
    // wake this queue when backoff clears.
    if (this.isAllowed && this._hasAnyPending()) {
      this.suspendedPasses++;
      if (!this._suspendedRetryTimer) {
        this._suspendedRetryTimer = setTimeout(() => {
          this._suspendedRetryTimer = null;
          this._drain();
          this._drainFastLane();
        }, SUSPENDED_RETRY_MS);
      }
    }
  }

  async _drain() {
    if (this.draining) return; // already running — the active loop will pick this item up
    this.draining = true;
    await this._drainLoop(() => this._pickNext());
    this.draining = false;
  }

  async _drainFastLane() {
    if (this.fastLaneDraining) return;
    this.fastLaneDraining = true;
    await this._drainLoop(() => this._pickNextFastLane());
    this.fastLaneDraining = false;
  }

  // For visibility/debugging — how many items are waiting, broken down by priority.
  pendingCounts() {
    const out = {};
    for (const [p, bucket] of this.buckets) {
      if (bucket.length) out[p] = bucket.length;
    }
    return out;
  }

  // Full health summary — this is what actually answers "is this queue running well." avgWaitMs
  // per priority is the key number: POSITION_MONITOR should stay near-zero even under load
  // (that's the fast lane doing its job); if it's climbing, something's wrong. maxWaitMs catches
  // the worst single case, which an average can hide. suspendedPasses > 0 means backoff has
  // been actively blocking low-priority work at some point — expected occasionally, a sign of
  // sustained trouble if it's large relative to enqueued volume.
  stats() {
    const byPriority = {};
    for (const [p, m] of this.metrics) {
      byPriority[p] = {
        enqueued: m.enqueued,
        completed: m.completed,
        failed: m.failed,
        timedOut: m.timedOut || 0,
        avgWaitMs: m.waitCount > 0 ? Math.round(m.waitSumMs / m.waitCount) : 0,
        maxWaitMs: m.waitMaxMs,
      };
    }
    return {
      name: this.name,
      pending: this.pendingCounts(),
      draining: this.draining,
      fastLaneDraining: this.fastLaneDraining,
      suspendedPasses: this.suspendedPasses,
      byPriority,
    };
  }
}

export function createPriorityQueue(name, options = {}) {
  return new PriorityQueue(name, options);
}

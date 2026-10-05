// Per-upstream priority queue (FIFO within a priority): max concurrency, max starts per second, minute and hour, a pause for 429 backoff,
// optional even pacing, a safety margin, and an adaptive rate that drops after a 429 and recovers slowly (AIMD). Requests are never
// dropped: they wait. A start is counted when the attempt is sent (every attempt: first tries, 429 and 5xx retries, fallbacks on their
// own upstream), never when it completes.
//
// limits: {maxConcurrent, maxPerSecond, maxPerMinute, maxPerHour,
//          pacing: 'burst' (default: a sliding window only) | 'even' (one start every 60 s / maxPerMinute, so 15/min is one start every 4 s),
//          safetyMargin: 0..0.9 (fraction kept free below every rate, default 0),
//          windowSlackMs: added to the minute and hour windows (absorbs network jitter at the provider's window edge, default 0),
//          abortHoldMs: an attempt aborted after it was sent keeps its concurrency slot this long (the provider may still be working on it),
//          adaptive: false | {decrease: 0.7, min: 0.2, cooldownMs: 300000, increase: 0.1}}
const ADAPTIVE = Object.freeze({ decrease: 0.7, min: 0.2, cooldownMs: 300_000, increase: 0.1, gapMs: 5000 });

export class Limiter {
  constructor({ maxConcurrent = 4, maxPerSecond = null, maxPerMinute = null, maxPerHour = null, pacing = 'burst', safetyMargin = 0, windowSlackMs = 0, abortHoldMs = 0, adaptive = {} } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxPerSecond = maxPerSecond;
    this.maxPerMinute = maxPerMinute;
    this.maxPerHour = maxPerHour;
    this.pacing = pacing === 'even' ? 'even' : 'burst';
    this.safetyMargin = Math.min(0.9, Math.max(0, Number(safetyMargin) || 0));
    this.windowSlackMs = Math.max(0, Number(windowSlackMs) || 0);
    this.abortHoldMs = Math.max(0, Number(abortHoldMs) || 0);
    this.adaptive = adaptive === false ? null : { ...ADAPTIVE, ...(adaptive || {}) };
    this.factor = 1; // the adaptive share of the configured rates (1 = as configured)
    this.adaptedAt = 0; this.lastDecrease = 0;
    this.queue = [];
    this.active = 0;
    this.starts = [];
    this.pausedUntil = 0;
    this.timer = null;
    this.gate = null; // (job, activeMetas) => {wait, reason}: plan-limit check before a job starts
    this.gateReason = null;
    this.activeMeta = new Set();
  }

  get depth() { return this.queue.length; }
  /** Queued jobs per priority class, and why the head of the queue waits (a held background job shows its reason here). */
  queued() {
    const by = { interactive: 0, normal: 0, background: 0 };
    for (const j of this.queue) by[j.priority === 0 ? 'interactive' : j.priority >= 2 ? 'background' : 'normal'] += 1;
    return by;
  }

  pause(ms) {
    this.pauseUntil(Date.now()+ms);
  }

  pauseUntil(until){
    this.pausedUntil=Math.max(this.pausedUntil,until);
    this.#arm(Math.max(0,this.pausedUntil-Date.now()));
  }

  // Seeds the start times (for example from the logs after a restart) so the rate limits survive restarts.
  seed(times) { this.starts = [...this.starts, ...times].sort((a, b) => a - b); }

  /** Starts sent in the last `ms` (this process; the proxy is the only sender of its home). */
  sentWithin(ms, now = Date.now()) { return this.starts.filter((t) => now - t < ms).length; }

  /**
   * A 429 from the provider. Returns {underLimit, factor, adapted}: whether our own starts were within every configured rate when it came,
   * and the adaptive factor after it (lowered at most once per `gapMs`, so one burst of 429s counts once).
   */
  throttled(now = Date.now()) {
    const underLimit = (!this.maxPerMinute || this.sentWithin(60_000, now) <= this.maxPerMinute) && (!this.maxPerSecond || this.sentWithin(1000, now) <= this.maxPerSecond) && (!this.maxPerHour || this.sentWithin(3600_000, now) <= this.maxPerHour);
    let adapted = false;
    if (this.adaptive && now - this.lastDecrease >= this.adaptive.gapMs) {
      const before = this.factor;
      this.factor = Math.max(this.adaptive.min, +(this.factor * this.adaptive.decrease).toFixed(4));
      this.lastDecrease = this.adaptedAt = now;
      adapted = this.factor !== before;
    }
    return { underLimit, factor: this.factor, adapted };
  }

  /** Restores an adaptive factor (from the logs after a restart). */
  restoreFactor(factor, at) { if (this.adaptive && factor > 0 && factor < 1) { this.factor = Math.max(this.adaptive.min, factor); this.adaptedAt = this.lastDecrease = at; } }

  #recover(now) {
    // Additive increase: one step per cooldown without a new 429.
    if (!this.adaptive || this.factor >= 1) return;
    const steps = Math.floor((now - this.adaptedAt) / this.adaptive.cooldownMs);
    if (steps > 0) { this.factor = Math.min(1, +(this.factor + steps * this.adaptive.increase).toFixed(4)); this.adaptedAt += steps * this.adaptive.cooldownMs; }
  }

  /** The rates in force now: the configured ones times (1 - safetyMargin) times the adaptive factor (and the background share). */
  effective(share = 1, now = Date.now()) {
    this.#recover(now);
    const k = (1 - this.safetyMargin) * this.factor * share;
    const cap = (x) => (x ? Math.max(1, Math.floor(x * k)) : null);
    return { factor: this.factor, maxConcurrent: Math.max(1, Math.round(this.maxConcurrent * this.factor)), maxPerSecond: cap(this.maxPerSecond), maxPerMinute: cap(this.maxPerMinute), maxPerHour: cap(this.maxPerHour),
      spacingMs: this.pacing === 'even' ? Math.max(this.maxPerMinute ? 60_000 / (this.maxPerMinute * k) : 0, this.maxPerSecond ? 1000 / (this.maxPerSecond * k) : 0) : 0 };
  }

  // How long a new job with this meta would wait before it could start now (rate limits, 429 pause, plan gate), and why.
  // Jobs already queued are not simulated: the estimate is a lower bound when the queue is not empty.
  estimateWait(meta = null, priority = 1) {
    const saved = this.gateReason;
    const wait = this.#wait({ meta, priority });
    const reason = this.gateReason || (this.pausedUntil > Date.now() ? 'paused after 429' : wait > 0 ? 'queue rate limit' : null);
    this.gateReason = saved;
    return { wait, reason };
  }

  // priority: lower runs first (0 = interactive, 1 = normal, 2 = background); FIFO within a priority.
  schedule(fn, meta = null, priority = 1, signal = null) {
    return new Promise((resolve, reject) => {
      if(signal?.aborted)return reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      const job = { fn, resolve, reject, meta, priority, queuedAt: Date.now(), cleanup:()=>signal?.removeEventListener('abort',onAbort) };
      const onAbort=()=>{
        const index=this.queue.indexOf(job);
        if(index<0)return;
        this.queue.splice(index,1);job.cleanup();
        reject(signal.reason ?? new DOMException('Cancelled','AbortError'));
        if(!this.queue.length)clearTimeout(this.timer);
        this.#pump();
      };
      signal?.addEventListener('abort',onAbort,{once:true});
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1].priority > priority) i -= 1;
      this.queue.splice(i, 0, job);
      this.#pump();
    });
  }

  #arm(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#pump(), Math.max(5, ms));
    this.timer.unref?.();
  }

  #wait(job) {
    const now = Date.now();
    const slack = this.windowSlackMs;
    this.starts = this.starts.filter((t) => now - t < 3600_000 + slack);
    let wait = Math.max(0, this.pausedUntil - now);
    // Background jobs (priority 2) use only `backgroundShare` of the per-minute and per-hour rates.
    const share = job?.priority >= 2 ? (this.backgroundShare ?? 1) : 1;
    const eff = this.effective(1, now), effShared = share === 1 ? eff : this.effective(share, now);
    if (eff.maxPerSecond) {
      const recent = this.starts.filter((t) => now - t < 1000);
      if (recent.length >= eff.maxPerSecond) wait = Math.max(wait, 1000 - (now - recent[recent.length - eff.maxPerSecond]));
    }
    if (effShared.maxPerMinute) {
      const cap = effShared.maxPerMinute;
      const recent = this.starts.filter((t) => now - t < 60_000 + slack);
      if (recent.length >= cap) wait = Math.max(wait, 60_000 + slack - (now - recent[recent.length - cap]));
    }
    const hourCap = effShared.maxPerHour;
    const hour = this.starts.filter((t) => now - t < 3600_000 + slack);
    if (hourCap && hour.length >= hourCap) wait = Math.max(wait, 3600_000 + slack - (now - hour[hour.length - hourCap]));
    // Even pacing: one start per interval, so a provider that meters with a small burst (a token bucket) never sees a burst.
    if (effShared.spacingMs && this.starts.length) wait = Math.max(wait, Math.ceil(this.starts[this.starts.length - 1] + effShared.spacingMs - now));
    this.gateReason = null;
    if (this.gate) {
      const g = this.gate(job, [...this.activeMeta]);
      if (g.wait > wait) { wait = g.wait; this.gateReason = g.reason; }
    }
    return wait;
  }

  #pump() {
    while (this.queue.length && this.active < this.effective().maxConcurrent) {
      const wait = this.#wait(this.queue[0]);
      if (wait > 0) { this.#arm(wait); return; }
      const job = this.queue.shift();
      job.cleanup();
      this.active += 1;
      this.activeMeta.add(job.meta);
      this.starts.push(Date.now());
      const queueWaitMs = Date.now() - job.queuedAt;
      // A job may answer {holdSlotMs}: its concurrency slot stays taken that long after it returns (an aborted attempt the provider may
      // still be computing must not be overlapped at once by its retry).
      const release = () => { this.active -= 1; this.activeMeta.delete(job.meta); this.#pump(); };
      Promise.resolve().then(() => job.fn({ queueWaitMs })).then((v) => { job.resolve(v); return Number(v?.holdSlotMs) || 0; }, (e) => { job.reject(e); return 0; })
        .then((hold) => { if (hold > 0) setTimeout(release, hold).unref?.(); else release(); });
    }
  }
}

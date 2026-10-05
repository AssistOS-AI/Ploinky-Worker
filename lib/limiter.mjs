// Per-upstream priority queue (FIFO within a priority): max concurrency, max starts per second and per hour, and a pause for 429 backoff.
// Requests are never dropped: they wait.
export class Limiter {
  constructor({ maxConcurrent = 4, maxPerSecond = null, maxPerMinute = null, maxPerHour = null } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxPerSecond = maxPerSecond;
    this.maxPerMinute = maxPerMinute;
    this.maxPerHour = maxPerHour;
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
    this.starts = this.starts.filter((t) => now - t < 3600_000);
    let wait = Math.max(0, this.pausedUntil - now);
    if (this.maxPerSecond) {
      const recent = this.starts.filter((t) => now - t < 1000);
      if (recent.length >= this.maxPerSecond) wait = Math.max(wait, 1000 - (now - recent[recent.length - this.maxPerSecond]));
    }
    // Background jobs (priority 2) use only `backgroundShare` of the per-minute and per-hour rates.
    const share = job?.priority >= 2 ? (this.backgroundShare ?? 1) : 1;
    if (this.maxPerMinute) {
      const cap = Math.max(1, Math.floor(this.maxPerMinute * share));
      const recent = this.starts.filter((t) => now - t < 60_000);
      if (recent.length >= cap) wait = Math.max(wait, 60_000 - (now - recent[recent.length - cap]));
    }
    const hourCap = this.maxPerHour ? Math.max(1, Math.floor(this.maxPerHour * share)) : null;
    if (hourCap && this.starts.length >= hourCap) {
      wait = Math.max(wait, 3600_000 - (now - this.starts[this.starts.length - hourCap]));
    }
    this.gateReason = null;
    if (this.gate) {
      const g = this.gate(job, [...this.activeMeta]);
      if (g.wait > wait) { wait = g.wait; this.gateReason = g.reason; }
    }
    return wait;
  }

  #pump() {
    while (this.queue.length && this.active < this.maxConcurrent) {
      const wait = this.#wait(this.queue[0]);
      if (wait > 0) { this.#arm(wait); return; }
      const job = this.queue.shift();
      job.cleanup();
      this.active += 1;
      this.activeMeta.add(job.meta);
      this.starts.push(Date.now());
      const queueWaitMs = Date.now() - job.queuedAt;
      Promise.resolve().then(() => job.fn({ queueWaitMs })).then(job.resolve, job.reject).finally(() => {
        this.active -= 1;
        this.activeMeta.delete(job.meta);
        this.#pump();
      });
    }
  }
}

/**
 * src/facturaQueue.js — Cola dual: Playwright (max 2) + HTTP (max 5)
 */
const PLAYWRIGHT_PORTALES = new Set(['oxxogas']);

class Pool {
  constructor(name, max) { this.name=name; this.max=max; this.running=0; this.queue=[]; this.total=0; this.errors=0; }
  get pending() { return this.queue.length; }
  async add(job) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.running++;
        try { const r = await job(); this.total++; resolve(r); }
        catch(e) { this.errors++; reject(e); }
        finally { this.running--; if (this.queue.length && this.running < this.max) this.queue.shift()(); }
      };
      this.running < this.max ? run() : this.queue.push(run);
    });
  }
  stats() { return { name:this.name, active:this.running, pending:this.queue.length, max:this.max, processed:this.total, errors:this.errors }; }
}

const pwPool   = new Pool('playwright', 2);
const httpPool = new Pool('http', 5);

function enqueue({ comercio, job, onComplete, onError }) {
  const pool = PLAYWRIGHT_PORTALES.has(comercio) ? pwPool : httpPool;
  const position = pool.pending + 1;
  pool.add(job)
    .then(r => { if (onComplete) onComplete(r); })
    .catch(e => { console.error(`[Queue/${pool.name}]`, e.message); if (onError) onError(e); });
  return { position: pool.running >= pool.max ? position : 0, pool: pool.name };
}

function stats() { return { playwright: pwPool.stats(), http: httpPool.stats() }; }

module.exports = { enqueue, stats };

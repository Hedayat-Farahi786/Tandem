/*
 * Rate limits and metrics for the web app. Limits are token buckets per key (an address, a
 * session) and per replica: with several replicas a client gets at most that many times the limit,
 * which is still a firm brake. Metrics are kept in memory and read in Prometheus' text format.
 */

export interface Policy {
  /** Requests allowed in a burst. */
  burst: number;
  /** Requests per minute, refilled continuously. */
  perMinute: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly now: () => number = Date.now) {
    // Forget idle keys, so memory stays bounded.
    this.timer = setInterval(() => {
      const cutoff = this.now() - 10 * 60_000;
      for (const [k, b] of this.buckets) if (b.at < cutoff) this.buckets.delete(k);
    }, 60_000);
    this.timer.unref();
  }

  /** Takes one request; returns 0 when allowed, else the seconds until the next one is. */
  take(key: string, p: Policy): number {
    const now = this.now();
    const rate = p.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: p.burst, at: now };
    b.tokens = Math.min(p.burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }

  close(): void {
    clearInterval(this.timer);
  }
}

type Labels = Record<string, string>;
const key = (l: Labels) =>
  Object.entries(l)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',');

/** Counters and gauges, read as Prometheus text. */
export class Metrics {
  private readonly counters = new Map<string, { help: string; values: Map<string, number> }>();
  private readonly gauges = new Map<string, { help: string; read: () => Promise<Array<[Labels, number]>> }>();
  private readonly durations = new Map<string, { sum: number; count: number }>();

  count(name: string, help: string, labels: Labels = {}, by = 1): void {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = { help, values: new Map() }));
    const k = key(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }
  /** A request's duration, per route. */
  time(route: string, seconds: number): void {
    const d = this.durations.get(route) ?? { sum: 0, count: 0 };
    d.sum += seconds;
    d.count += 1;
    this.durations.set(route, d);
  }
  gauge(name: string, help: string, read: () => Promise<Array<[Labels, number]>>): void {
    this.gauges.set(name, { help, read });
  }

  async text(): Promise<string> {
    const out: string[] = [];
    for (const [name, c] of this.counters) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.values) out.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    out.push('# HELP tandem_http_request_duration_seconds Time to answer, per route.', '# TYPE tandem_http_request_duration_seconds summary');
    for (const [route, d] of this.durations) {
      const l = key({ route });
      out.push(`tandem_http_request_duration_seconds_sum{${l}} ${d.sum.toFixed(6)}`, `tandem_http_request_duration_seconds_count{${l}} ${d.count}`);
    }
    for (const [name, g] of this.gauges) {
      out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
      for (const [l, v] of await g.read().catch(() => [] as Array<[Labels, number]>)) {
        const k = key(l);
        out.push(`${name}${k ? `{${k}}` : ''} ${v}`);
      }
    }
    return `${out.join('\n')}\n`;
  }
}

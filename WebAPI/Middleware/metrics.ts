import type { FastifyInstance, FastifyReply } from "fastify";
import type { Queryable } from "@kiro-ai-bit/eventing";
import type { Metrics } from "@core/metrics.js";

export function createMetrics() {
  const counters = new Map<
    string,
    { name: string; labels: Record<string, string>; value: number }
  >();
  const histograms = new Map<
    string,
    { name: string; labels: Record<string, string>; sum: number; count: number }
  >();
  const labelStr = (labels: Record<string, string>) =>
    Object.keys(labels).length
      ? `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",")}}`
      : "";
  return {
    incr(name: string, labels: Record<string, string> = {}, by = 1): void {
      const key = `${name}|${JSON.stringify(labels)}`;
      const c = counters.get(key) ?? { name, labels, value: 0 };
      c.value += by;
      counters.set(key, c);
    },
    observe(
      name: string,
      labels: Record<string, string> = {},
      value = 0,
    ): void {
      const key = `${name}|${JSON.stringify(labels)}`;
      const h = histograms.get(key) ?? { name, labels, sum: 0, count: 0 };
      h.sum += value;
      h.count += 1;
      histograms.set(key, h);
    },
    render(): string {
      const lines: string[] = [];
      for (const c of counters.values()) {
        lines.push(`# TYPE ${c.name} counter`);
        lines.push(`${c.name}${labelStr(c.labels)} ${c.value}`);
      }
      for (const h of histograms.values()) {
        lines.push(`# TYPE ${h.name} histogram`);
        lines.push(`${h.name}_sum${labelStr(h.labels)} ${h.sum}`);
        lines.push(`${h.name}_count${labelStr(h.labels)} ${h.count}`);
      }
      return lines.join("\n") + "\n";
    },
  };
}

export type MetricsImpl = ReturnType<typeof createMetrics>;

export function registerRedHook(
  app: FastifyInstance,
  metrics: MetricsImpl,
): void {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    metrics.incr("medo_gamification_http_requests_total", {
      method: request.method,
      route,
      status: String(reply.statusCode),
    });
  });
}

export async function renderMetrics(
  reply: FastifyReply,
  deps: { broker?: Queryable },
  metrics: MetricsImpl,
): Promise<void> {
  let deadLetters = 0;
  if (deps.broker) {
    try {
      const r = await deps.broker.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM dead_letters WHERE replayed_at IS NULL",
      );
      deadLetters = Number(r.rows[0]?.c ?? 0);
    } catch {
      /* broker schema may not exist yet */
    }
  }
  const gauges = [
    "# TYPE medo_gamification_dead_letters gauge",
    `medo_gamification_dead_letters ${deadLetters}`,
  ].join("\n");
  reply
    .type("text/plain; version=0.0.4")
    .send(metrics.render() + gauges + "\n");
}

export type { Metrics };

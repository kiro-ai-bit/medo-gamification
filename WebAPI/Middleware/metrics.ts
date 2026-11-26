import type { FastifyInstance, FastifyReply } from "fastify";
import type { Queryable } from "@kiro-ai-bit/eventing";
import type { Metrics } from "@core/metrics.js";

export function createMetrics() {
  const counters = new Map<
    string,
    { name: string; labels: Record<string, string>; value: number }
  >();
  return {
    incr(name: string, labels: Record<string, string> = {}, by = 1): void {
      const key = `${name}|${JSON.stringify(labels)}`;
      const c = counters.get(key) ?? { name, labels, value: 0 };
      c.value += by;
      counters.set(key, c);
    },
    render(): string {
      const lines: string[] = [];
      for (const c of counters.values()) {
        const labelStr = Object.keys(c.labels).length
          ? `{${Object.entries(c.labels)
              .map(([k, v]) => `${k}="${v}"`)
              .join(",")}}`
          : "";
        lines.push(`# TYPE ${c.name} counter`);
        lines.push(`${c.name}${labelStr} ${c.value}`);
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

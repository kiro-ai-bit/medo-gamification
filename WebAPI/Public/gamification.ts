import type { FastifyInstance } from "fastify";
import {
  GamificationPatientParamsSchema,
  GamificationStateDtoSchema,
} from "@kiro-ai-bit/contracts";
import { getState } from "@core/GamificationState/state.js";
import { DependencyError, ForbiddenError } from "../Middleware/errors.js";
import type { MetricsImpl } from "../Middleware/metrics.js";
import { requireUser } from "../Middleware/authz.js";
import type { Db } from "@infrastructure/Persistence/db.js";

export interface GamificationRouteDeps {
  db: Db;
  checkLink: (patientId: string, caregiverId: string) => Promise<boolean>;
  metrics: MetricsImpl;
}

// LLD §6 — the single public route. Authz: patientId == session.sub → allow;
// else Caregiver + active Care Link via check-link (positive-only ≤15 s cache,
// negatives never cached, failure → fail closed DEPENDENCY_UNAVAILABLE).
export function registerGamificationRoutes(
  app: FastifyInstance,
  deps: GamificationRouteDeps,
): void {
  app.get(
    "/v1/patients/:id/gamification",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: {
        params: GamificationPatientParamsSchema,
        response: { 200: GamificationStateDtoSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id: patientId } = request.params as { id: string };

      if (user.sub !== patientId) {
        if (user.role !== "Caregiver") {
          deps.metrics.incr("medo_gamification_reads_total", {
            result: "denied",
          });
          throw new ForbiddenError("forbidden");
        }
        let active: boolean;
        try {
          active = await deps.checkLink(patientId, user.sub);
        } catch {
          deps.metrics.incr("medo_gamification_checklink_total", {
            result: "error",
          });
          throw new DependencyError("care check-link unavailable");
        }
        if (!active) {
          deps.metrics.incr("medo_gamification_reads_total", {
            result: "denied",
          });
          deps.metrics.incr("medo_gamification_checklink_total", {
            result: "inactive",
          });
          throw new ForbiddenError("forbidden");
        }
        deps.metrics.incr("medo_gamification_checklink_total", {
          result: "active",
        });
      }

      const dto = await getState(deps.db, patientId);
      deps.metrics.incr("medo_gamification_reads_total", { result: "ok" });
      return dto;
    },
  );
}

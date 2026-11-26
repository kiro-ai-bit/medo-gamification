import {
  DoseDetailDtoSchema,
  PatientDosesResponseSchema,
  type DoseDetailDto,
  type DoseSummaryDto,
} from "@kiro-ai-bit/contracts";
import { getJson } from "../Clients/http.js";

// LLD §4.10 — consumed internal reads on Schedule & Dose. Service-JWT
// aud=medo-schedule-dose minted per call; 3s + 1 retry/200ms via getJson;
// peer failures surface as PeerUnavailableError/PeerNotFoundError — the
// Application layer maps them (DependencyError retryable / InvalidEventError
// poison). No outcome param on the list call — Core filters unmarked (LD-GAM-04).
export interface ScheduleDoseClient {
  listPatientDoses(
    patientId: string,
    from: string,
    to: string,
  ): Promise<DoseSummaryDto[]>;
  getDose(doseId: string): Promise<DoseDetailDto>;
}

export function createScheduleDoseClient(deps: {
  baseUrl: string;
  mintServiceToken: (aud: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}): ScheduleDoseClient {
  const cfg = {
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    retryDelayMs: deps.retryDelayMs,
  };
  const token = () => deps.mintServiceToken("medo-schedule-dose");
  const base = deps.baseUrl.replace(/\/$/, "");

  return {
    async listPatientDoses(patientId, from, to) {
      const res = await getJson(cfg, {
        url:
          `${base}/v1/patients/${encodeURIComponent(patientId)}/doses` +
          `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        token: await token(),
        parse: (d) => PatientDosesResponseSchema.parse(d),
        label: "schedule-dose listPatientDoses",
      });
      return res.doses;
    },
    async getDose(doseId) {
      return getJson(cfg, {
        url: `${base}/v1/doses/${encodeURIComponent(doseId)}`,
        token: await token(),
        parse: (d) => DoseDetailDtoSchema.parse(d),
        label: "schedule-dose getDose",
      });
    },
  };
}

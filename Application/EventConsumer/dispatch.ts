import type { BrokerEvent } from "@kiro-ai-bit/eventing";

// LLD §4.8 — dispatch routes by eventType; reactions land in ticket 23.
// Until then subscribed types throw so the consumer DLQ path stays honest
// (sibling EventNotImplementedError pattern); the worker is not started yet.
export class EventNotImplementedError extends Error {
  constructor(eventType: string) {
    super(`event reaction not implemented: ${eventType}`);
    this.name = "EventNotImplementedError";
  }
}

export async function dispatch(
  event: BrokerEvent,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _deps: Record<string, unknown>,
): Promise<void> {
  switch (event.type) {
    case "DoseOutcomeChanged":
    case "AccountDeleted":
      throw new EventNotImplementedError(event.type);
    default:
      return; // non-subscribed — skip
  }
}

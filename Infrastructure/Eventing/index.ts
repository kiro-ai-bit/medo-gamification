import {
  createConsumerWorker,
  ensureBrokerSchema,
  ensureConsumerOffsetsSchema,
  type BrokerEvent,
  type ConsumerHandle,
  type EventType,
  type Logger,
  type Queryable,
} from "@kiro-ai-bit/eventing";

// LLD §7.2 — 2 consumed event types on a single consumer group.
export const GAMIFICATION_CONSUMED_EVENTS: readonly EventType[] = [
  "DoseOutcomeChanged",
  "AccountDeleted",
];

// No outbox table exists (publishes none) — service-owned consumer_offsets
// only; broker schema ensured for consumer participation.
export async function ensureGamificationEventing(deps: {
  service: Queryable;
  broker: Queryable;
}): Promise<void> {
  await ensureConsumerOffsetsSchema(deps.service);
  await ensureBrokerSchema(deps.broker);
}

export async function startGamificationConsumer(deps: {
  service: Queryable;
  broker: Queryable | string;
  brokerDsn?: string;
  dispatch: (event: BrokerEvent) => Promise<void>;
  logger?: Logger;
  autoStart?: boolean;
}): Promise<ConsumerHandle> {
  return createConsumerWorker({
    service: deps.service,
    broker: deps.brokerDsn ?? deps.broker,
    consumer: "gamification",
    subscribe: GAMIFICATION_CONSUMED_EVENTS,
    dispatch: deps.dispatch,
    pollIntervalMs: 5000,
    logger: deps.logger,
    autoStart: deps.autoStart,
  });
}

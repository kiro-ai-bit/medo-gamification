import type { Db } from "@infrastructure/Persistence/db.js";
import type { Metrics } from "@core/metrics.js";
import type { ScheduleDoseClient } from "@infrastructure/ScheduleDoseClient/index.js";
import type { CheckLinkCache } from "@infrastructure/CareClient/checkLink.js";

export interface ConsumerDeps {
  db: Db;
  scheduleDose: ScheduleDoseClient;
  checkLinkCache: CheckLinkCache;
  metrics?: Metrics;
  now: () => Date;
}

import type { Config } from "./config.js";
import type { Db } from "./db.js";

/** Everything a service needs. The clock is injected so tests can control time. */
export interface Context {
  db: Db;
  config: Config;
  now: () => Date;
}

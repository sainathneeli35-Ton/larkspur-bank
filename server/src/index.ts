import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { Context } from "./context.js";
import { openDb } from "./db.js";
import { runDueSchedules } from "./services/schedules.js";

const config = loadConfig();
const ctx: Context = { db: openDb(config.dbPath), config, now: () => new Date() };

const sweep = () => {
  try {
    const { paid, failed } = runDueSchedules(ctx);
    if (paid || failed) console.log(`Scheduled payments: ${paid} paid, ${failed} failed`);
  } catch (err) {
    console.error("Scheduled payment sweep failed", err);
  }
};
sweep(); // catch up on anything that fell due while the server was off
const timer = setInterval(sweep, 60_000);

const server = createApp(ctx).listen(config.port, () => {
  console.log(`Larkspur Bank API listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  clearInterval(timer);
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

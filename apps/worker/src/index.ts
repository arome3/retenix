import cron from "node-cron";
import { PgBoss } from "pg-boss";
import { env } from "../env";

// Boot: cron + pg-boss workers. Module 08 fills in the handlers.
async function main() {
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: Error) => console.error("[worker] pg-boss error", err));
  await boss.start();

  // Per-minute due-plan scan cadence (module 08 implements the handler).
  const scan = cron.schedule("* * * * *", () => {});

  console.log("[worker] booted — cron scheduled, pg-boss started");

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received — shutting down`);
    scan.stop();
    await boss.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] boot failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

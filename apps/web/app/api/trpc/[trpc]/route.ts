import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createContext } from "@/server/context";
import { appRouter } from "@/server/routers";

// doc 06: sweep.preview / sweep.execute quote sells and re-verify legs against
// Particle — network-bound work that can exceed a short serverless default.
// 60s is a hard ceiling, not a target: per-leg verification polls are capped
// far below it (routers/sweep.ts).
export const maxDuration = 60;

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
  });

export { handler as GET, handler as POST };

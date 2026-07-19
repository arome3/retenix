import { router } from "../trpc";
import { accountRouter } from "./account";
import { activityRouter } from "./activity";
import { authRouter } from "./auth";
import { complianceRouter } from "./compliance";
import { estateRouter } from "./estate";
import { intentRouter } from "./intent";
import { killRouter } from "./kill";
import { plansRouter } from "./plans";
import { portfolioRouter } from "./portfolio";
import { securityRouter } from "./security";
import { sendRouter } from "./send";
import { sweepRouter } from "./sweep";

// Canonical tRPC surface (tech spec §13); each route is implemented in its
// owner module — names and procedure classes never change. security.* are
// doc 15's additive helper routes (the modules-02/06/10 precedent).
export const appRouter = router({
  auth: authRouter,
  compliance: complianceRouter,
  account: accountRouter,
  sweep: sweepRouter,
  intent: intentRouter,
  plans: plansRouter,
  portfolio: portfolioRouter,
  activity: activityRouter,
  kill: killRouter,
  estate: estateRouter,
  send: sendRouter,
  security: securityRouter,
});

export type AppRouter = typeof appRouter;

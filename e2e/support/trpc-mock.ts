import type { Page } from "@playwright/test";

/*
 * Route-level tRPC mocking for specs that must not depend on live Particle /
 * RPC endpoints (doc 06 e2e). httpBatchLink batches procedures into one
 * request (`/api/trpc/a,b?batch=1&input={"0":…}`); a request is fulfilled
 * only when EVERY procedure in the batch has a handler — otherwise it falls
 * through to the real server (session reads etc. stay real).
 */

type Handler = (input: unknown) => unknown | Promise<unknown>;

/**
 * Home's portfolio queries (doc 12) ride the SAME httpBatchLink batch as
 * account.summary/sweep.preview — an unhandled procedure un-mocks the whole
 * batch. Specs that mock any Home query must spread these too (an empty,
 * honest statement) unless they mean to hit the real portfolio routes.
 */
export const emptyPortfolioMocks: Record<string, Handler> = {
  "portfolio.holdings": () => ({
    holdings: [],
    totalUsd: 0,
    costBasisUsd: 0,
    returnUsd: null,
    returnPct: null,
    asOf: new Date().toISOString(),
    unattributedBuys: 0,
  }),
  "portfolio.chart": () => ({ points: [], asOf: new Date().toISOString() }),
  "portfolio.topUpPrompt": () => null,
  "activity.feed": () => ({ items: [] }),
  // doc 14: C8 polls estate.status from the (app) LAYOUT, so it rides the
  // first batch of every authed screen — same un-mocking hazard as the
  // portfolio queries. Not-enrolled is the empty, honest statement.
  "estate.status": () => ({ enrolled: false, view: null }),
};

export async function mockTrpc(
  page: Page,
  handlers: Record<string, Handler>,
  opts: { delayMs?: number } = {},
): Promise<void> {
  // doc 14: the (app) LAYOUT queries estate.status (C8), so it can ride ANY
  // authed screen's batch — an unhandled layout query would un-mock whole
  // batches spec-by-spec. Default it here (not-enrolled), overridable by
  // specs that drive the banner.
  handlers = { "estate.status": () => ({ enrolled: false, view: null }), ...handlers };
  await page.route("**/api/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const procedures = url.pathname
      .replace(/^.*\/api\/trpc\//, "")
      .split(",")
      .map(decodeURIComponent);
    if (!procedures.every((p) => handlers[p])) {
      return route.fallback();
    }

    let inputs: Record<string, { json?: unknown } | unknown> = {};
    try {
      const raw =
        route.request().method() === "GET"
          ? (url.searchParams.get("input") ?? "{}")
          : (route.request().postData() ?? "{}");
      inputs = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // no input on the batch — handlers receive undefined
    }

    if (opts.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }

    const body = await Promise.all(
      procedures.map(async (p, i) => ({
        result: { data: await handlers[p]((inputs as Record<string, unknown>)[String(i)]) },
      })),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

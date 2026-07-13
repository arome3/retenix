import type { Page } from "@playwright/test";

/*
 * Route-level tRPC mocking for specs that must not depend on live Particle /
 * RPC endpoints (doc 06 e2e). httpBatchLink batches procedures into one
 * request (`/api/trpc/a,b?batch=1&input={"0":…}`); a request is fulfilled
 * only when EVERY procedure in the batch has a handler — otherwise it falls
 * through to the real server (session reads etc. stay real).
 */

type Handler = (input: unknown) => unknown | Promise<unknown>;

export async function mockTrpc(
  page: Page,
  handlers: Record<string, Handler>,
  opts: { delayMs?: number } = {},
): Promise<void> {
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

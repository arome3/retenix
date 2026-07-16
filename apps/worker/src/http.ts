// Internal HTTP surface (doc 08): demo/ops tooling ONLY, authenticated with
// INTERNAL_API_TOKEN (timing-safe) and network-restricted in production
// (TS-13.2 — Railway private networking; module 17 owns the deploy side).
//
//   POST /internal/execute-now {planId}  — enqueue the current period now
//                                          ("run first buy now"; idempotent —
//                                          a period that already ran no-ops)
//   POST /internal/demo/rogue  {planId}  — DEMO_MODE=1 only; the endpoint
//                                          does not exist otherwise (404
//                                          before auth, leaking nothing)
//   GET  /healthz                        — liveness (Railway healthcheck)
//
// Plain node:http — two routes don't justify a framework dependency.

import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { env } from "../env";
import { captureError } from "./notify";
import { enqueuePlanNow, enqueueRogue, type SchedulerCtx } from "./scheduler";

export interface HttpCtx extends SchedulerCtx {
  demoMode: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(req: IncomingMessage): boolean {
  const header = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${env.INTERNAL_API_TOKEN}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

function readJson(req: IncomingMessage, limit = 4_096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function route(
  ctx: HttpCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    return json(res, 200, { ok: true });
  }
  if (req.method !== "POST") return json(res, 404, { error: "not found" });

  const isExecuteNow = req.url === "/internal/execute-now";
  const isRogue = req.url === "/internal/demo/rogue";
  // The rogue trigger must not EXIST outside demo mode — 404 before auth.
  if (isRogue && !ctx.demoMode) return json(res, 404, { error: "not found" });
  if (!isExecuteNow && !isRogue) return json(res, 404, { error: "not found" });

  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : "bad body" });
  }
  const planId = (body as { planId?: unknown } | null)?.planId;
  if (typeof planId !== "string" || !UUID_RE.test(planId)) {
    return json(res, 400, { error: "planId (uuid) required" });
  }

  const result = isExecuteNow
    ? await enqueuePlanNow(ctx, planId)
    : await enqueueRogue(ctx, planId);
  if ("error" in result) return json(res, 404, result);
  return json(res, 202, result);
}

export function createInternalServer(ctx: HttpCtx): Server {
  return createServer((req, res) => {
    route(ctx, req, res).catch((err: unknown) => {
      captureError(err, { while: "internal-http", url: req.url });
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
  });
}

export function startHttp(ctx: HttpCtx): Server {
  const server = createInternalServer(ctx);
  server.listen(env.PORT, () => {
    console.log(`[worker] internal endpoints on :${env.PORT} (network-restricted in prod, TS-13.2)`);
  });
  return server;
}

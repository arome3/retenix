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
//   POST /webhooks/alchemy               — module 14: Alchemy Address
//                                          Activity. Authenticated by the
//                                          HMAC signature over the RAW body
//                                          (X-Alchemy-Signature), NOT the
//                                          bearer token — Alchemy can't send
//                                          one. UX notifications only.
//   GET  /healthz                        — liveness (Railway healthcheck).
//                                          Unauthenticated and dependency-free
//                                          BY DESIGN: Railway's probe cannot
//                                          send a header, and a public endpoint
//                                          must not publish queue depth.
//   GET  /internal/health                — doc 17 readiness: queue depth, last
//                                          cron tick, RPC reachability. Bearer
//                                          token; 200 healthy / 503 degraded.
//
// Plain node:http — this few routes don't justify a framework dependency.

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
import { handleAddressActivity, verifyAlchemySignature, type WebhookDeps } from "./webhooks";

export interface HttpCtx extends SchedulerCtx {
  demoMode: boolean;
  /** Module 14: the Alchemy receiver's deps (absent in bare test contexts). */
  estateWebhook?: WebhookDeps;
  /**
   * Module 17: /internal/health's collector (absent in bare test contexts).
   * Only `ok` is read here — it picks 200 vs 503; the body is serialised whole.
   */
  health?: { collect(): Promise<{ ok: boolean }> };
}

/**
 * Deny-by-default for /internal/* arriving through a PUBLIC edge (TS-13.2).
 *
 * The spec asks for Railway private networking as the boundary, with
 * INTERNAL_API_TOKEN as the second factor. Private networking is real, but it
 * is scoped to a Railway environment — Vercel is a different cloud and cannot
 * resolve *.railway.internal, so "web calls worker over the private hostname"
 * is not achievable as written (recorded in HANDOFF). Meanwhile the worker
 * needs public ingress at all, because Alchemy's Address Activity webhooks
 * originate on the internet.
 *
 * This is the enforceable half: Railway's edge sets x-forwarded-for, and a
 * caller on the private network does not. With INTERNAL_ROUTES_PRIVATE_ONLY=1
 * (production), an /internal/* request that came through the public edge does
 * not exist. 404, not 403 — the same posture as the rogue route, leaking
 * nothing about what is behind it.
 *
 * Staging leaves it "0": e2e drives /internal/demo/rogue over the public domain.
 */
function viaPublicEdge(req: IncomingMessage): boolean {
  return (
    env.INTERNAL_ROUTES_PRIVATE_ONLY === "1" &&
    req.headers["x-forwarded-for"] !== undefined
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(req: IncomingMessage): boolean {
  const header = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${env.INTERNAL_API_TOKEN}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

/** Raw body read — the Alchemy HMAC signs the exact bytes. */
function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
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
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

  // Every /internal/* route, GET or POST, sits behind the public-edge fence.
  if (req.url?.startsWith("/internal/") && viaPublicEdge(req)) {
    return json(res, 404, { error: "not found" });
  }

  // Must be answered before the POST-only guard below.
  if (req.method === "GET" && req.url === "/internal/health") {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    if (!ctx.health) {
      return json(res, 503, { ok: false, degraded: ["health probes unavailable"] });
    }
    const body = await ctx.health.collect();
    return json(res, body.ok ? 200 : 503, body);
  }

  if (req.method !== "POST") return json(res, 404, { error: "not found" });

  // Alchemy webhook — HMAC over the RAW body is the auth (see header).
  if (req.url === "/webhooks/alchemy") {
    if (!ctx.estateWebhook) return json(res, 404, { error: "not found" });
    const raw = await readRaw(req, 1_048_576);
    const signature = req.headers["x-alchemy-signature"];
    if (!verifyAlchemySignature(raw, typeof signature === "string" ? signature : undefined)) {
      return json(res, 401, { error: "bad signature" });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const result = await handleAddressActivity(ctx.estateWebhook, body);
    return json(res, 200, result);
  }

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

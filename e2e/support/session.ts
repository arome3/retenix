import type { BrowserContext } from "@playwright/test";
import { SignJWT } from "jose";
import { Pool } from "pg";

/*
 * Signing in for a test.
 *
 * Retenix ships no endpoint that mints a session without a Magic DID token, and
 * module 02 is not going to add one for the convenience of its own tests. So the
 * tests do what the server does: insert the users row, sign the same HS256 claim
 * with SESSION_SECRET, and hand the browser the cookie.
 *
 * That keeps the production surface honest and still exercises the real proxy,
 * the real requireSession, and the real procedures.
 */
const SESSION_COOKIE = "retenix_session";
const GATE_COOKIE = "retenix_gate";
const SESSION_TTL_SECS = 7 * 24 * 60 * 60;

let pool: Pool | undefined;
function db(): Pool {
  pool ??= new Pool({ connectionString: required("DATABASE_URL") });
  return pool;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`e2e: ${name} is not set`);
  return value;
}

async function sessionKey(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(required("SESSION_SECRET")),
  );
  return new Uint8Array(digest);
}

export type TestUser = { userId: string; eoa: string; emailHash: string };

/** A fresh user per test, so parallel specs never fight over one row. */
export async function createTestUser(region: string): Promise<TestUser> {
  const suffix = Math.floor(Math.random() * 0xffff_ffff)
    .toString(16)
    .padStart(8, "0");
  const emailHash = `0xe2e${suffix}${"0".repeat(53)}`;
  const eoa = `0xe2e${suffix}${"0".repeat(29)}`;

  const { rows } = await db().query<{ id: string }>(
    `insert into users (email_hash, eoa_addr, ua_evm_addr, ua_sol_addr, region)
     values ($1, $2, '', '', $3) returning id`,
    [emailHash, eoa, region],
  );
  return { userId: rows[0].id, eoa, emailHash };
}

export async function deleteTestUser(user: TestUser): Promise<void> {
  await db().query("delete from events where user_id = $1", [user.userId]);
  await db().query("delete from users where id = $1", [user.userId]);
}

/*
 * Safety net for the rows a test that dies mid-body never got to delete. Every
 * e2e user is minted with an `0xe2e` email_hash prefix, which a sha256 digest of
 * a real address will not collide with in any run that matters.
 */
export async function sweepTestUsers(): Promise<number> {
  await db().query(
    `delete from events
      where user_id in (select id from users where email_hash like '0xe2e%')`,
  );
  const { rowCount } = await db().query(
    "delete from users where email_hash like '0xe2e%'",
  );
  return rowCount ?? 0;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** The row is authoritative; the cookie only has to agree with it. */
export async function setRegion(user: TestUser, region: string): Promise<void> {
  await db().query("update users set region = $1 where id = $2", [region, user.userId]);
}

export async function signIn(
  context: BrowserContext,
  user: TestUser,
  region: string,
): Promise<void> {
  const token = await new SignJWT({
    eoa: user.eoa,
    issuer: `did:ethr:${user.eoa}`,
    region,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECS}s`)
    .sign(await sessionKey());

  const base = new URL(process.env.APP_BASE_URL ?? "http://localhost:3000");
  const shared = {
    domain: base.hostname,
    path: "/",
    httpOnly: true,
    // Chromium treats localhost as a secure context, so Secure survives http there.
    secure: true,
    sameSite: "Lax" as const,
    expires: Math.floor(Date.now() / 1000) + SESSION_TTL_SECS,
  };

  const cookies = [{ name: SESSION_COOKIE, value: token, ...shared }];
  if (region) cookies.push({ name: GATE_COOKIE, value: "1", ...shared });
  await context.addCookies(cookies);
}

export type OnboardingEvent = {
  type: string;
  createdAt: Date;
  payload: { sid: string; elapsedMs?: number | null };
};

/** Events written by auth.trackOnboarding, newest first. */
export async function readOnboardingEvents(sid?: string): Promise<OnboardingEvent[]> {
  const { rows } = sid
    ? await db().query(
        `select type, created_at, payload_json from events
          where type in ('onboarding.started', 'onboarding.ready')
            and payload_json->>'sid' = $1
          order by created_at desc`,
        [sid],
      )
    : await db().query(
        `select type, created_at, payload_json from events
          where type in ('onboarding.started', 'onboarding.ready')
          order by created_at desc`,
      );
  return rows.map((r) => ({
    type: r.type as string,
    createdAt: r.created_at as Date,
    payload: r.payload_json as OnboardingEvent["payload"],
  }));
}

export async function deleteEventsBySid(sid: string): Promise<void> {
  await db().query("delete from events where payload_json->>'sid' = $1", [sid]);
}

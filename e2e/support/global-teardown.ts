import { closeDb, sweepTestUsers } from "./session";

/*
 * A spec that dies mid-body never reaches its own cleanup. Rather than trust
 * every test to be careful, sweep the users it minted once the run is over.
 */
export default async function globalTeardown(): Promise<void> {
  const removed = await sweepTestUsers();
  if (removed > 0) console.log(`e2e teardown: swept ${removed} leftover test user(s)`);
  await closeDb();
}

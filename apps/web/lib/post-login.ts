/*
 * Fired the instant a session lands, before the user has finished onboarding.
 *
 * The <60s warm-path budget (PS-F1-AC1) is spent almost entirely on email
 * delivery, so the two slow initializations that follow login are started here
 * and awaited nowhere. Both are stubs until their modules exist.
 *
 * Nothing in here may throw or block: a failed warm-up costs latency later, a
 * thrown one costs the user their onboarding.
 */

/** TODO(doc 03): initialize the Universal Account for this owner address. */
async function warmUniversalAccount(eoa: string): Promise<void> {
  void eoa;
}

/** TODO(doc 05): warmUpToken() over the launch asset set. */
async function warmUpToken(): Promise<void> {}

export function onSessionEstablished(eoa: string): void {
  void warmUniversalAccount(eoa).catch(() => {});
  void warmUpToken().catch(() => {});
}

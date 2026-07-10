# Retenix web

Next.js 16 App Router app (doc 00). The design foundation — tokens, themes,
type, motion, formatting, shell — is module 01 (`docs/01-design-foundation.md`);
everything user-visible builds on it.

- `pnpm --filter web dev` → http://localhost:3000
- `/dev/tokens` — the token sheet (dev only): all primitives, type scale, and
  components in light/dark/±cvd
- `/dev/7702-smoke` — gate G1 (dev only): `switchChain(42161)` then
  `sign7702Authorization`, serialized the way doc 03 will. Sign in first.
- `pnpm contrast` · `pnpm copy-canon` · `pnpm e2e` — the design-foundation CI
  gates (WCAG pairs, banned vocabulary, axe + keyboard walk)

## Auth & session (module 02)

- Real `NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY` and `MAGIC_SECRET_KEY` are required to
  sign in. Add `localhost:3000` to the Magic dashboard allowlist or signing fails.
- Set `DEMO_MODE=1` in `.env.local` to enable the eligibility gate's
  pass-through, otherwise `/eligibility` dead-ends until doc 04 lands. It cannot
  be enabled in a production build.
- The session cookie is `Secure` even on `http://localhost`. Chromium and Firefox
  treat localhost as a secure context; older Safari does not — develop against
  Chromium or a TLS tunnel.
- Magic's `testMode` is **not** used: it short-circuits Magic *links* only, never
  email OTP. Dev points at a Magic dev app (testnet); the key selects the
  environment, not an SDK flag.

## UI review checklist (every PR that renders numbers or copy)

This is the enforcement mechanism for doc 01 task 4 (in lieu of a bespoke
ESLint rule) — reviewers block on any of these:

1. **No raw money interpolation in JSX.** Every mutable number — balances,
   deltas, fees, table cells, countdowns — renders through `<Num>` (or
   `<HeroMoney>` for the hero) so it carries `.tnum` (G13). `{fmtUsd(x)}`
   directly in JSX text is a defect; `<Num>{fmtUsd(x)}</Num>` is the floor.
2. **`lib/format.ts` only.** No hand-rolled number/date strings — `fmtUsd`,
   `fmtPct`, `fmtDelta`, `truncAddr`, `relTime` (+ `absTime` for tooltips,
   which are always absolute).
3. **Delta glyphs are text.** `▲ ▼ + −` come from `fmtDelta` (U+2212 minus),
   never icons; gain/loss colors never mark success/error (G14).
4. **Numeric table columns right-align.**
5. **Copy canon.** No banned vocabulary in decision surfaces — the CI grep
   (`pnpm copy-canon`) is the authority; receipt contexts use the
   `copy-canon-allow` marker deliberately, not to silence mistakes.
6. **Tokens only.** New UI consumes the semantic tokens (`bg-positive`,
   `text-agent`, `rounded-lg`, `font-display`); no ad-hoc colors, shadows, or
   radii. Teal appears only where the agent acts or the user commands.
7. **Motion.** Use `transition-micro/standard/reveal` + the `--animate-*`
   tokens; overlay surfaces carry `data-rm-fade`; count-ups go through
   `useCountUp`. Never celebrate a trade (G15).

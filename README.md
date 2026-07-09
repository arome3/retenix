# Retenix

The self-custodial brokerage that runs itself — Arnen Labs, UXmaxx hackathon build.

Implementation docs live in [`docs/`](docs/index.md); module 00 (this scaffold) is the
foundation contract every other module references.

## Prerequisites

- Node 20+ (`.nvmrc` says 22) and pnpm 9 (`corepack enable` or `npm i -g pnpm@9`)
- Foundry (stable channel via `foundryup`) for `contracts/`
- A reachable Postgres and a `DATABASE_URL` for it

## Quickstart

```bash
cp .env.example .env                              # tooling (drizzle-kit, db tests)
cp apps/web/.env.example apps/web/.env.local      # web
cp apps/worker/.env.example apps/worker/.env      # worker
# set DATABASE_URL in all three; other values can stay placeholders for local dev

pnpm i
pnpm db:push   # create the schema
pnpm dev       # web on :3000 + worker, concurrently
```

## Checks

```bash
pnpm test        # vitest across packages and apps
pnpm lint        # eslint (includes the no-process.env rule)
pnpm typecheck   # tsc -b + Next app typecheck
pnpm check:pins  # the two exact SDK pins
pnpm e2e         # Playwright (specs land in module 16)
cd contracts && forge test
```

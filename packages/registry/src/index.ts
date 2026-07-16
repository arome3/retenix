// @retenix/registry — the single pinned asset truth for Retenix.
//
// One import gives any layer the full, validated, region-filterable asset
// universe: the intent schema enum (doc 09), the worker preflight (doc 08), the
// contract allowlist hashes (doc 07), receipts, and holdings. Anything not in
// REGISTRY does not exist to Retenix.
//
// Importing this package runs the fake-mint guard at module load (see assets.ts).
export * from "./assets";
export * from "./validate";
export * from "./hash";
export * from "./eligible";
export * from "./warm";
export * from "./policy-draft";

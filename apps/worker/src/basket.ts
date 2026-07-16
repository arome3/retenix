// Relocated to @retenix/shared by module 10 — the activation mapping (doc 10)
// derives capPerExec from the largest FINAL leg, so web and worker must share
// one splitter. This re-export keeps every worker import site unchanged.
export { computeLegs, type BasketLeg } from "@retenix/shared";

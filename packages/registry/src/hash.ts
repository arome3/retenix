// Asset-id hashing for the onchain allowlist (TS-6.2). Consumed by the contract
// tests (doc 07) and the worker preflight (doc 08) — they MUST import these,
// never reimplement the preimage.
//
// PROPOSED (spec-silent detail): the `assetListHash` preimage is the sorted ids
// joined with a literal pipe. The spec fixes only "keccak of sorted allowed
// asset ids"; whatever this function does IS the protocol. Change it here and
// every consumer changes with it — that is the point of a single definition.
import { keccak256, toUtf8Bytes } from "ethers";

export const assetIdHash = (id: string) => keccak256(toUtf8Bytes(id)); // per-asset bytes32
export const assetListHash = (ids: string[]) =>
  keccak256(toUtf8Bytes([...ids].sort().join("|"))); // keccak of sorted allowed ids (TS-6.2)

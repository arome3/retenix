import { sha256, toUtf8Bytes } from "ethers";

/*
 * users.email_hash is sha256 of the lowercased email (doc 00 schema, TS-12.2).
 * The raw email is never persisted anywhere in this table — Magic holds it, and
 * doc 14 encrypts the one email Retenix does store, the estate beneficiary.
 *
 * Case folding and trimming happen here so that the hash of an address is stable
 * no matter how the user typed it.
 */
export function hashEmail(email: string): string {
  return sha256(toUtf8Bytes(email.trim().toLowerCase()));
}

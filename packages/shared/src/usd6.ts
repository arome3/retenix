// usd6: integer micro-USD. $15.00 === 15_000_000n
export const USD6 = 1_000_000n;
export const toUsd6 = (usd: number): bigint => BigInt(Math.round(usd * 1e6));
export const fromUsd6 = (v: bigint): number => Number(v) / 1e6;

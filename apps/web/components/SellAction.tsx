"use client";

import { useState } from "react";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";
import { clientEnv } from "@/env";
import { fmtUsd } from "@/lib/format";
import { quoteSellFees, runSell, type SellTarget } from "@/lib/sell-runner";
import { trpc } from "@/lib/trpc";
import { REGISTRY } from "@retenix/registry";
import type { FeeTotalsUSD } from "@retenix/ua";
import type { PortfolioHolding } from "@retenix/shared";

// The flag-gated Sell action (doc 12, PROPOSED — sell-all only). One
// confirmation on module 10's C6; everything after the tap is headless
// (sell-runner). Copy is a decision surface (G12): fees are "fees", the
// confirm button says Confirm, nothing names a network.

export function SellAction({
  holding,
  eoa,
}: {
  holding: PortfolioHolding;
  eoa: string;
}) {
  const [open, setOpen] = useState(false);
  const [fees, setFees] = useState<FeeTotalsUSD | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const asset = REGISTRY.find((a) => a.id === holding.assetId);
  if (
    clientEnv.NEXT_PUBLIC_PORTFOLIO_LIVE !== "1" ||
    !asset ||
    !holding.qtyHuman
  ) {
    return null;
  }
  const target: SellTarget = {
    assetId: asset.id,
    chainId: asset.chainId,
    address: asset.address,
    qtyHuman: holding.qtyHuman,
  };

  const openSheet = () => {
    setOpen(true);
    setDone(false);
    setError(null);
    setFees(undefined);
    // Advisory preview — the confirm-time flow re-quotes fresh (quotes expire).
    void quoteSellFees(eoa, target).then(setFees, () => setFees(undefined));
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = await runSell(eoa, target);
    setBusy(false);
    if (result.kind === "sold") {
      setDone(true);
      void utils.portfolio.holdings.invalidate();
      void utils.portfolio.chart.invalidate();
      void utils.activity.feed.invalidate();
      void utils.account.summary.invalidate();
    } else {
      setError(result.message);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" onClick={openSheet}>
        Sell
      </Button>
      <ConfirmSheet
        open={open}
        onOpenChange={setOpen}
        sentence={`Sell all your ${holding.ticker} — about ${fmtUsd(holding.valueUsd)} back to your buying power?`}
        fees={fees}
        confirmLabel="Confirm"
        onConfirm={() => void confirm()}
        busy={busy}
        done={done}
        error={error}
      >
        {done ? (
          <p className="text-small text-muted-foreground">
            Sold — the proceeds are in your buying power. The receipt is in
            your activity.
          </p>
        ) : null}
      </ConfirmSheet>
    </>
  );
}

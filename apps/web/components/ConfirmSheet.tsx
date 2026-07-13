"use client";

import { useState } from "react";
import type { FeeTotals } from "@retenix/shared";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { fmtUsd } from "@/lib/format";

/*
 * INTERIM ConfirmSheet — a minimal stand-in for C6 (design system §7), which
 * module 10 owns. The CONTRACT below is C6's and must survive the swap:
 *
 *   what happens (one plain sentence) → cost preview (fees: ONE number,
 *   expandable to the split) → simulation summary → the confirm button.
 *
 * Module 10: replace this file with the real C6 keeping these props:
 *   { open, onOpenChange, sentence, fees?, summary?, confirmLabel, onConfirm,
 *     busy?, error?, children? }
 *
 * G12 note: this is a DECISION surface — the expandable split uses the
 * canon-safe labels "Execution / Service / Liquidity", never operational
 * vocabulary. `children` renders below the summary (the sweep flow puts its
 * progress/result region there) — the confirm button hides once `done`.
 */
export interface ConfirmSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What happens, as one plain sentence — the sheet title. */
  sentence: string;
  /** Cost preview; omit when the action is free. */
  fees?: FeeTotals;
  /** Simulation summary — one calm line under the costs. */
  summary?: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Confirm is in flight — the button disables, the sheet stays. */
  busy?: boolean;
  /** The action completed — the confirm affordance goes away. */
  done?: boolean;
  error?: string | null;
  children?: React.ReactNode;
}

export function ConfirmSheet({
  open,
  onOpenChange,
  sentence,
  fees,
  summary,
  confirmLabel,
  onConfirm,
  busy,
  done,
  error,
  children,
}: ConfirmSheetProps) {
  const [splitOpen, setSplitOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <SheetContent className="overflow-y-auto" showCloseButton={!busy}>
        <SheetHeader className="pb-0">
          <SheetTitle className="text-h2">{sentence}</SheetTitle>
          {summary && <SheetDescription>{summary}</SheetDescription>}
        </SheetHeader>

        <div className="flex flex-col gap-3 px-4">
          {fees && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-small text-muted-foreground"
                aria-expanded={splitOpen}
                onClick={() => setSplitOpen((v) => !v)}
              >
                fees <span className="tnum">~{fmtUsd(fees.total)}</span>
                <span aria-hidden="true" className="text-caption">
                  {splitOpen ? "▴" : "▾"}
                </span>
              </button>
              {splitOpen && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 text-caption text-muted-foreground">
                  <dt>Execution</dt>
                  <dd className="tnum text-right">{fmtUsd(fees.gas)}</dd>
                  <dt>Service</dt>
                  <dd className="tnum text-right">{fmtUsd(fees.service)}</dd>
                  <dt>Liquidity</dt>
                  <dd className="tnum text-right">{fmtUsd(fees.lp)}</dd>
                </dl>
              )}
            </div>
          )}

          {children}

          {error && <p className="text-small text-negative">{error}</p>}
        </div>

        <SheetFooter>
          {!done && (
            <Button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              aria-busy={busy || undefined}
            >
              {busy ? "Working…" : confirmLabel}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { truncAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
 * The address, truncated for reading and copied in full (doc 01 §formatting).
 * Geist Mono, because an address is data. Shown in settings and receipts only —
 * never in a decision surface.
 */
export function CopyChip({
  address,
  className,
}: {
  address: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      return; // Clipboard denied; the truncated address stays readable regardless.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="font-mono text-body text-foreground tnum">
        {truncAddr(address)}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy your full address"
        className="inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-micro hover:text-foreground"
      >
        {copied ? (
          <Check className="size-4" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Copy className="size-4" strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}

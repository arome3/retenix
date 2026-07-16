"use client";

import { useState } from "react";
import {
  blockedReceipt,
  brokerHiredReceipt,
  executedReceipt,
  refundedReceipt,
  sweepReceiptHeadline,
  type FeedItem,
} from "@retenix/shared";
import { useMounted } from "@/hooks/use-mounted";
import { useNowMinute } from "@/hooks/use-now-minute";
import {
  BrokerAvatar,
  ContinuityAvatar,
  GuardianAvatar,
} from "@/components/avatars";
import { ReceiptRow } from "@/components/ReceiptRow";
import { HeroMoney } from "@/components/HeroMoney";
import { IosInstallTeach } from "@/components/IosInstallTeach";
import { Num } from "@/components/Num";
import { BalanceSkeleton, FeedSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCountUp } from "@/hooks/use-count-up";
import {
  absTime,
  fmtDelta,
  fmtPct,
  fmtUsd,
  relTime,
  truncAddr,
} from "@/lib/format";
import { setCvd, setThemeMode, useThemePrefs } from "@/lib/theme";
import { cn } from "@/lib/utils";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-h1">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("h-14 rounded-md border border-border", className)} />
      <span className="font-mono text-caption text-muted-foreground">
        {name}
      </span>
    </div>
  );
}

const PRIMITIVES: { name: string; dark?: string; light?: string }[] = [
  { name: "graphite-950", dark: "oklch(0.16 0.008 250)" },
  { name: "graphite-900", dark: "oklch(0.20 0.008 250)" },
  { name: "graphite-800", dark: "oklch(0.25 0.008 250)" },
  { name: "paper-50", light: "oklch(0.985 0.003 90)" },
  { name: "paper-100", light: "oklch(0.955 0.004 90)" },
  { name: "ink-100 / 900", dark: "oklch(0.93 0.005 250)", light: "oklch(0.22 0.01 250)" },
  { name: "teal-500", dark: "oklch(0.78 0.11 195)", light: "oklch(0.50 0.10 195)" },
  { name: "gain-500", dark: "oklch(0.72 0.17 152)", light: "oklch(0.55 0.15 152)" },
  { name: "loss-500", dark: "oklch(0.66 0.19 25)", light: "oklch(0.55 0.19 25)" },
  { name: "amber-500", dark: "oklch(0.80 0.14 85)", light: "oklch(0.66 0.13 80)" },
  { name: "crimson-600", dark: "oklch(0.55 0.20 25)", light: "oklch(0.50 0.20 25)" },
];

function CountUpDemo() {
  const [run, setRun] = useState(0);
  return (
    <div className="flex flex-col items-start gap-3">
      {/* no sessionKey → replays per mount; the key remounts it on demand */}
      <CountUpValue key={run} />
      <Button variant="secondary" size="sm" onClick={() => setRun((n) => n + 1)}>
        Replay count-up
      </Button>
      <p className="text-caption text-muted-foreground">
        400ms, once per session load in product use (sessionKey) — final value
        renders instantly under reduced motion.
      </p>
    </div>
  );
}

function CountUpValue() {
  const value = useCountUp(4812.07, { duration: 400 });
  return <HeroMoney value={value} aria-label="Count-up demo" />;
}

const DEMO_ADDR = "0x1234abcd5678ef901234abcd5678ef9012345678";

function TimeSamples({ now }: { now: Date }) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  return (
    <>
      <div className="flex flex-col gap-1 text-small">
        <span>{relTime(ago(30_000), now)} · under a minute</span>
        <span>{relTime(ago(3 * 3_600_000), now)} · earlier today</span>
        <span>{relTime(ago(30 * 3_600_000), now)} · yesterday</span>
        <span>{relTime(ago(12 * 86_400_000), now)} · twelve days</span>
        <span>{relTime(ago(45 * 86_400_000), now)} · past thirty days</span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">
            Hover a timestamp — tooltips are always absolute
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <Num>{absTime(ago(12 * 86_400_000))}</Num>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

export function TokenSheet() {
  const prefs = useThemePrefs();
  // time samples render only after mount — `new Date()` during SSR would
  // hydrate against a different clock and mismatch
  const mounted = useMounted();
  const now = mounted ? new Date() : null;

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-12 px-4 py-10 md:px-6">
        <header className="flex flex-col gap-6">
          <div>
            <p className="text-caption tracking-wide text-muted-foreground uppercase">
              Retenix · design foundation · dev only
            </p>
            <h1 className="mt-1 font-display text-display">Token sheet</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={prefs.mode === "light" ? "default" : "secondary"}
              size="sm"
              aria-pressed={prefs.mode === "light"}
              onClick={() => setThemeMode("light")}
            >
              Light
            </Button>
            <Button
              variant={prefs.mode === "dark" ? "default" : "secondary"}
              size="sm"
              aria-pressed={prefs.mode === "dark"}
              onClick={() => setThemeMode("dark")}
            >
              Dark
            </Button>
            <Button
              variant={prefs.cvd ? "default" : "secondary"}
              size="sm"
              aria-pressed={prefs.cvd}
              onClick={() => setCvd(!prefs.cvd)}
            >
              Accessible colors {prefs.cvd ? "on" : "off"}
            </Button>
          </div>
        </header>

        <Section title="Semantic tokens (live)">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            <Swatch name="background" className="bg-background" />
            <Swatch name="card" className="bg-card" />
            <Swatch name="muted" className="bg-muted" />
            <Swatch name="primary / agent" className="bg-primary" />
            <Swatch name="positive" className="bg-positive" />
            <Swatch name="negative" className="bg-negative" />
            <Swatch name="warning" className="bg-warning" />
            <Swatch name="destructive" className="bg-destructive" />
            <Swatch name="border" className="bg-border" />
          </div>
          <p className="text-small text-muted-foreground">
            Positive/negative swap to blue/orange with Accessible colors —
            independent of light/dark, and never the sole encoder: every delta
            carries its sign and glyph.
          </p>
        </Section>

        <Section title="Primitives (§2.1, fixed values)">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {PRIMITIVES.map((p) => (
              <div key={p.name} className="flex flex-col gap-1.5">
                <div className="flex h-14 overflow-hidden rounded-md border border-border">
                  {p.dark && (
                    <div
                      className="flex-1"
                      style={{ backgroundColor: p.dark }}
                    />
                  )}
                  {p.light && (
                    <div
                      className="flex-1"
                      style={{ backgroundColor: p.light }}
                    />
                  )}
                </div>
                <span className="font-mono text-caption text-muted-foreground">
                  {p.name}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type scale">
          <div className="flex flex-col gap-3">
            <p className="font-display text-display-xl">Display XL 3.0</p>
            <p className="font-display text-display">Display 2.25</p>
            <p className="text-h1 font-medium">Heading 1 · 1.5</p>
            <p className="text-h2 font-medium">Heading 2 · 1.25</p>
            <p className="text-body">
              Body 1.0 — line-height 1.6. Geist carries the interface; weights
              400/500/600 only, hierarchy prefers size and space.
            </p>
            <p className="text-small">Small 0.875 — row copy and descriptions.</p>
            <p className="text-caption text-muted-foreground">
              Caption 0.75 — timestamps, labels.
            </p>
            <p className="font-mono text-small">
              Geist Mono — {truncAddr(DEMO_ADDR)}
            </p>
          </div>
        </Section>

        <Section title="The money moment">
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-soft">
            <p className="text-caption text-muted-foreground">Buying power</p>
            <CountUpDemo />
          </div>
          <div className="flex flex-col gap-1.5">
            <Num className="text-body text-positive">{fmtDelta(12.4, 2.15)}</Num>
            <Num className="text-body text-negative">{fmtDelta(-3.2, -0.85)}</Num>
            <p className="text-caption text-muted-foreground">
              Delta colors are for financial deltas only — success is a teal
              check, warnings amber, destructive crimson (G14). Light-theme
              gain text at caption sizes takes the ink fallback (DS-10.2).
            </p>
          </div>
          <div className="w-fit rounded-md border border-border">
            {[
              [212.4, 2.15],
              [1_240_000, 12.5],
              [0, 0],
              [-99_999.99, -3.4],
            ].map(([v, p], i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-8 border-b border-border px-3 py-1.5 leading-data last:border-b-0"
              >
                <Num className="text-small">{fmtUsd(v)}</Num>
                <Num className="text-small text-muted-foreground">
                  {fmtPct(p)}
                </Num>
              </div>
            ))}
          </div>
          <p className="text-caption text-muted-foreground">
            Every mutable number sits in a tabular column via .tnum — right
            edges align as values change.
          </p>
        </Section>

        <Section title="Time">
          {now === null ? (
            <div className="h-32" aria-hidden="true" />
          ) : (
            <TimeSamples now={now} />
          )}
        </Section>

        <Section title="Radius & elevation">
          <div className="flex flex-wrap items-end gap-3">
            {(
              [
                ["sm", "rounded-sm"],
                ["md · inputs", "rounded-md"],
                ["lg · cards", "rounded-lg"],
                ["xl · sheets", "rounded-xl"],
                ["full · pills", "rounded-full"],
              ] as const
            ).map(([label, cls]) => (
              <div key={cls} className="flex flex-col items-center gap-1.5">
                <div className={cn("size-16 border border-border bg-muted", cls)} />
                <span className="text-caption text-muted-foreground">
                  {label}
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex h-20 items-end rounded-lg bg-background p-2 outline outline-border">
              <span className="text-caption text-muted-foreground">
                surface 950
              </span>
            </div>
            <div className="flex h-20 items-end rounded-lg bg-card p-2">
              <span className="text-caption text-muted-foreground">
                card 900
              </span>
            </div>
            <div className="flex h-20 items-end rounded-lg bg-muted p-2">
              <span className="text-caption text-muted-foreground">
                raised 800
              </span>
            </div>
          </div>
          <p className="text-caption text-muted-foreground">
            Dark elevates by surface-lightness step; light uses at most two
            soft shadows. No glass, no glow.
          </p>
        </Section>

        <Section title="Components">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Confirm</Button>
            <Button variant="secondary">Edit</Button>
            <Button variant="outline">Pause</Button>
            <Button variant="ghost">Dismiss</Button>
            <Button variant="destructive">Revoke</Button>
            <Button variant="link">How it works</Button>
          </div>
          <div className="flex max-w-sm flex-col gap-3">
            <Input placeholder="you@example.com" aria-label="Email" />
            <div className="flex items-center gap-2">
              <Checkbox id="ack" />
              <label htmlFor="ack" className="text-small">
                I understand the risks
              </label>
            </div>
            <Select>
              <SelectTrigger aria-label="Country">
                <SelectValue placeholder="Country" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="de">Germany</SelectItem>
                <SelectItem value="fr">France</SelectItem>
                <SelectItem value="ng">Nigeria</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Tabs defaultValue="all">
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="trades">Trades</TabsTrigger>
              <TabsTrigger value="blocked">Blocked</TabsTrigger>
            </TabsList>
            <TabsContent value="all" className="pt-2 text-small text-muted-foreground">
              The live feed chips are on /activity (module 11).
            </TabsContent>
            <TabsContent value="trades" className="pt-2 text-small text-muted-foreground">
              Trades only.
            </TabsContent>
            <TabsContent value="blocked" className="pt-2 text-small text-muted-foreground">
              Blocked receipts render proudly.
            </TabsContent>
          </Tabs>
          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>A quiet decision</DialogTitle>
                  <DialogDescription>
                    Card surface, radius lg, 220ms in / 180ms out — a fade
                    under reduced motion.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter showCloseButton />
              </DialogContent>
            </Dialog>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open bottom sheet</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Bottom sheet</SheetTitle>
                  <SheetDescription>
                    Top radius xl, 85dvh cap, safe-area padding, and a
                    visualViewport clamp for the keyboard.
                  </SheetDescription>
                </SheetHeader>
                <div className="px-4 pb-4">
                  <Input placeholder="Focus me with the keyboard open" aria-label="Sheet demo input" />
                </div>
                <SheetFooter>
                  <Button>Confirm</Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
          </div>
        </Section>

        <Section title="Skeletons">
          <div className="flex flex-col gap-6">
            <BalanceSkeleton />
            <FeedSkeleton />
          </div>
        </Section>

        <Section title="Receipts (C4)">
          <p className="text-small text-muted-foreground">
            All five presentations (doc 11): executed · blocked (proud amber
            shield, never loss red) · failed-refunded · system · aggregate
            legs. Expand any row for the forensics.
          </p>
          <DemoReceipts />
        </Section>

        <Section title="The staff">
          <div className="flex items-center gap-6">
            {(
              [
                [BrokerAvatar, "Broker"],
                [GuardianAvatar, "Guardian"],
                [ContinuityAvatar, "Continuity"],
              ] as const
            ).map(([Avatar, name]) => (
              <div key={name} className="flex flex-col items-center gap-2">
                <Avatar size={40} />
                <span className="text-caption text-muted-foreground">
                  {name}
                </span>
              </div>
            ))}
          </div>
          <p className="text-caption text-muted-foreground">
            Teal on graphite in every theme — the staff is the brand. Compass,
            shield, infinity-knot; no mascots.
          </p>
        </Section>

        <Section title="Install teach (forced preview)">
          <IosInstallTeach force />
        </Section>

        <footer className="pb-8 text-caption text-muted-foreground">
          Dev-only route — 404s in production. Screenshot this sheet in
          light/dark, with and without Accessible colors.
        </footer>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// C4 fixtures (module 11) — the five receipt presentations, from the CANONICAL
// template builders (never hand-written sentences), expandable in place.
// ---------------------------------------------------------------------------

const DEMO_FEES = { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 };
const DEMO_SWEEP_FEES = { gas: 0.01, service: 0.02, lp: 0, total: 0.03 };

function demoReceiptItems(nowMs: number): FeedItem[] {
  const at = (minsAgo: number) => new Date(nowMs - minsAgo * 60_000).toISOString();
  return [
    {
      id: "demo-executed",
      at: at(2),
      variant: "executed",
      agent: "broker",
      sentence: executedReceipt({
        usd: 15,
        ticker: "SPYx",
        sources: ["Base", "Arbitrum"],
        fees: DEMO_FEES,
      }),
      detail: {
        fees: DEMO_FEES,
        sources: ["Base", "Arbitrum"],
        uaTxId: "demo1234567890abcdef",
        planId: "demo-plan",
      },
    },
    {
      id: "demo-blocked",
      at: at(9),
      variant: "blocked",
      agent: "broker",
      sentence: blockedReceipt("OverPeriodCap", "$50 weekly cap"),
      detail: { planId: "demo-plan" },
    },
    {
      id: "demo-refunded",
      at: at(26),
      variant: "failed-refunded",
      agent: "broker",
      sentence: refundedReceipt(15),
      detail: { planId: "demo-plan" },
    },
    {
      id: "demo-system",
      at: at(65),
      variant: "system",
      agent: "broker",
      sentence: brokerHiredReceipt({
        amountUsd: 25,
        cadence: "weekly",
        tickers: ["SPYx", "TSLAx", "SOL"],
      }),
      detail: { planId: "demo-plan" },
    },
    {
      id: "demo-sweep",
      at: at(80),
      variant: "system",
      agent: null,
      sentence: sweepReceiptHeadline(23.11, 5),
      detail: {
        fees: DEMO_SWEEP_FEES,
        legs: [
          {
            network: "Base", // copy-canon-allow — receipt fixture names networks
            symbol: "DEGEN",
            usd: 0.61,
            outcome: "finished",
            fees: DEMO_SWEEP_FEES,
            feeSource: "settled" as const,
            uaTxId: "demo1234567890abcdef",
          },
          {
            network: "BSC", // copy-canon-allow — receipt fixture names networks
            symbol: "CAKE",
            usd: 0.42,
            outcome: "refunded",
            feeSource: "none" as const,
          },
        ],
      },
    },
  ];
}

function DemoReceipts() {
  const nowMs = useNowMinute();
  const [expandedId, setExpandedId] = useState<string | null>("demo-executed");
  return (
    <ul className="m-0 list-none p-0">
      {demoReceiptItems(nowMs).map((item) => (
        <li key={item.id}>
          <ReceiptRow
            item={item}
            nowMs={nowMs}
            expanded={expandedId === item.id}
            onToggle={() =>
              setExpandedId((c) => (c === item.id ? null : item.id))
            }
            policyQuote={item.detail?.planId ? "$25.00 every week" : undefined}
            onOpenPolicy={item.detail?.planId ? () => {} : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

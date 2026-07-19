"use client";

// Home header overflow (doc 15, PROPOSED entry point for send/withdraw —
// flagged for W4 product sign-off). ONE focusable trigger in the header (the
// a11y-shell tab budget is tight); the items join the tab order only while
// the popover is open.
import { Ellipsis } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function HomeMenu() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="More"
        className="inline-flex size-11 items-center justify-center rounded-lg border border-border text-muted-foreground transition-micro hover:text-foreground"
      >
        <Ellipsis className="size-5" strokeWidth={1.5} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-44 flex-col p-1">
        <Link
          href="/send"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2.5 text-body text-foreground transition-micro hover:bg-muted"
        >
          Send
        </Link>
        <Link
          href="/send/withdraw"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2.5 text-body text-foreground transition-micro hover:bg-muted"
        >
          Withdraw
        </Link>
      </PopoverContent>
    </Popover>
  );
}

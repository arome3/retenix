"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleUser, House, ScrollText, Users } from "lucide-react";
import { cn } from "@/lib/utils";

// Bottom tab bar (§App shell): thumb zone, 24px Lucide icons at 1.5px stroke,
// labels, ≥24px targets (rows are 56px), safe-area padded. The kill switch
// lives in the Home header (doc 13) — never in here. Active state is
// foreground + weight, not teal: navigation is neither the agent acting nor
// the user commanding (accent discipline, §2.1).
const TABS = [
  { href: "/home", label: "Home", icon: House },
  { href: "/activity", label: "Activity", icon: ScrollText },
  { href: "/agents", label: "Agents", icon: Users },
  { href: "/profile", label: "Profile", icon: CircleUser },
] as const;

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-safe"
    >
      <div className="mx-auto grid w-full max-w-[480px] grid-cols-4">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 text-caption transition-micro",
                active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon size={24} strokeWidth={1.5} aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

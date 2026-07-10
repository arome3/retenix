import { cn } from "@/lib/utils";

/*
 * C2 SourcePill — display shell (DS §7): "funded from 4 sources", rounded-full,
 * muted; count = networks with USD > 0. Never renders in decision flows.
 *
 * TODO(doc 06): tapping expands the breakdown sheet — the only place networks
 * are ever named. Until the sheet exists this is a static chip, not a dead
 * button.
 */
export function SourcePill({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count < 1) return null;
  return (
    <span
      className={cn(
        "w-fit rounded-full bg-muted px-3 py-1 text-caption text-muted-foreground",
        className,
      )}
    >
      funded from <span className="tnum">{count}</span>{" "}
      {count === 1 ? "source" : "sources"}
    </span>
  );
}

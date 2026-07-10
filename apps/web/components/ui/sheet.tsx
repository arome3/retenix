"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Restyled per doc 01: the bottom sheet is the app's confirm surface (C6
// consumes it in doc 10) — side="bottom" is the default, top radius `xl`,
// dvh-sized (100vh lies on iOS), safe-area padded, visualViewport-clamped so
// the sheet still fits with the keyboard open. Motion: 300ms in / 240ms out
// (exits ~20% faster); under prefers-reduced-motion the data-rm-fade hook in
// globals.css swaps movement for a ≤150ms opacity fade.

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      data-rm-fade
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
        className
      )}
      {...props}
    />
  )
}

/** Clamps a bottom sheet under the visual viewport — dvh ignores the iOS
 *  keyboard, visualViewport does not. */
function useVisualViewportClamp(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean
) {
  React.useEffect(() => {
    if (!enabled) return
    const vv = window.visualViewport
    if (!vv) return
    const el = ref.current
    if (!el) return
    const clamp = () => {
      // only intervene when the visual viewport is meaningfully smaller than
      // the layout viewport (keyboard open); otherwise let dvh rule
      const shrunk = vv.height < window.innerHeight - 1
      el.style.maxHeight = shrunk ? `${Math.round(vv.height * 0.92)}px` : ""
    }
    clamp()
    vv.addEventListener("resize", clamp)
    vv.addEventListener("scroll", clamp)
    return () => {
      vv.removeEventListener("resize", clamp)
      vv.removeEventListener("scroll", clamp)
    }
  }, [ref, enabled])
}

function SheetContent({
  className,
  children,
  side = "bottom",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  useVisualViewportClamp(contentRef, side === "bottom")

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={contentRef}
        data-slot="sheet-content"
        data-rm-fade
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-card text-card-foreground outline-none",
          side === "bottom" &&
            "inset-x-0 bottom-0 mx-auto h-auto max-h-[85dvh] w-full max-w-[480px] rounded-t-xl border-t pb-safe data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out",
          side === "top" &&
            "inset-x-0 top-0 h-auto rounded-b-xl border-b data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
          side === "right" &&
            "inset-y-0 right-0 h-full w-3/4 border-l data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out sm:max-w-sm",
          side === "left" &&
            "inset-y-0 left-0 h-full w-3/4 border-r data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out sm:max-w-sm",
          className
        )}
        {...props}
      >
        {side === "bottom" && (
          <div
            aria-hidden="true"
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border"
          />
        )}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="absolute top-4 right-4 flex size-6 items-center justify-center rounded-sm opacity-70 transition-micro hover:opacity-100 disabled:pointer-events-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-display text-h1 text-foreground", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-small text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}

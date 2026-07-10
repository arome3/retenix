// First focusable element on shell/flow layouts — keyboard and screen-reader
// users jump straight past the chrome to #main (WCAG 2.4.1).
export function SkipToContent({ targetId = "main" }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-4 focus-visible:left-1/2 focus-visible:z-50 focus-visible:-translate-x-1/2 focus-visible:rounded-md focus-visible:bg-card focus-visible:px-4 focus-visible:py-2 focus-visible:text-small focus-visible:text-foreground focus-visible:shadow-soft"
    >
      Skip to content
    </a>
  );
}

// The staff avatar family (DS-5.3): minimal geometric marks in teal on
// graphite, identical in every theme — the disc is the brand's coin, not a
// surface, so it never flips with light/dark. Consistent across policy
// cards, receipts, and settings. No mascots, no 3D coins, no rocket ships.

// Brand constants (not theme vars — deliberately fixed):
export const AVATAR_DISC = "oklch(0.20 0.008 250)"; // graphite-900
export const AVATAR_RIM = "oklch(0.25 0.008 250)"; // graphite-800
export const AVATAR_MARK = "oklch(0.78 0.11 195)"; // teal-500 — 9.4:1 on the disc

export type AgentAvatarProps = Omit<
  React.SVGProps<SVGSVGElement>,
  "width" | "height" | "children"
> & {
  /** Rendered square size in px — 32 in receipt rows, 40 on policy cards. */
  size?: number;
};

export function AvatarBase({
  label,
  size = 32,
  children,
  ...props
}: AgentAvatarProps & { label: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      {...props}
    >
      <circle cx="20" cy="20" r="19.5" fill={AVATAR_DISC} />
      <circle
        cx="20"
        cy="20"
        r="18.75"
        fill="none"
        stroke={AVATAR_RIM}
        strokeWidth="1"
      />
      <g
        stroke={AVATAR_MARK}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </g>
    </svg>
  );
}

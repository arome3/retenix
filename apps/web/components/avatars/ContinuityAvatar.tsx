import { AvatarBase, type AgentAvatarProps } from "./AvatarBase";

/** Continuity — the infinity knot: what you built keeps going. */
export function ContinuityAvatar({
  label = "Continuity agent",
  ...props
}: AgentAvatarProps & { label?: string }) {
  return (
    <AvatarBase label={label} {...props}>
      <path d="M20 20 C17.2 15.9 11.4 16.3 11.4 20 C11.4 23.7 17.2 24.1 20 20 C22.8 15.9 28.6 16.3 28.6 20 C28.6 23.7 22.8 24.1 20 20 Z" />
    </AvatarBase>
  );
}

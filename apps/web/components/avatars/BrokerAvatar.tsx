import { AvatarBase, AVATAR_MARK, type AgentAvatarProps } from "./AvatarBase";

/** Broker — the compass: heading, not hype. Ring, NE–SW needle, center pivot. */
export function BrokerAvatar({
  label = "Broker agent",
  ...props
}: AgentAvatarProps & { label?: string }) {
  return (
    <AvatarBase label={label} {...props}>
      <circle cx="20" cy="20" r="9" />
      <path d="M25.6 14.4 L21.5 21.5 L14.4 25.6 L18.5 18.5 Z" />
      <circle cx="20" cy="20" r="0.9" fill={AVATAR_MARK} stroke="none" />
    </AvatarBase>
  );
}

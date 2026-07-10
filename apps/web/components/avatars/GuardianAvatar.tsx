import { AvatarBase, type AgentAvatarProps } from "./AvatarBase";

/** Guardian — the shield: caps and blocks, worn proudly. Heraldic keel line. */
export function GuardianAvatar({
  label = "Guardian agent",
  ...props
}: AgentAvatarProps & { label?: string }) {
  return (
    <AvatarBase label={label} {...props}>
      <path d="M20 11 L26.5 13.4 V19.6 C26.5 24.2 23.9 27.4 20 29 C16.1 27.4 13.5 24.2 13.5 19.6 V13.4 Z" />
      <path d="M20 14.8 V25.2" />
    </AvatarBase>
  );
}

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/routers";

// Typed client — end-to-end route types flow from AppRouter. Module 02 mounts
// the provider when the first authed screens land.
export const trpc = createTRPCReact<AppRouter>();

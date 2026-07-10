import { redirect } from "next/navigation";

// S0 (marketing) has no module yet, so the root is not a place to be: a blank
// page here read as a broken app. Signed-out visitors go to the entry surface;
// proxy.ts already sends anyone with a session to /home before this renders.
export default function Page() {
  redirect("/welcome");
}

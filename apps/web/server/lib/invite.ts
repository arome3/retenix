// Send-invite email (doc 15 unregistered-email path) — module 14's Resend
// posture verbatim (worker estate-support.ts): plain fetch, no SDK, both env
// values optional; absent → the invite is logged LOUDLY and the flow
// proceeds. No funds ever move on this path by design — an escrow rail would
// be a new security review, not a patch (doc 15 Security & failure modes).
import { env } from "@/env";

export interface InviteEmail {
  to: string;
  /** Where the invite lands them (APP_BASE_URL — the onboarding door). */
  link: string;
}

export async function sendInviteEmail(mail: InviteEmail): Promise<{ sent: boolean }> {
  // G12-clean copy: plain language, one action, no crypto vocabulary.
  const subject = "Someone tried to send you money on Retenix";
  const html = [
    `<p>Someone tried to send you money on Retenix, but there's no account for this email yet.</p>`,
    `<p>Nothing was sent — money only moves once you have an account.</p>`,
    `<p><a href="${mail.link}">Set up your account</a> and ask them to try again.</p>`,
    `<p>If you weren't expecting this, you can ignore it.</p>`,
  ].join("\n");

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    console.warn(
      `[send] NO EMAIL PROVIDER — invite for ${mail.to} not emailed (link: ${mail.link})`,
    );
    return { sent: false };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[send] invite email failed (${res.status}) for ${mail.to}`);
      return { sent: false };
    }
    return { sent: true };
  } catch {
    console.warn(`[send] invite email errored for ${mail.to}`);
    return { sent: false };
  }
}

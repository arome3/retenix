import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GATE_COOKIE, SESSION_COOKIE } from "@/lib/cookies";
import { proxy } from "./proxy";

type Cookies = "none" | "session" | "session+region";

function go(pathname: string, cookies: Cookies) {
  const header =
    cookies === "none"
      ? ""
      : cookies === "session"
        ? `${SESSION_COOKIE}=token`
        : `${SESSION_COOKIE}=token; ${GATE_COOKIE}=1`;
  const request = new NextRequest(new URL(pathname, "http://localhost:3000"), {
    headers: header ? { cookie: header } : {},
  });
  const response = proxy(request);
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null; // null = allowed through
}

const APP_ROUTES = ["/home", "/activity", "/agents", "/profile", "/kill", "/legacy"];

describe("proxy — no session", () => {
  it("lets the entry surfaces through", () => {
    for (const path of ["/", "/welcome", "/otp"]) {
      expect(go(path, "none")).toBeNull();
    }
  });

  it("sends every authed route to welcome", () => {
    for (const path of [...APP_ROUTES, "/ready", "/profile/export"]) {
      expect(go(path, "none")).toBe("/welcome");
    }
  });

  it("never gates the api, the claim link, help, or dev surfaces", () => {
    for (const path of ["/api/trpc/auth.magicCallback", "/claim/abc", "/help", "/dev/tokens"]) {
      expect(go(path, "none")).toBeNull();
    }
  });
});

describe("proxy — session without a region (PS-F1-AC4, doc 02 half)", () => {
  it("reaches only the gate", () => {
    expect(go("/eligibility", "session")).toBeNull();
  });

  it("is redirected to the gate from every other route", () => {
    for (const path of [...APP_ROUTES, "/", "/welcome", "/otp", "/ready", "/profile/export"]) {
      expect(go(path, "session")).toBe("/eligibility");
    }
  });
});

describe("proxy — session with a region", () => {
  it("opens the app shell and the ready screen", () => {
    for (const path of [...APP_ROUTES, "/ready"]) {
      expect(go(path, "session+region")).toBeNull();
    }
  });

  it("sends a finished user off the onboarding screens", () => {
    for (const path of ["/", "/welcome", "/otp", "/eligibility"]) {
      expect(go(path, "session+region")).toBe("/home");
    }
  });
});

describe("proxy — cookie hygiene", () => {
  it("treats an emptied cookie as absent, so logout takes effect immediately", () => {
    const request = new NextRequest(new URL("/home", "http://localhost:3000"), {
      headers: { cookie: `${SESSION_COOKIE}=; ${GATE_COOKIE}=` },
    });
    expect(new URL(proxy(request).headers.get("location")!).pathname).toBe("/welcome");
  });
});

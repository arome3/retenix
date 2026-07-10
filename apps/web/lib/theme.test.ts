import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { routeDefaults } from "./theme";

/*
 * Doc 01 leaves module 02 an explicit instruction: onboarding routes must be
 * added to BOTH routeDefaults and the pre-paint init script in app/layout.tsx.
 * Two copies of one rule drift, so assert they agree rather than trusting a note.
 */
const layoutSource = readFileSync(
  fileURLToPath(new URL("../app/layout.tsx", import.meta.url)),
  "utf8",
);

/** Re-runs the browser's pre-paint decision against a pathname. */
function initScriptSaysLight(pathname: string): boolean {
  const match = layoutSource.match(
    /var lightDefault = forcedLight \|\| p === "\/" \|\| (\/\^.+?\/)\.test\(p\);/,
  );
  if (!match) throw new Error("pre-paint theme regex not found in app/layout.tsx");
  // The script lives in a template literal, so its backslashes are escaped twice.
  const source = match[1].slice(1, -1).replaceAll("\\\\", "\\");
  const forcedLight = pathname === "/claim" || pathname.startsWith("/claim/");
  return forcedLight || pathname === "/" || new RegExp(source).test(pathname);
}

const ONBOARDING = ["/welcome", "/otp", "/eligibility", "/ready"];
const APP = ["/home", "/activity", "/agents", "/profile", "/profile/export"];

describe("theme route defaults", () => {
  it("renders every S1 screen light, /ready included", () => {
    for (const path of ONBOARDING) {
      expect(routeDefaults(path).defaultMode).toBe("light");
    }
  });

  it("keeps the authed shell dark", () => {
    for (const path of APP) {
      expect(routeDefaults(path).defaultMode).toBe("dark");
    }
  });

  it("agrees with the pre-paint init script on every route", () => {
    for (const path of [...ONBOARDING, ...APP, "/", "/claim/abc", "/help"]) {
      expect({ path, light: routeDefaults(path).defaultMode === "light" }).toEqual({
        path,
        light: initScriptSaysLight(path),
      });
    }
  });

  it("still forces light on the heir claim route (doc 14)", () => {
    expect(routeDefaults("/claim/abc").forcedLight).toBe(true);
  });
});

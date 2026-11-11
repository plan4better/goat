import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { SETTINGS_ROUTES, settingsTeamPath, settingsUsagePath } from "@/lib/settingsRoutes";

describe("settings routes", () => {
  it("names one flat path per page", () => {
    expect(SETTINGS_ROUTES).toEqual({
      profile: "/settings/profile",
      preferences: "/settings/preferences",
      organization: "/settings/organization",
      members: "/settings/members",
      teams: "/settings/teams",
      domains: "/settings/domains",
      analytics: "/settings/analytics",
      ai: "/settings/ai",
      usage: "/settings/usage",
    });
  });

  it("builds a team's path, escaping what is not a path segment", () => {
    expect(settingsTeamPath("6f0a2c3e-1b4d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(
      "/settings/teams/6f0a2c3e-1b4d-4e5f-8a9b-0c1d2e3f4a5b"
    );
    expect(settingsTeamPath("a/b")).toBe("/settings/teams/a%2Fb");
  });

  it("opens the usage page on a tile", () => {
    expect(settingsUsagePath()).toBe("/settings/usage");
    expect(settingsUsagePath("ai")).toBe("/settings/usage?quota=ai");
    expect(settingsUsagePath("editors")).toBe("/settings/usage?quota=editors");
  });
});

const WEB = path.resolve(__dirname, "..", "..");
const SETTINGS_APP = path.join(WEB, "app", "(dashboard)", "settings");
const ROUTES_FILE = path.join(WEB, "lib", "settingsRoutes.ts");

/** Every file under `dir` whose name passes `keep`, skipping dependencies, hidden folders and tests. */
const filesUnder = (dir: string, keep: (name: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full, keep);
    return keep(name) ? [full] : [];
  });

describe("settings routes in the app", () => {
  it("has a page for every path, and none for /settings itself", () => {
    for (const route of Object.values(SETTINGS_ROUTES)) {
      const folder = route.replace(/^\/settings\//, "");
      expect(existsSync(path.join(SETTINGS_APP, folder, "page.tsx")), route).toBe(true);
    }
    expect(existsSync(path.join(SETTINGS_APP, "teams", "[teamId]", "page.tsx"))).toBe(true);
    expect(existsSync(path.join(SETTINGS_APP, "page.tsx"))).toBe(false);
  });

  it("is the only module that spells a settings path", () => {
    const offenders = ["app", "components", "hooks", "lib"]
      .flatMap((dir) =>
        filesUnder(path.join(WEB, dir), (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      )
      .filter((file) => file !== ROUTES_FILE && /["'`]\/settings\//.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(WEB, file));
    expect(offenders).toEqual([]);
  });

  it("redirects in no settings page: only next.config.js sends /settings on", () => {
    const pages = filesUnder(SETTINGS_APP, (name) => name === "page.tsx");
    expect(pages.length).toBeGreaterThanOrEqual(Object.keys(SETTINGS_ROUTES).length);
    const redirecting = pages
      .filter((file) => /\b(?:redirect|permanentRedirect)\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(WEB, file));
    expect(redirecting).toEqual([]);
  });
});

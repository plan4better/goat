// @vitest-environment node
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import { config } from "@/proxy";

const PREFETCH = { "next-router-prefetch": "1" };
const runs = (url: string, headers: Record<string, string> = {}) =>
  unstable_doesMiddlewareMatch({ config, url, headers });

describe("proxy matcher", () => {
  it("skips the proxy (and its organization lookup) for a prefetch of a settings page", () => {
    expect(runs("/settings/members", PREFETCH)).toBe(false);
    expect(runs("/settings/teams/abc", PREFETCH)).toBe(false);
  });

  it("runs it for the click's own request of a settings page", () => {
    expect(runs("/settings/members")).toBe(true);
  });

  it("runs it for everything else, prefetched or not", () => {
    for (const url of ["/home", "/content", "/map/public/abc", "/settingsfoo", "/"]) {
      expect(runs(url, PREFETCH), url).toBe(true);
      expect(runs(url), url).toBe(true);
    }
  });
});

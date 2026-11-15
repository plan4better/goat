// @vitest-environment node
import type { NextConfig } from "next";
import { getRedirectUrl, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import config from "@/next.config.js";

// next.config.js exports what @next/bundle-analyzer returns, typed with the
// `next` the pnpm store hoists (storybook's older major), not this app's.
const nextConfig = config as NextConfig;

describe("next.config redirects", () => {
  it("sends a typed /settings to the profile page with a 307, before any rendering", async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: "https://goat.test/settings",
      nextConfig,
    });
    expect(response.status).toBe(307);
    expect(getRedirectUrl(response)).toBe("https://goat.test/settings/profile");
  });

  it("leaves the settings pages and a trailing segment alone", async () => {
    for (const url of ["https://goat.test/settings/profile", "https://goat.test/settings/teams/abc"]) {
      const response = await unstable_getResponseFromNextConfig({ url, nextConfig });
      expect(getRedirectUrl(response), url).toBeNull();
    }
  });
});

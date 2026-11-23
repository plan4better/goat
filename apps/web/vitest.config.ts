import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react()] as any,
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    // The style lab runs in a real browser, under vitest.lab.config.ts.
    exclude: ["node_modules", "dist", ".next", "playwright", "**/*.e2e.{ts,tsx}", "**/*.lab.test.tsx"],
    // The dialog suites drive full MUI trees through user-event, and the
    // slowest cases sit near a second locally. The 5s default leaves them no
    // headroom on a two-core CI runner, where they time out at random.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", ".next/", "playwright/", "**/*.config.{js,ts}", "**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});

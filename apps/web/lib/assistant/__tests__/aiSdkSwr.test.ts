import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * `@ai-sdk/react` brings its own `swr`, which the app's SWRConfig does not reach.
 * That is fine only while `useChat` does not use SWR (its state lives in the Chat
 * class); this fails when a version bump changes that.
 */
describe("@ai-sdk/react", () => {
  it("useChat does not use SWR", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve("@ai-sdk/react"), "utf8");
    const start = source.indexOf("function useChat(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nfunction ", start + 1);
    expect(source.slice(start, end === -1 ? undefined : end)).not.toMatch(/useSWR/);
  });
});

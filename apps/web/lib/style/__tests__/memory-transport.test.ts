import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { createMemoryTransport } from "@/lib/style/transports/memory";

const DOC = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;

describe("memory transport", () => {
  it("the memory transport stores the checked document and counts revisions", async () => {
    const issue = { level: "info" as const, code: "x", path: "/symbol", message: "m" };
    const check = vi.fn(async (doc: LayerStyle) => ({
      document: { ...doc, legend: false } as LayerStyle,
      issues: [issue],
    }));
    const transport = createMemoryTransport({ document: DOC, revision: 5, check });
    const edited = { ...DOC, opacity: 0.5 } as LayerStyle;
    const result = await transport.save({ base_rev: 5, document: edited }, { keepalive: false });
    expect(check).toHaveBeenCalledWith(edited);
    expect(result).toEqual({
      ok: true,
      document: { ...edited, legend: false },
      revision: 6,
      issues: [issue],
    });
    expect(await transport.load()).toEqual({ document: { ...edited, legend: false }, revision: 6 });
  });

  it("a failed check is a retryable answer", async () => {
    const transport = createMemoryTransport({
      document: DOC,
      check: async () => Promise.reject(new Error("down")),
    });
    expect(await transport.save({ base_rev: 1, document: DOC }, { keepalive: false })).toEqual({
      ok: false,
      status: 503,
    });
  });
});

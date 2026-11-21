import { describe, expect, it } from "vitest";

import { defaultResolveIcon } from "@/lib/style/compile/images";

describe("defaultResolveIcon", () => {
  it("an uploaded icon resolves through core's asset route by its id, for every viewer", () => {
    expect(defaultResolveIcon("asset:7f3a91c2-0d4e-4c8a-9b1f-2a3b4c5d6e7f")).toEqual({
      url: "http://localhost:8000/api/v2/asset/7f3a91c2-0d4e-4c8a-9b1f-2a3b4c5d6e7f/file",
      sdf: false,
    });
    expect(defaultResolveIcon("asset:../../etc")).toBeNull();
  });

  it("library icons and the arrow resolve as before; fill patterns are no files", () => {
    expect(defaultResolveIcon("goat:arrow")).toEqual({ url: "/sprites/goat-arrow.svg", sdf: true });
    expect(defaultResolveIcon("goat:no-such-icon")).toBeNull();
    expect(defaultResolveIcon("goat:pattern-hatch_45")).toBeNull();
  });
});

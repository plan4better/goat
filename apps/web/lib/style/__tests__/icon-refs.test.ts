import { describe, expect, it } from "vitest";

import type { UploadedAsset } from "@/lib/validations/assets";

import { fromIconRef, toIconRef } from "@/components/map/panels/styleEditor/pickers/iconRefs";

const upload = {
  id: "u1",
  display_name: "Charger",
  file_name: "charger.png",
  url: "https://assets.example/u1.png",
} as UploadedAsset;

describe("icon refs", () => {
  it("icon refs round-trip", () => {
    expect(toIconRef({ name: "park", url: "/assets/icons/maki/park.svg", source: "library" })).toBe(
      "goat:park"
    );
    expect(toIconRef({ id: "u1", name: "Charger", url: upload.url, source: "custom" })).toBe("asset:u1");
    expect(fromIconRef("asset:u1", [upload])).toEqual({
      id: "u1",
      name: "Charger",
      url: upload.url,
      source: "custom",
    });
    const park = fromIconRef("goat:park", []);
    expect(park).toMatchObject({ name: "park", source: "library" });
    expect(park?.url.endsWith("/icons/maki/park.svg")).toBe(true);
    expect(toIconRef(park!)).toBe("goat:park");
  });

  it("an unknown ref has no marker", () => {
    expect(fromIconRef("asset:gone", [upload])).toBeNull();
    expect(fromIconRef("goat:no-such-icon", [])).toBeNull();
    expect(fromIconRef("park", [])).toBeNull();
  });
});

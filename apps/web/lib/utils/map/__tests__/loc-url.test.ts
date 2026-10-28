import { describe, expect, it } from "vitest";

import {
  getLocFromUrl,
  getStylesFromUrl,
  parseLoc,
  serializeLoc,
  writeLocToUrl,
  writeMapLocToUrl,
  writeStylesToUrl,
} from "../loc-url";

describe("serializeLoc", () => {
  it("serializes lat,lng,zoom with z suffix and trimmed trailing zeros", () => {
    expect(serializeLoc({ latitude: 48.13, longitude: 11.57, zoom: 10 })).toBe("48.13,11.57,10z");
  });

  it("rounds lat/lng to 5 decimals and zoom to 2", () => {
    expect(
      serializeLoc({ latitude: 48.137412345, longitude: 11.575493456, zoom: 14.96789 })
    ).toBe("48.13741,11.57549,14.97z");
  });

  it("omits bearing and pitch when zero", () => {
    expect(serializeLoc({ latitude: 1, longitude: 2, zoom: 3, bearing: 0, pitch: 0 })).toBe(
      "1,2,3z"
    );
  });

  it("appends non-zero bearing and pitch with b/p suffixes", () => {
    expect(serializeLoc({ latitude: 1, longitude: 2, zoom: 3, bearing: 45, pitch: 30 })).toBe(
      "1,2,3z,45b,30p"
    );
  });

  it("normalizes negative bearing to 0-360", () => {
    expect(serializeLoc({ latitude: 1, longitude: 2, zoom: 3, bearing: -90 })).toBe(
      "1,2,3z,270b"
    );
  });

  it("omits bearing that normalizes to zero", () => {
    expect(serializeLoc({ latitude: 1, longitude: 2, zoom: 3, bearing: 360 })).toBe("1,2,3z");
  });

  it("omits bearing that rounds to 360", () => {
    expect(serializeLoc({ latitude: 1, longitude: 2, zoom: 3, bearing: -0.04 })).toBe("1,2,3z");
  });
});

describe("parseLoc", () => {
  it("parses lat,lng,zoom with z suffix", () => {
    expect(parseLoc("48.13741,11.57549,14.96z")).toEqual({
      latitude: 48.13741,
      longitude: 11.57549,
      zoom: 14.96,
      bearing: 0,
      pitch: 0,
    });
  });

  it("parses zoom without z suffix", () => {
    expect(parseLoc("48.13,11.57,10")).toEqual({
      latitude: 48.13,
      longitude: 11.57,
      zoom: 10,
      bearing: 0,
      pitch: 0,
    });
  });

  it("parses bearing and pitch in any order", () => {
    expect(parseLoc("1,2,3z,45b,30p")).toEqual({
      latitude: 1,
      longitude: 2,
      zoom: 3,
      bearing: 45,
      pitch: 30,
    });
    expect(parseLoc("1,2,3z,30p,45b")).toEqual({
      latitude: 1,
      longitude: 2,
      zoom: 3,
      bearing: 45,
      pitch: 30,
    });
  });

  it("normalizes out-of-range bearing", () => {
    expect(parseLoc("1,2,3z,-90b")?.bearing).toBe(270);
  });

  it("round-trips serializeLoc output", () => {
    const loc = { latitude: 48.13741, longitude: 11.57549, zoom: 14.96, bearing: 45, pitch: 30 };
    expect(parseLoc(serializeLoc(loc))).toEqual(loc);
  });

  it.each([
    [null, "null"],
    [undefined, "undefined"],
    ["", "empty string"],
    ["garbage", "not a loc"],
    ["1,2", "too few tokens"],
    ["1,2,3z,45b,30p,9x", "too many tokens"],
    ["91,2,3z", "latitude out of range"],
    ["-91,2,3z", "latitude out of range negative"],
    ["1,181,3z", "longitude out of range"],
    ["1,2,25z", "zoom out of range"],
    ["1,2,-1z", "zoom negative"],
    ["1,2,3z,61p", "pitch out of range"],
    ["1,2,3z,45x", "unknown suffix"],
    ["1,2,3z,45b,90b", "duplicate bearing"],
    ["1,2,3z,30p,40p", "duplicate pitch"],
    ["1,2,3z,b", "suffix without value"],
    [",,3z", "empty lat/lng tokens"],
    ["1,2,z", "empty zoom token"],
    ["abc,2,3z", "non-numeric latitude"],
    ["0x5A,2,3z", "hex latitude"],
    ["48.13,11.57,1e1z", "scientific notation zoom"],
  ])("returns null for invalid input %s (%s)", (raw, _description) => {
    expect(parseLoc(raw as string | null | undefined)).toBeNull();
  });
});

describe("getLocFromUrl / writeLocToUrl", () => {
  it("writes loc to the URL, preserving other params and history state", () => {
    window.history.replaceState({ marker: "next-state" }, "", "/map/abc?foo=bar");
    writeLocToUrl({ latitude: 48.13, longitude: 11.57, zoom: 10, bearing: 0, pitch: 0 });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("loc")).toBe("48.13,11.57,10z");
    expect(params.get("foo")).toBe("bar");
    expect(window.history.state).toEqual({ marker: "next-state" });
  });

  it("overwrites an existing loc param", () => {
    window.history.replaceState(null, "", "/map/abc?loc=1,2,3z");
    writeLocToUrl({ latitude: 4, longitude: 5, zoom: 6 });
    expect(new URLSearchParams(window.location.search).get("loc")).toBe("4,5,6z");
  });

  it("reads and parses loc from the URL", () => {
    window.history.replaceState(null, "", "/map/abc?loc=48.13,11.57,10z,45b");
    expect(getLocFromUrl()).toEqual({
      latitude: 48.13,
      longitude: 11.57,
      zoom: 10,
      bearing: 45,
      pitch: 0,
    });
  });

  it("returns null when loc is absent or invalid", () => {
    window.history.replaceState(null, "", "/map/abc");
    expect(getLocFromUrl()).toBeNull();
    window.history.replaceState(null, "", "/map/abc?loc=garbage");
    expect(getLocFromUrl()).toBeNull();
  });

  it("does not write when values are non-finite", () => {
    window.history.replaceState(null, "", "/map/abc?loc=1,2,3z");
    writeLocToUrl({ latitude: NaN, longitude: 11.57, zoom: 10 });
    expect(new URLSearchParams(window.location.search).get("loc")).toBe("1,2,3z");
  });

  it("does not write when bearing or pitch is non-finite", () => {
    window.history.replaceState(null, "", "/map/abc?loc=1,2,3z");
    writeLocToUrl({ latitude: 4, longitude: 5, zoom: 6, bearing: NaN });
    expect(new URLSearchParams(window.location.search).get("loc")).toBe("1,2,3z");
    writeLocToUrl({ latitude: 4, longitude: 5, zoom: 6, pitch: Infinity });
    expect(new URLSearchParams(window.location.search).get("loc")).toBe("1,2,3z");
  });

  it("writes commas unencoded in the URL", () => {
    window.history.replaceState(null, "", "/map/abc");
    writeLocToUrl({ latitude: 48.13, longitude: 11.57, zoom: 10 });
    expect(window.location.search).toBe("?loc=48.13,11.57,10z");
  });

  it("does not un-encode commas in other params", () => {
    window.history.replaceState(null, "", "/map/abc?filter=a%2Cb");
    writeLocToUrl({ latitude: 1, longitude: 2, zoom: 3 });
    expect(window.location.search).toContain("filter=a%2Cb");
    expect(window.location.search).toContain("loc=1,2,3z");
  });
});

describe("writeMapLocToUrl", () => {
  it("writes the map camera to the URL", () => {
    window.history.replaceState(null, "", "/map/abc");
    writeMapLocToUrl({
      getCenter: () => ({ lat: 48.13, lng: 11.57 }),
      getZoom: () => 10,
      getBearing: () => 45,
      getPitch: () => 0,
    });
    expect(new URLSearchParams(window.location.search).get("loc")).toBe("48.13,11.57,10z,45b");
  });
});

describe("getStylesFromUrl / writeStylesToUrl", () => {
  it("a public viewer's style choices travel as styles=<layer>:<style>,… next to loc", () => {
    window.history.replaceState(null, "", "/map/public/p?loc=48.1,11.5,12z");
    expect(getStylesFromUrl()).toEqual({});
    writeStylesToUrl({ "12": "7f3a91c2-0d4e-4c8a-9b1f-2a3b4c5d6e7f", "13": "a" });
    expect(window.location.search).toBe("?loc=48.1,11.5,12z&styles=12:7f3a91c2-0d4e-4c8a-9b1f-2a3b4c5d6e7f,13:a");
    expect(getStylesFromUrl()).toEqual({ "12": "7f3a91c2-0d4e-4c8a-9b1f-2a3b4c5d6e7f", "13": "a" });
    writeStylesToUrl({});
    expect(window.location.search).toBe("?loc=48.1,11.5,12z");
    window.history.replaceState(null, "", "/map/public/p?styles=x:,12:b,:c,13");
    expect(getStylesFromUrl()).toEqual({ "12": "b" });
  });
});

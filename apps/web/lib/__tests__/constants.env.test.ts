import { afterEach, describe, expect, it, vi } from "vitest";

/** The constants module evaluated against the env stubbed so far. */
const loadConstants = async () => {
  vi.resetModules();
  return import("@/lib/constants");
};

const loadBasemaps = async () => {
  vi.resetModules();
  return import("@/lib/constants/basemaps");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CATALOG_BASE_URL", () => {
  it("falls back to the geoapi's /stac when the catalog url is still the Docker placeholder", async () => {
    vi.stubEnv("NEXT_PUBLIC_CATALOG_URL", "APP_NEXT_PUBLIC_CATALOG_URL");
    vi.stubEnv("NEXT_PUBLIC_GEOAPI_URL", "https://g.test/geoapi");
    const { CATALOG_BASE_URL } = await loadConstants();
    expect(CATALOG_BASE_URL).toBe("https://g.test/geoapi/stac");
  });

  it("uses the configured catalog url", async () => {
    vi.stubEnv("NEXT_PUBLIC_CATALOG_URL", "https://c.test/catalog/stac");
    vi.stubEnv("NEXT_PUBLIC_GEOAPI_URL", "https://g.test/geoapi");
    const { CATALOG_BASE_URL } = await loadConstants();
    expect(CATALOG_BASE_URL).toBe("https://c.test/catalog/stac");
  });
});

describe("ASSISTANT_BASE_URL", () => {
  it("is undefined without NEXT_PUBLIC_ASSISTANT_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_ASSISTANT_URL", "");
    const { ASSISTANT_BASE_URL } = await loadConstants();
    expect(ASSISTANT_BASE_URL).toBeUndefined();
  });

  it("is undefined while still the Docker placeholder", async () => {
    // A deployment that never sets the variable keeps the placeholder in the
    // bundle; the dock must stay hidden instead of fetching it as a path.
    vi.stubEnv("NEXT_PUBLIC_ASSISTANT_URL", "APP_NEXT_PUBLIC_ASSISTANT_URL");
    const { ASSISTANT_BASE_URL } = await loadConstants();
    expect(ASSISTANT_BASE_URL).toBeUndefined();
  });

  it("uses the configured url without a trailing slash", async () => {
    vi.stubEnv("NEXT_PUBLIC_ASSISTANT_URL", "https://goat.example.org/assistant/");
    const { ASSISTANT_BASE_URL } = await loadConstants();
    expect(ASSISTANT_BASE_URL).toBe("https://goat.example.org/assistant");
  });
});

describe("MAPTILER_KEY", () => {
  it("is undefined without NEXT_PUBLIC_MAPTILER_KEY, and no basemap points at MapTiler", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
    const { MAPTILER_KEY } = await loadConstants();
    expect(MAPTILER_KEY).toBeUndefined();
    const { BASEMAPS } = await loadBasemaps();
    expect(BASEMAPS.some((b) => b.url?.includes("maptiler"))).toBe(false);
    expect(BASEMAPS.some((b) => b.thumbnail.includes("maptiler"))).toBe(false);
  });

  it("is undefined while still the Docker placeholder", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "APP_NEXT_PUBLIC_MAPTILER_KEY");
    const { MAPTILER_KEY } = await loadConstants();
    expect(MAPTILER_KEY).toBeUndefined();
    const { BASEMAPS } = await loadBasemaps();
    expect(BASEMAPS.some((b) => b.url?.includes("maptiler"))).toBe(false);
  });

  it("adds the MapTiler imagery basemap with the configured key", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "abc");
    const { MAPTILER_KEY } = await loadConstants();
    expect(MAPTILER_KEY).toBe("abc");
    const { BASEMAPS } = await loadBasemaps();
    const satellite = BASEMAPS.find((b) => b.value === "satellite");
    expect(satellite?.url).toBe("https://api.maptiler.com/maps/hybrid/style.json?key=abc");
  });
});

describe("a saved MapTiler basemap without a key", () => {
  it("resolves to the default basemap", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
    vi.resetModules();
    const { BASEMAPS, DEFAULT_BASEMAP, getBasemapUrl } = await import("@/lib/constants/basemaps");
    const { resolveActiveBasemap } = await import("@/hooks/map/MapHooks");
    const defaultBasemap = BASEMAPS.find((b) => b.value === DEFAULT_BASEMAP);

    expect(resolveActiveBasemap("satellite", BASEMAPS, [])).toBe(defaultBasemap);
    expect(getBasemapUrl("satellite")).toBe(defaultBasemap?.url);
  });
});

describe("ASSETS_URL", () => {
  it("defaults to the web app's own /assets", async () => {
    vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", "");
    const { ASSETS_URL, ORG_DEFAULT_AVATAR, GEOFENCE_LAYERS_PATH } = await loadConstants();
    expect(ASSETS_URL).toBe("/assets");
    expect(ORG_DEFAULT_AVATAR).toBe("/assets/img/no-org-thumb.jpg");
    expect(GEOFENCE_LAYERS_PATH).toBe("/assets/other/geofence");
  });

  it("defaults to /assets while still the Docker placeholder", async () => {
    vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", "APP_NEXT_PUBLIC_ASSETS_URL");
    const { ASSETS_URL } = await loadConstants();
    expect(ASSETS_URL).toBe("/assets");
  });

  it("builds the static asset urls from NEXT_PUBLIC_ASSETS_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", " https://cdn.client.test/ ");
    const { ASSETS_URL, ORG_DEFAULT_AVATAR, GEOFENCE_LAYERS_PATH } = await loadConstants();
    expect(ASSETS_URL).toBe("https://cdn.client.test");
    expect(ORG_DEFAULT_AVATAR).toBe("https://cdn.client.test/img/no-org-thumb.jpg");
    expect(GEOFENCE_LAYERS_PATH).toBe("https://cdn.client.test/other/geofence");
  });

  it("builds the marker, pattern and basemap urls from the same base", async () => {
    vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", "");
    vi.resetModules();
    const { MAKI_ICONS_BASE_URL } = await import("@/lib/constants/icons");
    const { PATTERN_IMAGES } = await import("@/lib/constants/pattern-images");
    const { BASEMAPS } = await import("@/lib/constants/basemaps");
    expect(MAKI_ICONS_BASE_URL).toBe("/assets/icons/maki");
    expect(PATTERN_IMAGES.every((p) => p.url.startsWith("/assets/patterns/"))).toBe(true);
    expect(BASEMAPS.find((b) => b.value === "basemap_de_landuse")?.url).toBe(
      "/assets/goat/basemaps/bm_web_col_landuse_plan4better.json"
    );
    const everyUrl = [
      MAKI_ICONS_BASE_URL,
      ...PATTERN_IMAGES.map((p) => p.url),
      ...BASEMAPS.map((b) => b.url),
    ];
    expect(everyUrl.some((u) => u?.includes("plan4better.de"))).toBe(false);
  });
});

describe("CONTACT_URL", () => {
  it("is undefined without a contact url or a website", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_URL", "");
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "");
    const { CONTACT_URL } = await loadConstants();
    expect(CONTACT_URL).toBeUndefined();
  });

  it("is undefined while both are still Docker placeholders", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_URL", "APP_NEXT_PUBLIC_CONTACT_URL");
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "APP_NEXT_PUBLIC_WEBSITE_URL");
    const { CONTACT_URL } = await loadConstants();
    expect(CONTACT_URL).toBeUndefined();
  });

  it("uses NEXT_PUBLIC_CONTACT_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_URL", "https://support.client.test/goat");
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.site.test");
    const { CONTACT_URL } = await loadConstants();
    expect(CONTACT_URL).toBe("https://support.client.test/goat");
  });

  it("falls back to the website's contact page", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_URL", "");
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.site.test/");
    const { CONTACT_URL } = await loadConstants();
    expect(CONTACT_URL).toBe("https://www.site.test/en/contact/");
  });
});

describe("website-only surfaces", () => {
  it("are off without NEXT_PUBLIC_WEBSITE_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "");
    const { WELCOME_VIDEO, privacyPolicyUrl } = await loadConstants();
    expect(WELCOME_VIDEO).toBeUndefined();
    expect(privacyPolicyUrl("en")).toBeUndefined();
  });

  it("are on with NEXT_PUBLIC_WEBSITE_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.site.test");
    const { WELCOME_VIDEO, privacyPolicyUrl } = await loadConstants();
    expect(WELCOME_VIDEO?.url).toMatch(/\.mp4$/);
    expect(privacyPolicyUrl("en")).toBe("https://www.site.test/en/about-us/privacy");
    expect(privacyPolicyUrl("de")).toBe("https://www.site.test/de/about-us/datenschutz");
  });
});

describe("DOCS_URL", () => {
  it("defaults to the public docs", async () => {
    vi.stubEnv("NEXT_PUBLIC_DOCS_URL", "APP_NEXT_PUBLIC_DOCS_URL");
    const { DOCS_URL } = await loadConstants();
    expect(DOCS_URL).toBe("https://goat.plan4better.de/docs");
  });

  it("uses NEXT_PUBLIC_DOCS_URL without a trailing slash", async () => {
    vi.stubEnv("NEXT_PUBLIC_DOCS_URL", "https://docs.client.test/goat/");
    const { DOCS_URL } = await loadConstants();
    expect(DOCS_URL).toBe("https://docs.client.test/goat");
  });
});

describe("SUPPORT_EMAIL and SUPPORT_MAILTO", () => {
  const MAILTO_SUBJECT = "?subject=GOAT%20Support%20Request";
  const DEFAULT = "support@plan4better.de";

  it("use NEXT_PUBLIC_SUPPORT_EMAIL, trimmed", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", " help@client.test ");
    const { SUPPORT_EMAIL, SUPPORT_MAILTO } = await loadConstants();
    expect(SUPPORT_EMAIL).toBe("help@client.test");
    expect(SUPPORT_MAILTO).toBe(`mailto:help@client.test${MAILTO_SUBJECT}`);
  });

  it.each(["", "APP_NEXT_PUBLIC_SUPPORT_EMAIL"])(
    "default to Plan4Better's address for %j, with or without a website",
    async (value) => {
      for (const website of ["", "https://www.site.test"]) {
        vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", value);
        vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", website);
        const { SUPPORT_EMAIL, SUPPORT_MAILTO } = await loadConstants();
        expect(SUPPORT_EMAIL).toBe(DEFAULT);
        expect(SUPPORT_MAILTO).toBe(`mailto:${DEFAULT}${MAILTO_SUBJECT}`);
      }
    }
  );

  it.each([
    "not-an-address",
    "a@b@c.test",
    "help @client.test",
    '"help"@client.test',
    "<help@client.test>",
    "help@client.test?cc=x@y.test",
  ])("ignore the invalid value %j with one warning and use the default", async (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", value);
      const { SUPPORT_EMAIL, SUPPORT_MAILTO } = await loadConstants();
      expect(SUPPORT_EMAIL).toBe(DEFAULT);
      expect(SUPPORT_MAILTO).toBe(`mailto:${DEFAULT}${MAILTO_SUBJECT}`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("NEXT_PUBLIC_SUPPORT_EMAIL");
    } finally {
      warn.mockRestore();
    }
  });
});

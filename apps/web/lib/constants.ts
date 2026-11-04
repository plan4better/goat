import { isAuthDisabled } from "@/lib/utils/auth-flag";
import { publicEnv } from "@/lib/utils/public-env";

export const KEYCLOAK_CLIENT_ID = process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID;
export const KEYCLOAK_ISSUER = process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER;
export const GEOAPI_BASE_URL = process.env.NEXT_PUBLIC_GEOAPI_URL;
export const PROCESSES_BASE_URL = process.env.NEXT_PUBLIC_PROCESSES_URL;
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

/**
 * The assistant service (apps/assistant): `/assistant` behind a path-routing
 * gateway, or its own host. Unset and the unsubstituted Docker placeholder
 * both count as "not set", which hides the dock and the admin AI page.
 */
export const ASSISTANT_BASE_URL = publicEnv(process.env.NEXT_PUBLIC_ASSISTANT_URL)?.replace(/\/+$/, "");
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL;
/**
 * STAC API of the catalog service (apps/catalog).
 *
 * Falls back to `${GEOAPI_BASE_URL}/stac`, which is where the ingress
 * path-routes it in every deployed environment (design S7) — so only local
 * development, where the service answers directly on :8400, needs the
 * variable set. Unset and the unsubstituted Docker placeholder both count as
 * "not set".
 */
export const CATALOG_BASE_URL =
  publicEnv(process.env.NEXT_PUBLIC_CATALOG_URL) ?? (GEOAPI_BASE_URL ? `${GEOAPI_BASE_URL}/stac` : undefined);
export const AUTH_DISABLED = isAuthDisabled(process.env.NEXT_PUBLIC_AUTH);

/** The user documentation; `NEXT_PUBLIC_DOCS_URL` points it at another host. */
export const DOCS_URL =
  publicEnv(process.env.NEXT_PUBLIC_DOCS_URL)?.replace(/\/+$/, "") ?? "https://goat.plan4better.de/docs";
/**
 * The public website. `NEXT_PUBLIC_WEBSITE_URL` names the deployment whose
 * blog and GOAT changelog RSS feeds fill Home's "From our blog" and "What's
 * new"; when it is unset (or still the Docker placeholder) those surfaces
 * stay hidden and only the plain links fall back to production.
 */
const configuredWebsiteUrl = publicEnv(process.env.NEXT_PUBLIC_WEBSITE_URL)?.replace(/\/+$/, "");
export const WEBSITE_URL = configuredWebsiteUrl ?? "https://www.plan4better.de";
export const WEBSITE_FEEDS_ENABLED = Boolean(configuredWebsiteUrl);

/**
 * Where "Contact us" links lead (quota alerts, the suspended organization, the
 * trial chip): `NEXT_PUBLIC_CONTACT_URL`, else the contact page of the website
 * `NEXT_PUBLIC_WEBSITE_URL` names. Undefined without either, and those links
 * are left out.
 */
export const CONTACT_URL =
  publicEnv(process.env.NEXT_PUBLIC_CONTACT_URL)?.trim() ||
  (configuredWebsiteUrl ? `${configuredWebsiteUrl}/en/contact/` : undefined);

/**
 * The address "Report a problem" mails (while support tickets are off) and the
 * "support unavailable" messages name: `NEXT_PUBLIC_SUPPORT_EMAIL`, else
 * Plan4Better's support address. Set your own for a white-label installation.
 * A value that is not a plain address (one `@`, none of whitespace, quotes,
 * angle brackets or the characters that would break a mailto link) is ignored
 * with a warning.
 */
const DEFAULT_SUPPORT_EMAIL = "support@plan4better.de";
const configuredSupportEmail = (() => {
  const value = publicEnv(process.env.NEXT_PUBLIC_SUPPORT_EMAIL)?.trim();
  if (!value) return undefined;
  if (/^[^\s@"'<>,;?&#%\\()]+@[^\s@"'<>,;?&#%\\()]+$/.test(value)) return value;
  console.warn(`NEXT_PUBLIC_SUPPORT_EMAIL is not a valid email address; using ${DEFAULT_SUPPORT_EMAIL}.`);
  return undefined;
})();

export const SUPPORT_EMAIL = configuredSupportEmail ?? DEFAULT_SUPPORT_EMAIL;

export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=GOAT%20Support%20Request`;

/** The website's privacy policy for a UI language; undefined without `NEXT_PUBLIC_WEBSITE_URL`. */
export const privacyPolicyUrl = (lng: string): string | undefined =>
  configuredWebsiteUrl
    ? `${configuredWebsiteUrl}/${lng === "de" ? "de/about-us/datenschutz" : "en/about-us/privacy"}`
    : undefined;

/** The catchment-area walkthrough the help strip links to, one cut per UI language. */
export const HELP_VIDEO_URL: Record<"en" | "de", string> = {
  en: "https://www.youtube.com/watch?v=_clsR386b9w",
  de: "https://www.youtube.com/watch?v=GA_6PbhAA6k",
};
/**
 * The product intro the first-run Welcome plays: a Bunny Stream video on the
 * product's video CDN, which generates the poster and the MP4 renditions
 * beside the HLS playlist. The 720p MP4 plays in a `<video>` everywhere.
 * Offered only where `NEXT_PUBLIC_WEBSITE_URL` is set, like the website
 * feeds; without it there is no Welcome.
 */
const WELCOME_VIDEO_BASE = "https://videos.plan4better.de/31ad707d-c1f2-4f21-8c47-1c610141f9d2";
export const WELCOME_VIDEO: { url: string; poster: string } | undefined = configuredWebsiteUrl
  ? { url: `${WELCOME_VIDEO_BASE}/play_720p.mp4`, poster: `${WELCOME_VIDEO_BASE}/thumbnail.jpg` }
  : undefined;
export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

/**
 * MapTiler API key. Without one, the MapTiler imagery basemap is left out of
 * the basemap list and template thumbnails draw no static map frame.
 */
export const MAPTILER_KEY = publicEnv(process.env.NEXT_PUBLIC_MAPTILER_KEY);

/**
 * Base of the static product assets (icons, patterns, artwork, geofences,
 * basemap styles). By default the web app serves them itself from
 * `public/assets`, so the base is the root-relative `/assets` and resolves
 * against whichever host the page is on; `NEXT_PUBLIC_ASSETS_URL` points it
 * at a mirror.
 */
export const ASSETS_URL =
  publicEnv(process.env.NEXT_PUBLIC_ASSETS_URL)?.trim().replace(/\/+$/, "") || "/assets";

export const ORG_DEFAULT_AVATAR = `${ASSETS_URL}/img/no-org-thumb.jpg`;

export const STREET_NETWORK_LAYER_ID = "903ecdca-b717-48db-bbce-0219e41439cf";
export const SYSTEM_LAYERS_IDS = [STREET_NETWORK_LAYER_ID];

export const GEOFENCE_LAYERS_PATH = `${ASSETS_URL}/other/geofence`;
export const DEFAULT_WKT_EXTENT = "POLYGON((-180 -90, -180 90, 180 90, 180 -90, -180 -90))";

export const MAX_EDITABLE_LAYER_SIZE = 100 * 1024 * 1024; // 100MB

export const THEME_COOKIE_NAME = "client_theme";
export const LANGUAGE_COOKIE_NAME = "client_language";

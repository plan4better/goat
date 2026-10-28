import { getSession, signIn } from "next-auth/react";

/**
 * Cached access token to avoid hitting /api/auth/session on every API request.
 * getSession() makes a network call each time, so with ~70+ SWR hooks this
 * would otherwise generate dozens of session requests per second.
 *
 * Cache expiry is tied to the JWT exp claim with a 10s buffer, so the token
 * is always refreshed before it actually expires.
 */
let cachedToken: string | null = null;
let cacheExpiry = 0;
const REFRESH_BUFFER_MS = 10_000; // refresh 10s before token expires
const NULL_CACHE_MS = 30_000; // cache null results for 30s
let pendingSessionPromise: Promise<string | null> | null = null;

/** Extract exp from a JWT without verifying signature */
function getTokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Get access token from session or localStorage (for print mode)
 * Print mode uses localStorage to pass token from Playwright
 */
const getAccessToken = async (): Promise<string | null> => {
  // Fallback to localStorage for print mode (Playwright injects token here)
  if (typeof window !== "undefined") {
    const printToken = localStorage.getItem("print_access_token");
    if (printToken) {
      return printToken;
    }
  }

  // Return cached result if still valid (caches both token and null)
  if (Date.now() < cacheExpiry) {
    return cachedToken;
  }

  // Deduplicate concurrent getSession() calls
  if (pendingSessionPromise) {
    return pendingSessionPromise;
  }

  pendingSessionPromise = getSession()
    .then((session) => {
      if (session?.error === "RefreshAccessTokenError") {
        // The refresh token is no longer valid (e.g. the Keycloak SSO session
        // expired). Never replay the stale access token — re-authenticate: a
        // live SSO session redirects straight back, otherwise the login page.
        cachedToken = null;
        cacheExpiry = Date.now() + NULL_CACHE_MS;
        if (typeof window !== "undefined") {
          void signIn("keycloak");
        }
        return null;
      }
      cachedToken = session?.access_token ?? null;
      if (cachedToken) {
        const exp = getTokenExpiry(cachedToken);
        cacheExpiry = exp ? exp - REFRESH_BUFFER_MS : Date.now() + NULL_CACHE_MS;
      } else {
        cacheExpiry = Date.now() + NULL_CACHE_MS;
      }
      return cachedToken;
    })
    .finally(() => {
      pendingSessionPromise = null;
    });

  return pendingSessionPromise;
};

/** Asks for a new session (after a 401 the cached token may be the reason); false when there is none, which needs a
 * new sign-in. */
export const renewAccessToken = async (): Promise<boolean> => {
  cachedToken = null;
  cacheExpiry = 0;
  return (await getAccessToken()) !== null;
};

/** Clear the cached token (call on sign-out) */
export const clearTokenCache = () => {
  cachedToken = null;
  cacheExpiry = 0;
};

/** The query entries worth sending: `URLSearchParams` stringifies an unset
 * value as the literal `undefined` (`?kind=undefined`), which a typed query
 * parameter rejects, so an entry a caller left unset is dropped here. */
const definedEntries = (queryParams): Record<string, string> =>
  Object.fromEntries(
    Object.entries(queryParams)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]): [string, string] => [key, String(value)])
  );

export const fetcher = async (params) => {
  let queryParams, url, payload;
  if (Array.isArray(params)) {
    url = params[0];
    queryParams = params[1];
    payload = params[2];
  } else {
    url = params;
  }
  const urlWithParams = queryParams ? `${url}?${new URLSearchParams(definedEntries(queryParams))}` : url;
  const options = {};
  if (payload) {
    options["method"] = "POST";
    options["body"] = JSON.stringify(payload);
    options["headers"] = {
      "Content-Type": "application/json",
    };
  }
  const accessToken = await getAccessToken();

  if (accessToken) {
    if (!options["headers"]) {
      options["headers"] = {};
    }
    options["headers"]["Authorization"] = `Bearer ${accessToken}`;
  }

  const res = await fetch(urlWithParams, options);
  // If the status code is not in the range 200-299,
  // we still try to parse and throw it.
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error: any = new Error("An error occurred while fetching the data.");
    // Attach extra info to the error object.
    error.info = await res.json();
    error.status = res.status;
    throw error;
  }

  return res.json();
};

export const apiRequestAuth = async (url: string, options?: RequestInit): Promise<Response> => {
  const accessToken = await getAccessToken();
  if (accessToken) {
    if (!options) {
      options = {};
    }
    if (!options.headers) {
      options.headers = {};
    }
    options.headers["Authorization"] = `Bearer ${accessToken}`;
  }
  return fetch(url, options);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateRessource = async (url: string, { arg }: { arg: any }) => {
  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(arg),
  });
};

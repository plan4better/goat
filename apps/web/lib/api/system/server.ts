import type { SystemSettings } from "@/lib/validations/system";

/** The user's settings, read on the server. `acceptLanguage` is the browser's
 * Accept-Language: GOAT starts a new user's language from it when Keycloak keeps
 * none for them. */
export const getSystemSettings = async (
  token: string,
  acceptLanguage?: string | null
): Promise<SystemSettings | null> => {
  const SYSTEM_API_BASE_URL = new URL("api/v2/system", process.env.NEXT_PUBLIC_API_URL).href;
  if (!token) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (acceptLanguage) headers["Accept-Language"] = acceptLanguage;
  const res = await fetch(`${SYSTEM_API_BASE_URL}/settings`, { headers });
  if (!res.ok) return null;
  return res.json();
};

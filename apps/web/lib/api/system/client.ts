// lib/api/system.ts
import { apiErrorOf } from "@/lib/api/apiError";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import type { SystemSettings, SystemSettingsUpdate } from "@/lib/validations/system";

export const SYSTEM_API_BASE_URL = new URL("api/v2/system", process.env.NEXT_PUBLIC_API_URL).href;

/**
 * SWR hook that fetches the logged‑in user's system settings from FastAPI
 */
export const useSystemSettings = () => {
  const { data, isLoading, error, mutate, isValidating } = useAuthedSWR<SystemSettings>(
    `${SYSTEM_API_BASE_URL}/settings`,
    fetcher
  );

  return {
    systemSettings: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

/**
 * Update system settings (PUT /settings). `token` is optional: `apiRequestAuth`
 * already resolves the caller's session token on its own (used by callers,
 * e.g. `lib/api/preferences.ts`, that don't have a `useSession()` token to
 * hand in); pass it explicitly only when the caller already has one on hand.
 */
export const updateSystemSettings = async (
  body: SystemSettingsUpdate,
  token?: string
): Promise<SystemSettings | null> => {
  const res = await apiRequestAuth(`${SYSTEM_API_BASE_URL}/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiErrorOf(res);
  // backend response is validated/normalized — use that
  return res.json();
};

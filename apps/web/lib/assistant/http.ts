import { getAccessToken } from "@/lib/api/fetcher";
import { readAssistantError } from "@/lib/assistant/errors";
import { ASSISTANT_BASE_URL } from "@/lib/constants";

export const assistantUrl = (path: string): string => `${ASSISTANT_BASE_URL}${path}`;

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** One JSON request to the assistant service. Throws AssistantRequestError on an error answer. */
export async function assistantFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== "") params.append(key, value);
  }
  const query = params.toString();
  const response = await fetch(`${assistantUrl(path)}${query ? `?${query}` : ""}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(await authHeaders()),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) throw await readAssistantError(response);
  if (response.status === 202 || response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

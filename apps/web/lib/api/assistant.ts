import useSWR, { mutate } from "swr";

import { fetcher } from "@/lib/api/fetcher";
import { AssistantApiError } from "@/lib/assistant/errors";
import { assistantFetch, assistantUrl } from "@/lib/assistant/http";
import { ASSISTANT_BASE_URL } from "@/lib/constants";
import type {
  AssistantConnection,
  AssistantSettings,
  AssistantSettingsUpdate,
  AssistantStatus,
  ConnectionPayload,
} from "@/lib/validations/assistant";

export { AssistantApiError };

const send = <T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> =>
  assistantFetch<T>(path, { method, body });

const statusKey = () => (ASSISTANT_BASE_URL ? [assistantUrl("/status")] : null);

/**
 * Whether AI is available for the signed-in user (every member; the dock uses it).
 * Read again when the tab gets the focus back (SWR throttles it), so a dock in another
 * tab follows an admin's switch between GOAT AI and an own connection.
 */
export function useAssistantStatus() {
  const { data, error, isLoading } = useSWR<AssistantStatus>(statusKey(), fetcher);
  return { status: data, isLoading, isError: error };
}

/**
 * Reads `/status` again wherever it is used. The dock's used-up line holds sending
 * back on its `goat_ai`, so it is read again when that line engages, when GOAT AI
 * refuses an answer and after the AI settings change.
 */
export const refreshAssistantStatus = () => {
  const key = statusKey();
  return key ? mutate(key) : Promise.resolve(undefined);
};

export function useAssistantSettings(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<AssistantSettings>(
    enabled && ASSISTANT_BASE_URL ? [assistantUrl("/settings")] : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { settings: data, isLoading, error, mutate };
}

export function useAssistantConnections(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<AssistantConnection[]>(
    enabled && ASSISTANT_BASE_URL ? [assistantUrl("/connections")] : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { connections: data ?? [], isLoading, error, mutate };
}

export const updateAssistantSettings = (payload: AssistantSettingsUpdate) =>
  send<AssistantSettings>("/settings", "PUT", payload);

export const createAssistantConnection = (payload: ConnectionPayload) =>
  send<AssistantConnection>("/connections", "POST", payload);

export const updateAssistantConnection = (id: string, payload: ConnectionPayload) =>
  send<AssistantConnection>(`/connections/${id}`, "PATCH", payload);

export const deleteAssistantConnection = (id: string) => send<void>(`/connections/${id}`, "DELETE");

export const testAssistantConnection = (id: string) =>
  send<AssistantConnection>(`/connections/${id}/test`, "POST");

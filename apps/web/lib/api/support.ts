import { mutate as globalMutate } from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import {
  type SupportAttachment,
  type SupportCategory,
  type SupportColleague,
  type SupportImpact,
  type SupportRating,
  type SupportSummary,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportWriteResult,
  supportWriteResultSchema,
} from "@/lib/validations/support";

export const SUPPORT_API_BASE_URL = new URL("api/v2/support", process.env.NEXT_PUBLIC_API_URL).href;

export class SupportRequestError extends Error {
  constructor(
    public status: number,
    public detail: string
  ) {
    super(`support request failed: ${status} ${detail}`);
    this.name = "SupportRequestError";
  }
}

/**
 * Core answers with a string code (`detail: "file_too_large"`), except FastAPI
 * request validation (422), where `detail` is a list of `{loc, msg, type}`.
 * Callers get a string either way.
 */
const toDetail = (raw: unknown): string => {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return "invalid_request";
  return "";
};

const send = async (url: string, init: RequestInit): Promise<Response> => {
  const response = await apiRequestAuth(url, init);
  if (!response.ok) {
    let detail = "";
    try {
      detail = toDetail((await response.json()).detail);
    } catch {
      detail = "";
    }
    throw new SupportRequestError(response.status, detail);
  }
  return response;
};

/** `fetcher` throws an Error carrying `status` and the parsed body as `info`. */
const asRequestError = (error: unknown): SupportRequestError | undefined => {
  if (!error) return undefined;
  const e = error as { status?: number; info?: { detail?: unknown } };
  return new SupportRequestError(e.status ?? 0, toDetail(e.info?.detail));
};

/**
 * Support is on once data arrived, or when the error is a server/network one
 * (5xx, status 0: Odoo down, offline) that should keep the entry visible. 404
 * (not configured) and 401/403 (no valid session) keep it off.
 */
export const isSupportEnabled = (data: unknown, error: unknown): boolean => {
  if (data !== undefined) return true;
  if (error === undefined || error === null) return false;
  const status = asRequestError(error)?.status ?? 0;
  return status >= 500 || status === 0;
};

/**
 * Header badge and feature probe: 404 = support is off on this installation (`notConfigured`).
 * `enabled: false` (e.g. logged out) skips the request entirely.
 *
 * No polling: replies reach users by email. The summary loads when the page loads and again when
 * the tab regains focus, and the user's own writes revalidate it at once (`revalidateSupport`).
 * Core answers repeats from a short per-user cache. Errors are not retried; the next load or
 * focus asks again.
 *
 * While the first answer is on its way, support counts as on, so the support entries show at once
 * and the counts follow. The answer can take a moment (core may ask Odoo); a 404 (support off)
 * comes back at once, without Odoo, and turns the entries off again.
 */
export const useSupportSummary = ({ enabled: active = true }: { enabled?: boolean } = {}) => {
  const { data, error, isLoading } = useAuthedSWR<SupportSummary>(
    active ? `${SUPPORT_API_BASE_URL}/summary` : null,
    fetcher,
    { revalidateOnFocus: true, shouldRetryOnError: false }
  );
  const notConfigured = active && !!error && asRequestError(error)?.status === 404;
  const enabled = active && (isSupportEnabled(data, error) || (!!isLoading && !error));
  return { summary: data, enabled, notConfigured };
};

const SUPPORT_TICKETS_URL = `${SUPPORT_API_BASE_URL}/tickets`;
type TicketScope = "mine" | "org";
type TicketState = "open" | "closed";

/** The SWR key of one ticket list, shared by the hook, the refresh and the revalidation. */
const ticketsKey = (scope: TicketScope, state: TicketState) => [SUPPORT_TICKETS_URL, { scope, state }];

/**
 * After a write: the header badge and every ticket list (both scopes, open and closed) are stale.
 * The ticket detail is refetched by its caller.
 */
export const revalidateSupport = (): Promise<unknown> =>
  globalMutate((key) => {
    if (key === `${SUPPORT_API_BASE_URL}/summary`) return true;
    return Array.isArray(key) && key[0] === SUPPORT_TICKETS_URL;
  });

/**
 * Revalidates the ticket lists that are mounted (all scopes and states, or those `include` accepts),
 * without touching the summary. For when the summary has already changed.
 */
export const revalidateSupportTickets = (
  include: (scope: TicketScope, state: TicketState) => boolean = () => true
): Promise<unknown> =>
  globalMutate((key) => {
    if (!Array.isArray(key) || key[0] !== SUPPORT_TICKETS_URL) return false;
    const { scope, state } = (key[1] ?? {}) as { scope?: TicketScope; state?: TicketState };
    if (!scope || !state) return false;
    return include(scope, state);
  });

/**
 * After the user changed a ticket (status, reply): drops the cached ticket lists, so the list page
 * loads them fresh instead of showing the old state first, and refetches the summary (badge).
 */
export const forgetSupportLists = (): Promise<unknown> =>
  Promise.all([
    globalMutate((key) => Array.isArray(key) && key[0] === SUPPORT_TICKETS_URL, undefined, {
      revalidate: true,
    }),
    globalMutate(`${SUPPORT_API_BASE_URL}/summary`),
  ]);

export const useSupportTickets = (scope: TicketScope, state: TicketState) => {
  const { data, error, isLoading, mutate } = useAuthedSWR<SupportTicket[]>(
    ticketsKey(scope, state),
    fetcher,
    { shouldRetryOnError: false }
  );
  return { tickets: data, error: asRequestError(error), isLoading, mutate };
};

/**
 * Fetches the user's tickets of one state now and stores the result under the key
 * `useSupportTickets("mine", state)` reads, so a mounted ticket list shows the same data without a
 * second request.
 */
export const refreshSupportTickets = (state: TicketState): Promise<SupportTicket[]> => {
  const key = ticketsKey("mine", state);
  return globalMutate<SupportTicket[]>(key, fetcher(key) as Promise<SupportTicket[]>, {
    revalidate: false,
  }) as Promise<SupportTicket[]>;
};

export const useSupportTicket = (ref?: string) => {
  const { data, error, isLoading, mutate } = useAuthedSWR<SupportTicketDetail>(
    ref ? `${SUPPORT_API_BASE_URL}/tickets/${encodeURIComponent(ref)}` : null,
    fetcher,
    { shouldRetryOnError: false }
  );
  return { ticket: data, error: asRequestError(error), isLoading, mutate };
};

export const useSupportColleagues = () => {
  const { data } = useAuthedSWR<SupportColleague[]>(`${SUPPORT_API_BASE_URL}/colleagues`, fetcher);
  return { colleagues: data ?? [] };
};

export type NewSupportTicket = {
  subject: string;
  description: string;
  category: SupportCategory;
  impact: SupportImpact | null;
  requestId: string;
  colleagueIds: string[];
  technical: Record<string, string>;
};

export const createSupportTicket = async (
  input: NewSupportTicket,
  files: File[],
  signal?: AbortSignal
): Promise<SupportWriteResult> => {
  const form = new FormData();
  form.append("subject", input.subject);
  form.append("description", input.description);
  form.append("category", input.category);
  if (input.impact) form.append("impact", input.impact);
  form.append("request_id", input.requestId);
  input.colleagueIds.forEach((id) => form.append("colleague_ids", id));
  form.append("technical", JSON.stringify(input.technical));
  files.forEach((file) => form.append("files", file, file.name));
  const response = await send(`${SUPPORT_API_BASE_URL}/tickets`, { method: "POST", body: form, signal });
  const result = supportWriteResultSchema.parse(await response.json());
  void revalidateSupport();
  return result;
};

export const postSupportReply = async (
  ref: string,
  text: string,
  files: File[],
  signal?: AbortSignal
): Promise<SupportWriteResult> => {
  const form = new FormData();
  form.append("text", text);
  files.forEach((file) => form.append("files", file, file.name));
  const response = await send(`${SUPPORT_API_BASE_URL}/tickets/${encodeURIComponent(ref)}/messages`, {
    method: "POST",
    body: form,
    signal,
  });
  const result = supportWriteResultSchema.parse(await response.json());
  void revalidateSupport();
  return result;
};

export const resolveSupportTicket = async (ref: string): Promise<void> => {
  await send(`${SUPPORT_API_BASE_URL}/tickets/${encodeURIComponent(ref)}/resolve`, { method: "POST" });
  void revalidateSupport();
};

export const reopenSupportTicket = async (ref: string): Promise<void> => {
  await send(`${SUPPORT_API_BASE_URL}/tickets/${encodeURIComponent(ref)}/reopen`, { method: "POST" });
  void revalidateSupport();
};

export const updateSupportFollowers = async (
  ref: string,
  change: { add_user_ids?: string[]; remove_contact_ids?: number[] }
): Promise<void> => {
  await send(`${SUPPORT_API_BASE_URL}/tickets/${encodeURIComponent(ref)}/followers`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      add_user_ids: change.add_user_ids ?? [],
      remove_contact_ids: change.remove_contact_ids ?? [],
    }),
  });
  void revalidateSupport();
};

export const rateSupportTicket = async (
  ref: string,
  rating: SupportRating,
  comment: string
): Promise<void> => {
  await send(`${SUPPORT_API_BASE_URL}/tickets/${encodeURIComponent(ref)}/rating`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating, comment }),
  });
  void revalidateSupport();
};

/** After a timeout: did Odoo create the ticket anyway? */
export const findSupportTicketByRequestId = async (requestId: string): Promise<SupportTicket | null> => {
  let tickets: SupportTicket[];
  try {
    tickets = await fetcher([
      `${SUPPORT_API_BASE_URL}/tickets`,
      { scope: "mine", state: "open", request_id: requestId },
    ]);
  } catch (error) {
    throw asRequestError(error) ?? error;
  }
  const found = tickets[0] ?? null;
  if (found) void revalidateSupport();
  return found;
};

export const downloadSupportAttachment = async (
  ref: string,
  attachment: SupportAttachment
): Promise<void> => {
  const response = await send(
    `${SUPPORT_API_BASE_URL}/tickets/${encodeURIComponent(ref)}/attachments/${attachment.id}`,
    {
      method: "GET",
    }
  );
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Firefox cancels the download if the URL is revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

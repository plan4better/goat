import { SUPPORT_MAILTO } from "@/lib/constants";

/**
 * `/support/new`, carrying the page the user came from so the ticket can name it. Not from the
 * support pages themselves: "Page: /support" tells an agent nothing.
 */
export const newTicketPath = (from?: string | null): string =>
  from && !/^\/support(\/|$|\?)/.test(from)
    ? `/support/new?from=${encodeURIComponent(from)}`
    : "/support/new";

/**
 * Where "Report a problem" leads: the new ticket form where there are support tickets, else an
 * email to support (`mailto`); `null` with neither.
 */
export const reportProblemHref = (
  hasTickets: boolean,
  from?: string | null,
  mailto: string = SUPPORT_MAILTO
): string | null => (hasTickets ? newTicketPath(from) : mailto || null);

/** `/support/<ref>`, the page of one ticket. */
export const supportTicketPath = (ref: string): string => `/support/${encodeURIComponent(ref)}`;

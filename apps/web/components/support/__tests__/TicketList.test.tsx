import { fireEvent, render, screen } from "@testing-library/react";
import { enGB } from "date-fns/locale";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SupportRequestError } from "@/lib/api/support";
import type { SupportTicket } from "@/lib/validations/support";

import TicketList from "@/components/support/TicketList";

const { useSupportTicketsMock, pushMock, notFoundMock, isOrgAdmin } = vi.hoisted(() => ({
  useSupportTicketsMock: vi.fn(),
  pushMock: vi.fn(),
  notFoundMock: vi.fn(),
  isOrgAdmin: { value: false },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: { agent?: string }) => (o?.agent ? `${key}:${o.agent}` : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("@/lib/api/support", () => ({
  useSupportTickets: useSupportTicketsMock,
  SupportRequestError: class extends Error {
    constructor(
      public status: number,
      public detail: string
    ) {
      super(detail);
    }
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }), notFound: notFoundMock }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => enGB }));
vi.mock("@/hooks/auth/AuthZ", () => ({ useAuthZ: () => ({ isOrgAdmin: isOrgAdmin.value }) }));

const ticket = (o: Partial<SupportTicket>): SupportTicket => ({
  ref: "00031",
  subject: "Catchment area fails",
  status: "in_progress",
  category: "bug",
  impact: "blocking",
  customer_name: "Marco",
  customer_contact_id: 100,
  is_mine: true,
  agent_name: "Lena",
  via: "app",
  created_at: "2026-09-28T09:00:00Z",
  updated_at: "2026-09-30T09:00:00Z",
  closed_at: null,
  latest_message_author: "Lena",
  latest_message_is_agent: true,
  latest_message_at: "2026-09-30T09:00:00Z",
  unread: false,
  needs_my_reply: false,
  ...o,
});

const setLists = (open: SupportTicket[], closed: SupportTicket[] = []) =>
  useSupportTicketsMock.mockImplementation((_scope: string, state: string) => ({
    tickets: state === "open" ? open : closed,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }));

describe("TicketList", () => {
  it("shows neither tabs nor 'no tickets yet' until both lists are known", () => {
    useSupportTicketsMock.mockImplementation((_scope: string, state: string) => ({
      tickets: state === "open" ? [] : undefined, // closed still loading
      error: undefined,
      isLoading: state !== "open",
      mutate: vi.fn(),
    }));
    render(<TicketList />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("support_empty_title")).toBeNull();
  });

  it("says 'no tickets yet' only when both lists came back empty", () => {
    setLists([], []);
    render(<TicketList />);
    expect(screen.getByText("support_empty_title")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  beforeEach(() => {
    useSupportTicketsMock.mockReset();
    pushMock.mockReset();
    notFoundMock.mockReset();
    isOrgAdmin.value = false;
  });

  it("shows the empty state without tickets", () => {
    setLists([]);
    render(<TicketList />);
    expect(screen.getByText("support_empty_title")).toBeTruthy();
  });

  it("lists open tickets, marks unread and opens a ticket on click", () => {
    setLists([ticket({ unread: true })], [ticket({ ref: "00022", status: "solved" })]);
    render(<TicketList />);
    expect(screen.getByText("Catchment area fails")).toBeTruthy();
    expect(screen.getByLabelText("support_unread")).toBeTruthy();
    fireEvent.click(screen.getByText("Catchment area fails"));
    expect(pushMock).toHaveBeenCalledWith("/support/00031");
  });

  it("shows the unread dot on a closed ticket in the Closed tab", () => {
    setLists([], [ticket({ ref: "00022", status: "solved", subject: "Solved one", unread: true })]);
    render(<TicketList />);
    fireEvent.click(screen.getByText("support_tab_closed"));
    expect(screen.getByText("Solved one")).toBeTruthy();
    expect(screen.getByLabelText("support_unread")).toBeTruthy();
  });

  it("shows the needs-reply banner and a scope switch only for admins", () => {
    setLists([ticket({ status: "waiting", needs_my_reply: true, subject: "Bus stops missing" })]);
    const { rerender } = render(<TicketList />);
    expect(screen.getByText("support_banner_one:Lena")).toBeTruthy();
    expect(screen.queryByText("support_scope_org")).toBeNull();
    isOrgAdmin.value = true;
    rerender(<TicketList />);
    expect(screen.getByText("support_scope_org")).toBeTruthy();
  });

  it("explains when support is unavailable", () => {
    useSupportTicketsMock.mockReturnValue({
      tickets: undefined,
      error: new SupportRequestError(503, "support_unavailable"),
      isLoading: false,
    });
    render(<TicketList />);
    expect(screen.getByText("support_unavailable")).toBeTruthy();
  });

  it("names the agent who wrote the latest message in the banner", () => {
    setLists([
      ticket({
        needs_my_reply: true,
        agent_name: "Lena",
        latest_message_author: "Jonas",
        latest_message_is_agent: true,
      }),
    ]);
    render(<TicketList />);
    expect(screen.getByText("support_banner_one:Jonas")).toBeTruthy();
  });

  it("names no agent in the banner when none wrote the latest message", () => {
    setLists([
      ticket({
        needs_my_reply: true,
        agent_name: "Lena",
        latest_message_author: "Anna",
        latest_message_is_agent: false,
      }),
    ]);
    render(<TicketList />);
    expect(screen.getByText(/^support_banner_one_team/)).toBeTruthy();
    expect(screen.queryByText(/Lena/)).toBeNull();
  });

  it.each([0, 500])("treats status %i as unavailable, not as an empty list", (status) => {
    useSupportTicketsMock.mockReturnValue({
      tickets: undefined,
      error: new SupportRequestError(status, ""),
      isLoading: false,
    });
    render(<TicketList />);
    expect(screen.getByText("support_unavailable")).toBeTruthy();
    expect(screen.queryByText("support_empty_title")).toBeNull();
  });

  it("shows other errors with their own message and never the empty state", () => {
    useSupportTicketsMock.mockReturnValue({
      tickets: undefined,
      error: new SupportRequestError(429, ""),
      isLoading: false,
    });
    render(<TicketList />);
    expect(screen.getByRole("alert").textContent).toBe("support_rate_limited");
    expect(screen.queryByText("support_unavailable")).toBeNull();
    expect(screen.queryByText("support_empty_title")).toBeNull();
  });

  it("does not show the empty state for a 403 either", () => {
    useSupportTicketsMock.mockReturnValue({
      tickets: undefined,
      error: new SupportRequestError(403, "forbidden"),
      isLoading: false,
    });
    render(<TicketList />);
    expect(screen.queryByText("support_empty_title")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("does not show the empty state while the lists have not arrived", () => {
    useSupportTicketsMock.mockReturnValue({ tickets: undefined, error: undefined, isLoading: false });
    render(<TicketList />);
    expect(screen.queryByText("support_empty_title")).toBeNull();
  });

  it("opens a ticket with Enter and Space on the row", () => {
    setLists([ticket({})]);
    render(<TicketList />);
    const row = screen.getByRole("button", { name: /Catchment area fails/ });
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pushMock).toHaveBeenLastCalledWith("/support/00031");
  });

  it("behaves like a missing page when support is off on this installation", () => {
    useSupportTicketsMock.mockReturnValue({
      tickets: undefined,
      error: { status: 404, detail: "not_found" },
      isLoading: false,
    });
    render(<TicketList />);
    expect(notFoundMock).toHaveBeenCalled();
  });
});

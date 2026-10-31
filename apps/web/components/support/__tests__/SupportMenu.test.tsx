import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { enGB } from "date-fns/locale";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportTicket } from "@/lib/validations/support";

import SupportMenu, {
  SupportMenuEntries,
  supportCountLabel,
  ticketsNeedingAttention,
  useReportProblemHref,
  useSupportCounts,
} from "@/components/support/SupportMenu";

const { useSupportSummaryMock, refreshMock, pushMock, profile } = vi.hoisted(() => ({
  useSupportSummaryMock: vi.fn(),
  refreshMock: vi.fn(),
  pushMock: vi.fn(),
  profile: { value: { id: "u1" } as { id: string } | undefined },
}));
const { language } = vi.hoisted(() => ({ language: { value: "en" } }));
vi.mock("@/lib/constants", () => ({
  DOCS_URL: "https://docs.example/docs",
  SUPPORT_MAILTO: "mailto:help@example.com?subject=Help",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: language.value },
    t: (key: string, o?: { count?: number }) => (o?.count !== undefined ? `${key}:${o.count}` : key),
  }),
}));
vi.mock("@/lib/api/support", () => ({
  useSupportSummary: useSupportSummaryMock,
  refreshSupportTickets: refreshMock,
}));
vi.mock("@/lib/api/users", () => ({ useUserProfile: () => ({ userProfile: profile.value }) }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => enGB }));
vi.mock("@/components/dashboard/common/CountPill", () => ({
  default: ({ children }: { children: ReactNode }) => <span data-testid="count-pill">{children}</span>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }), usePathname: () => "/map/abc" }));

const ticket = (ref: string, over: Partial<SupportTicket> = {}): SupportTicket => ({
  ref,
  subject: `Subject ${ref}`,
  status: "in_progress",
  category: "bug",
  impact: null,
  customer_name: "Me",
  customer_contact_id: null,
  is_mine: true,
  agent_name: "Anna",
  via: "app",
  created_at: "2026-09-30T10:00:00Z",
  updated_at: "2026-10-01T08:00:00Z",
  closed_at: null,
  latest_message_author: "Anna",
  latest_message_is_agent: true,
  latest_message_at: "2026-10-01T08:00:00Z",
  unread: false,
  needs_my_reply: false,
  ...over,
});

const summary = (needs_reply: number, unread: number) =>
  useSupportSummaryMock.mockReturnValue({ summary: { needs_reply, unread }, enabled: true });

const trigger = () => screen.getByRole("button", { name: /^support_title/ });

describe("supportCountLabel", () => {
  const t = (key: string, o: { count: number }) => `${key}:${o.count}`;
  it("prefers tickets to answer, then unread, else nothing", () => {
    expect(supportCountLabel(t, { needsReply: 2, unread: 3 })).toBe("support_to_answer:2");
    expect(supportCountLabel(t, { needsReply: 0, unread: 3 })).toBe("support_unread_count:3");
    expect(supportCountLabel(t, { needsReply: 0, unread: 0 })).toBeUndefined();
  });
});

describe("ticketsNeedingAttention", () => {
  it("lists tickets waiting on me first, then unread ones, at most three", () => {
    const list = [
      ticket("1", { unread: true }),
      ticket("2"),
      ticket("3", { needs_my_reply: true, unread: true }),
      ticket("4", { unread: true }),
      ticket("5", { unread: true }),
    ];
    expect(ticketsNeedingAttention(list).map((x) => x.ref)).toEqual(["3", "1", "4"]);
  });

  it("adds unread tickets closed in the last 14 days, as the badge counts them", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const closed = [
      ticket("10", { status: "solved", unread: true, closed_at: "2026-09-20T10:00:00Z" }),
      ticket("11", { status: "solved", unread: false, closed_at: "2026-09-30T10:00:00Z" }),
      ticket("12", {
        status: "solved",
        unread: true,
        closed_at: "2026-09-01T10:00:00Z",
        updated_at: "2026-09-01T10:00:00Z",
      }),
    ];
    const open = [ticket("1", { needs_my_reply: true, unread: true })];
    expect(ticketsNeedingAttention(open, closed, now).map((x) => x.ref)).toEqual(["1", "10"]);
  });
});

describe("SupportMenu", () => {
  beforeEach(() => {
    useSupportSummaryMock.mockReset();
    refreshMock.mockReset();
    refreshMock.mockResolvedValue([]);
    pushMock.mockReset();
    profile.value = { id: "u1" };
    language.value = "en";
  });

  it("only asks for the summary once a user is logged in", () => {
    useSupportSummaryMock.mockReturnValue({ summary: undefined, enabled: false });
    profile.value = undefined;
    render(<SupportMenu />);
    expect(useSupportSummaryMock).toHaveBeenLastCalledWith({ enabled: false });
    profile.value = { id: "u1" };
    render(<SupportMenu />);
    expect(useSupportSummaryMock).toHaveBeenLastCalledWith({ enabled: true });
  });

  it("without support tickets (404) offers an email and the docs, no ticket list, no badge", async () => {
    useSupportSummaryMock.mockReturnValue({ summary: undefined, enabled: false });
    const { container } = render(<SupportMenu />);
    expect(container.querySelector(".MuiBadge-dot")?.classList.contains("MuiBadge-invisible")).toBe(true);
    expect(screen.queryByText("2")).toBeNull();
    fireEvent.click(trigger());
    expect(screen.queryByText("support_tickets")).toBeNull();
    const report = screen.getByText("support_report_problem").closest("a");
    expect(report?.getAttribute("href")).toBe("mailto:help@example.com?subject=Help");
    expect(report?.getAttribute("target")).toBeNull();
    expect(screen.getByText("support_documentation").closest("a")?.getAttribute("target")).toBe("_blank");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("logged out: no summary request, still the email and the docs", () => {
    useSupportSummaryMock.mockReturnValue({ summary: undefined, enabled: false });
    profile.value = undefined;
    render(<SupportMenu />);
    expect(useSupportSummaryMock).toHaveBeenLastCalledWith({ enabled: false });
    fireEvent.click(trigger());
    expect(screen.getByText("support_report_problem").closest("a")?.getAttribute("href")).toMatch(/^mailto:/);
    expect(screen.getByText("support_documentation")).toBeTruthy();
    expect(screen.queryByText("support_tickets")).toBeNull();
  });

  it("swaps the email for the ticket form once support turns out to be on", () => {
    useSupportSummaryMock.mockReturnValue({ summary: undefined, enabled: false });
    const { rerender } = render(<SupportMenu />);
    fireEvent.click(trigger());
    expect(screen.getByText("support_report_problem").closest("a")).toBeTruthy();
    summary(0, 0);
    rerender(<SupportMenu />);
    expect(screen.getByText("support_report_problem").closest("a")).toBeNull();
    fireEvent.click(screen.getByText("support_report_problem"));
    expect(pushMock).toHaveBeenCalledWith("/support/new?from=%2Fmap%2Fabc");
  });

  it("shows the number of tickets to answer, even with unread ones", () => {
    summary(2, 3);
    const { container } = render(<SupportMenu />);
    expect(screen.getByText("2")).toBeTruthy();
    expect(container.querySelector(".MuiBadge-dot")).toBeNull();
    expect(trigger().getAttribute("aria-label")).toBe("support_title: support_to_answer:2");
  });

  it("shows a dot, no number, when tickets are only unread", () => {
    summary(0, 3);
    const { container } = render(<SupportMenu />);
    const dot = container.querySelector(".MuiBadge-dot");
    expect(dot).toBeTruthy();
    expect(dot?.classList.contains("MuiBadge-invisible")).toBe(false);
    expect(dot?.classList.contains("MuiBadge-colorPrimary")).toBe(true);
    expect(screen.queryByText("3")).toBeNull();
    expect(trigger().getAttribute("aria-label")).toBe("support_title: support_unread_count:3");
  });

  it("shows no badge when nothing is waiting", () => {
    summary(0, 0);
    const { container } = render(<SupportMenu />);
    expect(container.querySelector(".MuiBadge-dot")?.classList.contains("MuiBadge-invisible")).toBe(true);
    expect(trigger().getAttribute("aria-label")).toBe("support_title");
  });

  it("offers only the actions when nothing is waiting, without fetching tickets", () => {
    summary(0, 0);
    render(<SupportMenu />);
    fireEvent.click(trigger());
    expect(screen.getByText("support_tickets")).toBeTruthy();
    expect(screen.queryByTestId("count-pill")).toBeNull(); // no empty pill next to it
    expect(screen.getByText("support_documentation")).toBeTruthy();
    expect(refreshMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("support_report_problem"));
    expect(pushMock).toHaveBeenCalledWith("/support/new?from=%2Fmap%2Fabc");
  });

  it("lists the tickets that need attention when opened and navigates to one", async () => {
    summary(1, 2);
    refreshMock.mockImplementation(async (state: string) =>
      state === "open"
        ? [
            ticket("00070", { needs_my_reply: true, status: "waiting", unread: true }),
            ticket("00071", { unread: true }),
            ticket("00072"),
          ]
        : []
    );
    render(<SupportMenu />);
    expect(refreshMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(trigger());
    });
    await waitFor(() => expect(screen.getByText("Subject 00070")).toBeTruthy());
    expect(screen.getByText("Subject 00071")).toBeTruthy();
    expect(screen.queryByText("Subject 00072")).toBeNull();
    // The secondary line of the tickets action
    expect(screen.getByText("support_to_answer:1")).toBeTruthy();
    fireEvent.click(screen.getByText("Subject 00070"));
    expect(pushMock).toHaveBeenCalledWith("/support/00070");
  });

  it("lists an unread reply on a recently closed ticket and opens it", async () => {
    summary(0, 1);
    const closedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    refreshMock.mockImplementation(async (state: string) =>
      state === "closed"
        ? [ticket("00080", { status: "solved", unread: true, closed_at: closedAt, updated_at: closedAt })]
        : []
    );
    render(<SupportMenu />);
    await act(async () => {
      fireEvent.click(trigger());
    });
    expect(refreshMock.mock.calls.map(([state]) => state).sort()).toEqual(["closed", "open"]);
    await waitFor(() => expect(screen.getByText("Subject 00080")).toBeTruthy());
    fireEvent.click(screen.getByText("Subject 00080"));
    expect(pushMock).toHaveBeenCalledWith("/support/00080");
  });

  it("links the documentation in the popover, in the UI language", () => {
    language.value = "de";
    summary(0, 0);
    render(<SupportMenu />);
    fireEvent.click(trigger());
    const link = screen.getByText("support_documentation").closest("a");
    expect(link?.getAttribute("href")).toBe("https://docs.example/docs/de");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("opens the ticket list from the tickets action and closes on Escape", async () => {
    summary(0, 1);
    render(<SupportMenu />);
    fireEvent.click(trigger());
    expect(screen.getByText("support_unread_count:1")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("support_report_problem")).toBeNull());
    fireEvent.click(trigger());
    fireEvent.click(screen.getByText("support_tickets"));
    expect(pushMock).toHaveBeenCalledWith("/support");
  });
});

describe("SupportMenuEntries", () => {
  beforeEach(() => {
    pushMock.mockReset();
    language.value = "en";
  });

  it("carries the documentation link, in the UI language, opening in a new tab", () => {
    const onNavigate = vi.fn();
    const { unmount } = render(
      <SupportMenuEntries counts={{ needsReply: 0, unread: 0 }} onNavigate={onNavigate} />
    );
    const link = screen.getByText("support_documentation").closest("a");
    expect(link?.getAttribute("href")).toBe("https://docs.example/docs");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link as HTMLElement);
    expect(onNavigate).toHaveBeenCalled();
    unmount();
    language.value = "de";
    render(<SupportMenuEntries counts={{ needsReply: 0, unread: 0 }} onNavigate={onNavigate} />);
    expect(screen.getByText("support_documentation").closest("a")?.getAttribute("href")).toBe(
      "https://docs.example/docs/de"
    );
  });

  it("offers the same entries as user-menu rows for phones, with the count to answer", () => {
    const onNavigate = vi.fn();
    render(<SupportMenuEntries counts={{ needsReply: 2, unread: 3 }} onNavigate={onNavigate} />);
    expect(screen.getByText("support_to_answer:2")).toBeTruthy();
    fireEvent.click(screen.getByText("support_report_problem"));
    expect(onNavigate).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/support/new?from=%2Fmap%2Fabc");
    fireEvent.click(screen.getByText("support_tickets"));
    expect(pushMock).toHaveBeenLastCalledWith("/support");
  });

  it("without support tickets only offers the email and the docs", () => {
    render(<SupportMenuEntries counts={null} onNavigate={vi.fn()} />);
    expect(screen.queryByText("support_tickets")).toBeNull();
    expect(screen.getByText("support_report_problem").closest("a")?.getAttribute("href")).toMatch(/^mailto:/);
    expect(screen.getByText("support_documentation")).toBeTruthy();
  });

  it("falls back to the unread count and shows no pill when nothing is waiting", () => {
    const { rerender } = render(
      <SupportMenuEntries counts={{ needsReply: 0, unread: 4 }} onNavigate={vi.fn()} />
    );
    expect(screen.getByText("support_unread_count:4")).toBeTruthy();
    rerender(<SupportMenuEntries counts={{ needsReply: 0, unread: 0 }} onNavigate={vi.fn()} />);
    expect(screen.queryByText(/support_unread_count|support_to_answer/)).toBeNull();
  });
});

describe("useSupportCounts", () => {
  const Probe = () => <span data-testid="c">{JSON.stringify(useSupportCounts(true))}</span>;
  it("is null while support is off and carries both counts otherwise", () => {
    useSupportSummaryMock.mockReturnValue({ summary: undefined, enabled: false });
    const { rerender } = render(<Probe />);
    expect(screen.getByTestId("c").textContent).toBe("null");
    summary(1, 2);
    rerender(<Probe />);
    expect(JSON.parse(screen.getByTestId("c").textContent ?? "")).toEqual({ needsReply: 1, unread: 2 });
  });
});

describe("useReportProblemHref", () => {
  const Probe = () => <span data-testid="href">{String(useReportProblemHref())}</span>;
  it("leads where Report a problem does: the ticket form from this page, else the support email", () => {
    summary(0, 0);
    const { rerender } = render(<Probe />);
    expect(screen.getByTestId("href").textContent).toBe("/support/new?from=%2Fmap%2Fabc");
    useSupportSummaryMock.mockReturnValue({ summary: undefined, enabled: false });
    rerender(<Probe />);
    expect(screen.getByTestId("href").textContent).toBe("mailto:help@example.com?subject=Help");
  });
});

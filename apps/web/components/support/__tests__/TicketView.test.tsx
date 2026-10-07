import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SupportRequestError } from "@/lib/api/support";
import type { SupportTicketDetail } from "@/lib/validations/support";

import TicketView from "@/components/support/TicketView";

const m = vi.hoisted(() => ({
  useSupportTicket: vi.fn(),
  postSupportReply: vi.fn(),
  resolveSupportTicket: vi.fn(),
  rateSupportTicket: vi.fn(),
  updateSupportFollowers: vi.fn(),
  mutate: vi.fn(),
  globalMutate: vi.fn(),
  push: vi.fn(),
  reopenSupportTicket: vi.fn(),
  toastError: vi.fn(),
  colleagues: vi.fn(),
  forgetSupportLists: vi.fn(),
}));
const i18n = vi.hoisted(() => ({ language: "en" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { agent?: string }) => (o?.agent ? `${k}:${o.agent}` : k),
    i18n,
  }),
}));
vi.mock("@/lib/api/users", () => ({ useUserProfile: () => ({ userProfile: { id: "u1" } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: m.globalMutate }) }));
vi.mock("react-toastify", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: m.toastError },
}));
vi.mock("@/lib/api/support", () => ({
  SUPPORT_API_BASE_URL: "http://core/api/v2/support",
  SupportRequestError: class extends Error {
    constructor(
      public status: number,
      public detail: string
    ) {
      super(detail);
    }
  },
  useSupportTicket: m.useSupportTicket,
  postSupportReply: m.postSupportReply,
  resolveSupportTicket: m.resolveSupportTicket,
  reopenSupportTicket: m.reopenSupportTicket,
  forgetSupportLists: m.forgetSupportLists,
  rateSupportTicket: m.rateSupportTicket,
  updateSupportFollowers: m.updateSupportFollowers,
  downloadSupportAttachment: vi.fn(),
  useSupportColleagues: () => ({ colleagues: m.colleagues() }),
}));

const detail = (
  o: Partial<SupportTicketDetail["ticket"]> = {},
  extra: Partial<SupportTicketDetail> = {}
): SupportTicketDetail => ({
  ticket: {
    ref: "00031",
    subject: "Catchment area fails",
    status: "waiting",
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
    needs_my_reply: true,
    ...o,
  },
  messages: [
    {
      id: 60,
      author_name: "Marco",
      author_known: true,
      is_agent: false,
      is_me: true,
      via: "app",
      created_at: "2026-09-28T09:00:00Z",
      body_html: "<p>It fails</p>",
      attachments: [],
    },
    {
      id: 62,
      author_contact_id: 300,
      author_name: "Lena",
      author_known: true,
      is_agent: true,
      is_me: false,
      via: "email",
      created_at: "2026-09-29T09:00:00Z",
      body_html: '<p>Fix soon</p><div data-o-mail-quote="1">-- Lena signature</div>',
      attachments: [],
    },
  ],
  followers: [{ contact_id: 101, name: "Anna", is_me: false }],
  on_ticket: true,
  can_manage_people: true,
  avatars: {},
  agent_contact_id: 300,
  my_rating: null,
  ...extra,
});

describe("TicketView", () => {
  beforeEach(() => {
    Object.values(m).forEach((f) => f.mockReset());
    m.colleagues.mockReturnValue([]);
    i18n.language = "en";
  });

  it("renders the thread with quoted text folded and the waiting banner", () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("It fails")).toBeTruthy();
    expect(screen.getByText("Fix soon")).toBeTruthy();
    expect(screen.queryByText("-- Lena signature")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "support_show_quoted" }));
    expect(screen.getByText("-- Lena signature")).toBeTruthy();
    expect(screen.getByText("support_waiting_banner:Lena")).toBeTruthy();
  });

  describe("team photos", () => {
    const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const show = (avatars: Record<string, string>) => {
      m.useSupportTicket.mockReturnValue({
        ticket: detail({}, { avatars }),
        mutate: m.mutate,
        isLoading: false,
      });
      render(<TicketView ticketRef="00031" />);
    };

    it("shows an agent's photo on their messages and in Handled by, not the customer's", () => {
      show({ "300": JPEG, "100": "data:image/png;base64,AAAA" });
      // message author + the "Handled by" row
      const lena = screen.getAllByRole("img", { name: "Lena" });
      expect(lena).toHaveLength(2);
      lena.forEach((img) => expect(img.getAttribute("src")).toBe(JPEG));
      expect(screen.queryByRole("img", { name: "Marco" })).toBeNull();
    });

    it("shows the handler's photo in Handled by before they have written anything", () => {
      m.useSupportTicket.mockReturnValue({
        ticket: detail({}, { avatars: { "300": JPEG }, messages: [detail().messages[0]] }),
        mutate: m.mutate,
        isLoading: false,
      });
      render(<TicketView ticketRef="00031" />);
      const lena = screen.getAllByRole("img", { name: "Lena" });
      expect(lena).toHaveLength(1);
      expect(lena[0].getAttribute("src")).toBe(JPEG);
    });

    it("does not guess the handler's photo from a team message with the same name", () => {
      m.useSupportTicket.mockReturnValue({
        ticket: detail({}, { avatars: { "300": JPEG }, agent_contact_id: null }),
        mutate: m.mutate,
        isLoading: false,
      });
      render(<TicketView ticketRef="00031" />);
      // only the message author's photo; Handled by has no contact to show one for
      expect(screen.getAllByRole("img", { name: "Lena" })).toHaveLength(1);
    });

    it("falls back to initials when there is no photo", () => {
      show({});
      expect(screen.queryByRole("img", { name: "Lena" })).toBeNull();
      expect(screen.getAllByText("L").length).toBeGreaterThan(0);
    });

    it("ignores a value that is not an image data URI", () => {
      show({ "300": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
      expect(screen.queryByRole("img", { name: "Lena" })).toBeNull();
      cleanup();
      show({ "300": "https://evil.example/x.png" });
      expect(screen.queryByRole("img", { name: "Lena" })).toBeNull();
    });
  });

  it("labels a message whose sender was deleted as unknown", () => {
    const base = detail().messages[0];
    m.useSupportTicket.mockReturnValue({
      ticket: detail(
        {},
        {
          messages: [
            base,
            {
              ...base,
              id: 63,
              author_name: "",
              author_known: false,
              is_me: false,
              body_html: "<p>From a deleted contact</p>",
            },
          ],
        }
      ),
      mutate: m.mutate,
      isLoading: false,
    });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("From a deleted contact")).toBeTruthy();
    expect(screen.getByText("support_unknown_author")).toBeTruthy();
  });

  it("names the agent who wrote the latest message in the banner", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ latest_message_author: "Jonas", latest_message_is_agent: true }),
      mutate: m.mutate,
      isLoading: false,
    });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("support_waiting_banner:Jonas")).toBeTruthy();
  });

  it("names the team, not the handler, when no agent wrote the latest message", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ latest_message_author: "Anna", latest_message_is_agent: false }),
      mutate: m.mutate,
      isLoading: false,
    });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("support_waiting_banner_team")).toBeTruthy();
    expect(screen.queryByText("support_waiting_banner:Lena")).toBeNull();
  });

  it("keeps the reply draft per user and ticket", () => {
    localStorage.clear();
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    render(<TicketView ticketRef="00031" />);
    fireEvent.change(screen.getByPlaceholderText("support_reply_placeholder"), {
      target: { value: "Half written" },
    });
    expect(localStorage.getItem("goat:support:draft:reply:u1:00031")).toBe('"Half written"');
    expect(localStorage.getItem("goat:support:draft:reply:00031")).toBeNull();
  });

  it("limits a reply to the length core accepts", () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    render(<TicketView ticketRef="00031" />);
    const box = screen.getByPlaceholderText("support_reply_placeholder") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(50000);
  });

  it("renders the description (id 0) and a second id-0 message without duplicate keys", () => {
    const base = detail().messages[0];
    m.useSupportTicket.mockReturnValue({
      ticket: detail(
        {},
        {
          messages: [
            { ...base, id: 0, body_html: "<p>Description</p>" },
            { ...base, id: 0, body_html: "<p>Other</p>" },
          ],
        }
      ),
      mutate: m.mutate,
      isLoading: false,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("Description")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    spy.mockRestore();
  });

  it("links back to the list with a text button", () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    render(<TicketView ticketRef="00031" />);
    const back = screen.getByRole("button", { name: "support_title" });
    expect(back.className).toContain("MuiButton-text");
    fireEvent.click(back);
    expect(m.push).toHaveBeenCalledWith("/support");
  });

  it("sends a reply and clears the composer", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    m.postSupportReply.mockResolvedValue({ ref: "00031", message_id: 70, failed_files: [] });
    render(<TicketView ticketRef="00031" />);
    const box = screen.getByPlaceholderText("support_reply_placeholder") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Thanks!" } });
    fireEvent.click(screen.getByRole("button", { name: "support_send" }));
    await waitFor(() => expect(m.postSupportReply).toHaveBeenCalledWith("00031", "Thanks!", []));
    await waitFor(() => expect(box.value).toBe(""));
    expect(m.mutate).toHaveBeenCalled();
    // the lists and the badge change with a reply: the list page must not show the old state
    expect(m.forgetSupportLists).toHaveBeenCalled();
  });

  it("offers a rating on resolved tickets", async () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ status: "solved", needs_my_reply: false }),
      mutate: m.mutate,
      isLoading: false,
    });
    m.rateSupportTicket.mockResolvedValue(undefined);
    render(<TicketView ticketRef="00031" />);
    fireEvent.click(screen.getByRole("button", { name: "support_rating_top" }));
    fireEvent.click(screen.getByRole("button", { name: "support_send_feedback" }));
    await waitFor(() => expect(m.rateSupportTicket).toHaveBeenCalledWith("00031", "top", ""));
    expect(await screen.findByText("support_feedback_thanks")).toBeTruthy();
  });

  describe("rating", () => {
    const solved = (extra: Partial<SupportTicketDetail> = {}) =>
      m.useSupportTicket.mockReturnValue({
        ticket: detail({ status: "solved", needs_my_reply: false }, extra),
        mutate: m.mutate,
        isLoading: false,
      });

    it("shows the thanks with the earlier rating instead of the form", () => {
      solved({ my_rating: "ok" });
      render(<TicketView ticketRef="00031" />);
      expect(screen.getByText("support_feedback_thanks")).toBeTruthy();
      expect(screen.getByText("support_rating_ok")).toBeTruthy();
      expect(screen.queryByText("support_rate_question")).toBeNull();
      expect(screen.queryByRole("button", { name: "support_rating_top" })).toBeNull();
      expect(screen.getByRole("button", { name: "support_rating_change" })).toBeTruthy();
    });

    it("asks when the ticket was not rated yet", () => {
      solved({ my_rating: null });
      render(<TicketView ticketRef="00031" />);
      expect(screen.getByText("support_rate_question")).toBeTruthy();
      expect(screen.queryByText("support_feedback_thanks")).toBeNull();
      expect(screen.queryByRole("button", { name: "support_rating_change" })).toBeNull();
    });

    it("reopens the form on Change and shows the new rating once sent", async () => {
      solved({ my_rating: "ok" });
      m.rateSupportTicket.mockResolvedValue(undefined);
      render(<TicketView ticketRef="00031" />);
      fireEvent.click(screen.getByRole("button", { name: "support_rating_change" }));
      expect(screen.getByText("support_rate_question")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "support_rating_top" }));
      fireEvent.click(screen.getByRole("button", { name: "support_send_feedback" }));
      await waitFor(() => expect(m.rateSupportTicket).toHaveBeenCalledWith("00031", "top", ""));
      expect(await screen.findByText("support_feedback_thanks")).toBeTruthy();
      expect(screen.getByText("support_rating_top")).toBeTruthy();
      expect(screen.queryByText("support_rating_ok")).toBeNull();
      expect(screen.queryByText("support_rate_question")).toBeNull();
    });

    it("shows the rating just sent on a ticket that was not rated before", async () => {
      solved({ my_rating: null });
      m.rateSupportTicket.mockResolvedValue(undefined);
      render(<TicketView ticketRef="00031" />);
      fireEvent.click(screen.getByRole("button", { name: "support_rating_ko" }));
      fireEvent.click(screen.getByRole("button", { name: "support_send_feedback" }));
      expect(await screen.findByText("support_feedback_thanks")).toBeTruthy();
      expect(screen.getByText("support_rating_ko")).toBeTruthy();
    });

    it("keeps the form open when a changed rating fails to send", async () => {
      solved({ my_rating: "ok" });
      m.rateSupportTicket.mockRejectedValue(new SupportRequestError(503, ""));
      render(<TicketView ticketRef="00031" />);
      fireEvent.click(screen.getByRole("button", { name: "support_rating_change" }));
      fireEvent.click(screen.getByRole("button", { name: "support_rating_top" }));
      fireEvent.click(screen.getByRole("button", { name: "support_send_feedback" }));
      await waitFor(() => expect(m.toastError).toHaveBeenCalled());
      expect(screen.getByText("support_rate_question")).toBeTruthy();
    });

    it("shows no rating to admins who are not on the ticket", () => {
      solved({ on_ticket: false, my_rating: null });
      render(<TicketView ticketRef="00031" />);
      expect(screen.queryByText("support_feedback_thanks")).toBeNull();
    });
  });

  it("shows not found", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: undefined,
      error: { status: 404, detail: "" },
      isLoading: false,
    });
    render(<TicketView ticketRef="99999" />);
    expect(screen.getByText("support_not_found")).toBeTruthy();
  });
  it("formats dates with the UI language", () => {
    i18n.language = "de";
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    render(<TicketView ticketRef="00031" />);
    // 2026-09-28 is a Monday: German day and month names, not "Mon"/"Sep".
    expect(screen.getAllByText(/^Mo\.? 28 Sept?\.?, /).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Mon 28/)).toBeNull();
  });

  it("revalidates the header summary once the ticket is loaded", () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    render(<TicketView ticketRef="00031" />);
    expect(m.globalMutate).toHaveBeenCalledWith("http://core/api/v2/support/summary");
  });

  it("does not revalidate the summary while the ticket is loading", () => {
    m.useSupportTicket.mockReturnValue({ ticket: undefined, isLoading: true });
    render(<TicketView ticketRef="00031" />);
    expect(m.globalMutate).not.toHaveBeenCalled();
  });

  it("drops the cached lists after resolving, so the list page shows the new state", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    m.resolveSupportTicket.mockResolvedValue(undefined);
    render(<TicketView ticketRef="00031" />);
    fireEvent.click(screen.getByRole("button", { name: "support_mark_resolved" }));
    await waitFor(() => expect(m.forgetSupportLists).toHaveBeenCalled());
    expect(m.mutate).toHaveBeenCalled();
  });

  it("toasts the error when resolving fails", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    m.resolveSupportTicket.mockRejectedValue(new SupportRequestError(503, ""));
    render(<TicketView ticketRef="00031" />);
    fireEvent.click(screen.getByRole("button", { name: "support_mark_resolved" }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith("support_unavailable"));
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it("toasts the error when the rating fails", async () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ status: "solved", needs_my_reply: false }),
      mutate: m.mutate,
      isLoading: false,
    });
    m.rateSupportTicket.mockRejectedValue(new SupportRequestError(403, "forbidden"));
    render(<TicketView ticketRef="00031" />);
    fireEvent.click(screen.getByRole("button", { name: "support_rating_ok" }));
    fireEvent.click(screen.getByRole("button", { name: "support_send_feedback" }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith("support_forbidden"));
  });

  it("toasts the error when a reply fails and keeps the text", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    m.postSupportReply.mockRejectedValue(new SupportRequestError(429, ""));
    render(<TicketView ticketRef="00031" />);
    const box = screen.getByPlaceholderText("support_reply_placeholder") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Thanks!" } });
    fireEvent.click(screen.getByRole("button", { name: "support_send" }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith("support_rate_limited"));
    expect(box.value).toBe("Thanks!");
  });

  it("offers no rating to admins who are not on the ticket, but still shows the notice", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ status: "solved", needs_my_reply: false }, { on_ticket: false }),
      mutate: m.mutate,
      isLoading: false,
    });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("support_resolved_title")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "support_rating_top" })).toBeNull();
    expect(screen.queryByText("support_rate_question")).toBeNull();
  });

  it("leaves for the ticket list after removing yourself from the followers", async () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail(
        {},
        { followers: [{ contact_id: 7, name: "Marco", is_me: true }], can_manage_people: false }
      ),
      mutate: m.mutate,
      isLoading: false,
    });
    m.updateSupportFollowers.mockResolvedValue(undefined);
    render(<TicketView ticketRef="00031" />);
    fireEvent.click(screen.getByRole("button", { name: "support_remove Marco" }));
    await waitFor(() => expect(m.push).toHaveBeenCalledWith("/support"));
    expect(m.updateSupportFollowers).toHaveBeenCalledWith("00031", { remove_contact_ids: [7] });
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it("refetches after removing someone else", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    m.updateSupportFollowers.mockResolvedValue(undefined);
    render(<TicketView ticketRef="00031" />);
    fireEvent.click(screen.getByRole("button", { name: "support_remove Anna" }));
    await waitFor(() => expect(m.mutate).toHaveBeenCalled());
    expect(m.push).not.toHaveBeenCalled();
  });

  it("toasts the error when changing followers fails", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    m.updateSupportFollowers.mockRejectedValue(new SupportRequestError(500, ""));
    render(<TicketView ticketRef="00031" />);
    fireEvent.click(screen.getByRole("button", { name: "support_remove Anna" }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith("support_unavailable"));
    expect(m.push).not.toHaveBeenCalled();
  });
  it("does not list the ticket's customer among the followers", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ is_mine: false, customer_name: "Marco" }),
      mutate: m.mutate,
      isLoading: false,
    });
    m.colleagues.mockReturnValue([{ user_id: "u1", name: "Marco", email: "m@x.de", contact_id: 100 }]);
    render(<TicketView ticketRef="00031" />);
    // The server leaves the customer out of the followers: only Anna gets a remove button.
    expect(screen.getAllByRole("button", { name: /^support_remove / })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "support_remove Marco" })).toBeNull();
  });

  it("does not offer the ticket's customer as a colleague to add", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ is_mine: false, customer_name: "Marco" }),
      mutate: m.mutate,
      isLoading: false,
    });
    m.colleagues.mockReturnValue([
      { user_id: "u1", name: "Marco", email: "m@x.de", contact_id: 100 },
      { user_id: "u2", name: "Berta", email: "b@x.de", contact_id: null },
    ]);
    render(<TicketView ticketRef="00031" />);
    fireEvent.mouseDown(screen.getByPlaceholderText("support_add_colleague"));
    expect(screen.getByRole("option", { name: /^Berta/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^Marco/ })).toBeNull();
  });

  it("tells colleagues with the same name apart by contact and email", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail({ is_mine: false }),
      mutate: m.mutate,
      isLoading: false,
    });
    // two people called "Test Test": one already follows (Anna's contact 101 in the fixture)
    m.colleagues.mockReturnValue([
      { user_id: "u1", name: "Test Test", email: "one@x.de", contact_id: 101 },
      { user_id: "u2", name: "Test Test", email: "two@x.de", contact_id: 102 },
    ]);
    render(<TicketView ticketRef="00031" />);
    fireEvent.mouseDown(screen.getByPlaceholderText("support_add_colleague"));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("two@x.de");
  });

  it("keeps the thread when a refetch fails but data is present", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: detail(),
      error: { status: 503, detail: "" },
      mutate: m.mutate,
      isLoading: false,
    });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("It fails")).toBeTruthy();
    expect(screen.queryByText("support_unavailable")).toBeNull();
  });

  it("shows the unavailable alert for any other error without data", () => {
    m.useSupportTicket.mockReturnValue({
      ticket: undefined,
      error: { status: 403, detail: "" },
      isLoading: false,
    });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByText("support_unavailable")).toBeTruthy();
  });

  it("shows a spinner while loading without data", () => {
    m.useSupportTicket.mockReturnValue({ ticket: undefined, isLoading: true });
    render(<TicketView ticketRef="00031" />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("disables resolve while the request runs and ignores a second click", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    let finish: () => void = () => {};
    m.resolveSupportTicket.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<TicketView ticketRef="00031" />);
    const button = screen.getByRole("button", { name: "support_mark_resolved" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(m.resolveSupportTicket).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("disables the composer while a reply is sending", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    let finish: (v: unknown) => void = () => {};
    m.postSupportReply.mockReturnValue(new Promise((r) => (finish = r)));
    render(<TicketView ticketRef="00031" />);
    const box = screen.getByPlaceholderText("support_reply_placeholder") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Thanks!" } });
    fireEvent.click(screen.getByRole("button", { name: "support_send" }));
    await waitFor(() => expect(box.disabled).toBe(true));
    finish({ ref: "00031", message_id: 70, failed_files: [] });
    await waitFor(() => expect(box.disabled).toBe(false));
  });

  it("disables the remove buttons while a follower change runs", async () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    let finish: () => void = () => {};
    m.updateSupportFollowers.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<TicketView ticketRef="00031" />);
    const button = screen.getByRole("button", { name: "support_remove Anna" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(m.updateSupportFollowers).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("marks the quoted-text toggle as expanded once opened", () => {
    m.useSupportTicket.mockReturnValue({ ticket: detail(), mutate: m.mutate, isLoading: false });
    render(<TicketView ticketRef="00031" />);
    const toggle = screen.getByRole("button", { name: "support_show_quoted" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

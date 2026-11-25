import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ApiError } from "@/lib/api/apiError";

import {
  AddDomainDialog,
  RECHECK_EVERY_MS,
} from "@/components/settings/whiteLabel/AddDomain/AddDomainDialog";

const api = vi.hoisted(() => ({ createCustomDomain: vi.fn(), recheckCustomDomain: vi.fn() }));
vi.mock("@/lib/api/customDomains", () => ({
  createCustomDomain: api.createCustomDomain,
  recheckCustomDomain: api.recheckCustomDomain,
}));
vi.mock("@/lib/api/customDomainConfig", () => ({
  useCustomDomainConfig: () => ({ cname_target: "custom.goat.example", apex_ipv4: "203.0.113.7" }),
}));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PENDING = {
  id: "d1",
  organization_id: "org-1",
  base_domain: "karten.stadt.example",
  kind: "single" as const,
  dns_status: "pending" as const,
  dns_status_message: null,
  dns_last_checked_at: null,
  cert_status: "pending" as const,
  cert_status_message: null,
  created_at: "2026-11-01T10:00:00Z",
};

const i18n = commonI18n("en");
const dialog = (onClose: () => void, onCreated?: () => void, open = true) => (
  <I18nextProvider i18n={i18n}>
    <AddDomainDialog open={open} onClose={onClose} organizationId="org-1" onCreated={onCreated} />
  </I18nextProvider>
);
const INVALID = "That is not a valid domain name, for example maps.your-city.example.";
const WWW = "A www subdomain is not possible.";

/** Types the domain and goes on. Under the fake clock React may render the
 * validation's answer a tick later: "Weiter" is waited for, not assumed. */
const goOn = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(/^Domain name/), "karten.stadt.example");
  const next = screen.getByRole("button", { name: "Next" });
  await waitFor(async () => {
    await expect(next).toBeEnabled();
  });
  await user.click(next);
};

/** Fake clock, a domain created, the DNS step open. */
const openDnsStep = async (onClose = vi.fn()) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.createCustomDomain.mockResolvedValue(PENDING);
  api.recheckCustomDomain.mockResolvedValue({ ...PENDING });
  const view = render(dialog(onClose));
  await goOn(user);
  await screen.findByText("Create the DNS record");
  return { ...view, user, onClose };
};
const advanceOneInterval = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS);
  });
const renderDialog = (onClose = vi.fn()) => {
  render(dialog(onClose));
  return onClose;
};

describe("AddDomainDialog", () => {
  beforeEach(() => {
    api.createCustomDomain.mockReset();
    api.recheckCustomDomain.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("asks for a domain, explaining a main domain and refusing www once the field is left", async () => {
    renderDialog();
    const next = screen.getByRole("button", { name: "Next" });
    await expect(next).toBeDisabled();
    const field = screen.getByLabelText(/^Domain name/);
    // Not on the first keystroke: a half typed name is not a mistake yet.
    await userEvent.type(field, "s");
    expect(screen.queryByText(INVALID)).toBeNull();
    await userEvent.type(field, "tadt.example");
    expect(screen.getByText("Main domain detected: you need an A record for it.")).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "www.stadt.example");
    expect(screen.queryByText(WWW)).toBeNull();
    await userEvent.tab();
    expect(screen.getByText(WWW)).toBeInTheDocument();
    await expect(next).toBeDisabled();
  });

  it("says what is wrong when Enter is pressed on a name that is not valid", async () => {
    renderDialog();
    await userEvent.type(screen.getByLabelText(/^Domain name/), "www.stadt.example{Enter}");
    expect(screen.getByText(WWW)).toBeInTheDocument();
    expect(api.createCustomDomain).not.toHaveBeenCalled();
  });

  it("names the domain under the title of the DNS step", async () => {
    api.createCustomDomain.mockResolvedValue(PENDING);
    renderDialog();
    await userEvent.type(screen.getByLabelText(/^Domain name/), "karten.stadt.example{Enter}");
    const title = await screen.findByText("Create the DNS record");
    expect(within(title.parentElement as HTMLElement).getByText("karten.stadt.example")).toBeInTheDocument();
    expect(screen.getAllByText("karten.stadt.example")).toHaveLength(1);
  });

  it("checks no more once it is closed", async () => {
    const { rerender, onClose } = await openDnsStep();
    rerender(dialog(onClose, undefined, false));
    await advanceOneInterval();
    expect(api.recheckCustomDomain).not.toHaveBeenCalled();
  });

  it("checks no more after Done, even while the page still shows it", async () => {
    const { user, onClose } = await openDnsStep();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
    await advanceOneInterval();
    expect(api.recheckCustomDomain).not.toHaveBeenCalled();
  });

  it("checks no more once it is unmounted", async () => {
    const { unmount } = await openDnsStep();
    unmount();
    await advanceOneInterval();
    expect(api.recheckCustomDomain).not.toHaveBeenCalled();
  });

  it("names a domain that is registered already (409) at the field", async () => {
    api.createCustomDomain.mockRejectedValue(
      new ApiError(409, "domain 'karten.stadt.example' is already registered")
    );
    renderDialog();
    await userEvent.type(screen.getByLabelText(/^Domain name/), "karten.stadt.example{Enter}");
    expect(await screen.findByText("This domain is already registered.")).toBeInTheDocument();
    expect(api.createCustomDomain).toHaveBeenCalledTimes(1);
    expect(api.createCustomDomain).toHaveBeenCalledWith("org-1", "karten.stadt.example");
  });

  it("asks core to check every 30 seconds while the DNS step is open, and moves on once DNS is confirmed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    api.createCustomDomain.mockResolvedValue(PENDING);
    api.recheckCustomDomain
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce({ ...PENDING, dns_status: "verified", cert_status: "issuing" });
    renderDialog();
    await goOn(user);
    expect(await screen.findByText("Create the DNS record")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent("DNS record");
    expect(api.recheckCustomDomain).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS);
    });
    expect(api.recheckCustomDomain).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS);
    });
    expect(api.recheckCustomDomain).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("DNS confirmed")).toBeInTheDocument();
  });

  it("keeps its 30-second clock when the page renders it again with a new callback", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    api.createCustomDomain.mockResolvedValue(PENDING);
    api.recheckCustomDomain.mockResolvedValue({ ...PENDING });
    const onClose = vi.fn();
    const { rerender } = render(dialog(onClose, () => undefined));
    await goOn(user);
    await screen.findByText("Create the DNS record");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS - 10_000);
    });
    // The page passes an inline `onCreated`: every render of it is a new one.
    rerender(dialog(onClose, () => undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.recheckCustomDomain).toHaveBeenCalledTimes(1);
  });

  it("checks at once on Check now, and Done closes", async () => {
    api.createCustomDomain.mockResolvedValue(PENDING);
    api.recheckCustomDomain.mockResolvedValue(PENDING);
    const onClose = renderDialog();
    await userEvent.type(screen.getByLabelText(/^Domain name/), "karten.stadt.example{Enter}");
    await screen.findByText("Create the DNS record");
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(api.recheckCustomDomain).toHaveBeenCalledWith("org-1", "d1");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});

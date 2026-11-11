import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import AiPage from "@/app/(dashboard)/settings/ai/page";

const api = vi.hoisted(() => ({
  settings: undefined as Record<string, unknown> | undefined,
  /** SWR's isLoading, when a test sets it (an automatic retry after an error). */
  settingsLoading: undefined as boolean | undefined,
  error: undefined as unknown,
  connections: [] as Record<string, unknown>[],
  connectionsLoading: false,
  connectionsError: undefined as unknown,
  connectionsEnabled: undefined as boolean | undefined,
  billing: true,
  balance: { used_ai_credits: 412, total_ai_credits: 2000 } as Record<string, unknown> | undefined,
  balanceError: undefined as unknown,
  mutate: vi.fn(),
  mutateConnections: vi.fn(),
  mutateBalance: vi.fn(),
  updateAssistantSettings: vi.fn(),
  testAssistantConnection: vi.fn(),
  deleteAssistantConnection: vi.fn(),
  createAssistantConnection: vi.fn(),
  refreshAssistantStatus: vi.fn(),
  undo: undefined as undefined | (() => Promise<unknown>),
  undoMessage: "",
}));

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));
vi.mock("@/lib/toasts", () => ({
  undoToast: (message: string, onUndo: () => Promise<unknown>) => {
    api.undoMessage = message;
    api.undo = onUndo;
  },
}));
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: { billing: api.billing } }) }));
vi.mock("@/lib/api/usage", () => ({
  useCreditBalance: (enabled: boolean) => ({
    balance: enabled ? api.balance : undefined,
    isError: enabled ? api.balanceError : undefined,
    mutate: api.mutateBalance,
  }),
}));
vi.mock("@/lib/api/assistant", () => ({
  useAssistantSettings: () => ({
    settings: api.settings,
    isLoading: api.settingsLoading ?? (!api.settings && !api.error),
    error: api.error,
    mutate: api.mutate,
  }),
  // As SWR with a null key: nothing is read while `enabled` is false.
  useAssistantConnections: (enabled: boolean) => {
    api.connectionsEnabled = enabled;
    return {
      connections: enabled ? api.connections : [],
      isLoading: enabled && api.connectionsLoading,
      error: enabled ? api.connectionsError : undefined,
      mutate: api.mutateConnections,
    };
  },
  updateAssistantSettings: api.updateAssistantSettings,
  testAssistantConnection: api.testAssistantConnection,
  deleteAssistantConnection: api.deleteAssistantConnection,
  refreshAssistantStatus: api.refreshAssistantStatus,
  createAssistantConnection: api.createAssistantConnection,
  updateAssistantConnection: vi.fn(),
  AssistantApiError: class extends Error {},
}));

const SETTINGS = {
  enabled: true,
  active_connection_id: null,
  data_policy: "standard",
  allow_default_fallback: false,
  status: "ok",
  instance: {
    goat_ai: {
      available: true,
      provider: "bedrock",
      model: "eu.anthropic.claude-sonnet-4-5",
      hosted_in: "EU",
    },
    org_connections: true,
    secrets_key_configured: true,
    allowed_providers: ["openai_compatible"],
    private_endpoints: false,
  },
};
const CONNECTION = {
  id: "c1",
  name: "Own vLLM",
  provider: "openai_compatible",
  base_url: "https://llm.example.org/v1",
  region: null,
  model: "qwen3",
  provider_order: [],
  allow_fallbacks: true,
  key_last4: "1234",
  credentials_readable: true,
  capabilities: {},
  tested_model: true,
  last_test_at: null,
  last_test_ok: true,
  last_test_error: null,
  active: false,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

const page = () => (
  <I18nextProvider i18n={commonI18n("en")}>
    <AiPage />
  </I18nextProvider>
);
const renderPage = () => render(page());
const choices = () => screen.getByRole("radiogroup", { name: "What the assistant answers with" });
const aiSwitch = () => screen.getByRole("switch", { name: "AI for this organization" });
const FALLBACK = "Fall back to GOAT AI if your provider fails";

/** A promise the test settles, to look at the page while a request runs. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("AI page", () => {
  beforeEach(() => {
    api.settings = SETTINGS;
    api.error = undefined;
    api.settingsLoading = undefined;
    api.connections = [CONNECTION];
    api.connectionsLoading = false;
    api.connectionsError = undefined;
    api.billing = true;
    api.balance = { used_ai_credits: 412, total_ai_credits: 2000 };
    api.balanceError = undefined;
    for (const fn of [
      api.mutate,
      api.mutateConnections,
      api.mutateBalance,
      api.updateAssistantSettings,
      api.refreshAssistantStatus,
      api.deleteAssistantConnection,
    ]) {
      fn.mockReset().mockResolvedValue(undefined);
    }
    api.testAssistantConnection.mockReset();
    api.createAssistantConnection.mockReset();
    api.undo = undefined;
    api.undoMessage = "";
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.info).mockReset();
  });

  it("shows GOAT AI with where it is hosted only, never its model", async () => {
    renderPage();
    const goatAi = within(choices()).getByRole("radio", { name: /^GOAT AI \(included\)/ });
    await expect(goatAi).toHaveAttribute("aria-checked", "true");
    expect(goatAi).toHaveTextContent("Hosted in the EU");
    expect(goatAi).toHaveTextContent("Active");
    expect(screen.queryByText(/claude-sonnet/)).toBeNull();
    expect(screen.queryByText(/Bedrock/)).toBeNull();
  });

  it("shows no model either where the instance names no hosting place", async () => {
    api.settings = {
      ...SETTINGS,
      instance: {
        ...SETTINGS.instance,
        goat_ai: { ...SETTINGS.instance.goat_ai, provider: null, hosted_in: null },
      },
    };
    renderPage();
    const goatAi = within(choices()).getByRole("radio", { name: /^GOAT AI \(included\)/ });
    await expect(goatAi).toHaveAttribute("aria-checked", "true");
    expect(goatAi).not.toHaveTextContent("Hosted in");
    expect(screen.queryByText(/claude-sonnet/)).toBeNull();
  });

  it("shows an own connection's provider, model, key and test result", async () => {
    renderPage();
    const own = within(choices()).getByRole("radio", { name: /^Own vLLM/ });
    await expect(own).toHaveAttribute("aria-checked", "false");
    expect(own).toHaveTextContent("Test passed");
    expect(own).toHaveTextContent("OpenAI compatible endpoint · qwen3");
    expect(own).toHaveTextContent("Key ending in 1234");
    expect(own).not.toHaveTextContent("Active");
    expect(own).not.toHaveTextContent("Untested model");
  });

  it("marks a failed, an untested and an unreadable connection", async () => {
    api.connections = [
      { ...CONNECTION, last_test_ok: false, last_test_error: "HTTP 401", tested_model: false },
      { ...CONNECTION, id: "c2", name: "Fresh", last_test_ok: null, credentials_readable: false },
    ];
    renderPage();
    const failed = within(choices()).getByRole("radio", { name: /^Own vLLM/ });
    expect(failed).toHaveTextContent("Test failed");
    expect(failed).toHaveTextContent("Untested model");
    expect(failed).toHaveTextContent("HTTP 401");
    await expect(failed).toHaveAttribute("aria-disabled", "true");
    const fresh = within(choices()).getByRole("radio", { name: /^Fresh/ });
    expect(fresh).toHaveTextContent("Not tested");
    expect(fresh).toHaveTextContent("The stored credentials cannot be read");
  });

  it("shows the AI credits of the period, linking to the usage page", async () => {
    renderPage();
    await expect(screen.getByRole("link", { name: /AI credits/ })).toHaveAttribute(
      "href",
      "/settings/usage?quota=ai"
    );
    expect(screen.getByRole("link", { name: /AI credits/ })).toHaveTextContent("412 / 2,000 this period");
  });

  it("shows the credits used without a limit, and none without billing", () => {
    api.balance = { used_ai_credits: 412, total_ai_credits: null };
    const { unmount } = renderPage();
    expect(screen.getByRole("link", { name: /AI credits/ })).toHaveTextContent("412 this period");
    unmount();
    api.billing = false;
    renderPage();
    expect(screen.queryByRole("link", { name: /AI credits/ })).toBeNull();
  });

  it("offers a retry in place of the credits when the balance fails", async () => {
    api.balance = undefined;
    api.balanceError = new Error("down");
    renderPage();
    expect(screen.queryByRole("link", { name: /AI credits/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.mutateBalance).toHaveBeenCalled();
    await expect(aiSwitch()).toBeEnabled();
  });

  it("says AI is on and what answers", () => {
    renderPage();
    expect(
      screen.getByText("On. All members see the assistant. It answers with GOAT AI (included).")
    ).toBeInTheDocument();
  });

  it("switches AI off at once, sending the four fields with one changed, and undoes it", async () => {
    renderPage();
    await userEvent.click(aiSwitch());
    expect(api.updateAssistantSettings).toHaveBeenCalledWith({
      enabled: false,
      active_connection_id: null,
      data_policy: "standard",
      allow_default_fallback: false,
    });
    await waitFor(() => expect(api.undoMessage).toBe("AI is off for the organization."));
    expect(api.refreshAssistantStatus).toHaveBeenCalled();
    expect(api.mutate).toHaveBeenCalled();
    expect(api.mutateConnections).toHaveBeenCalled();
    await api.undo?.();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("shows the new value while saving and puts the old one back when the save fails", async () => {
    const save = deferred<unknown>();
    api.updateAssistantSettings.mockReturnValue(save.promise);
    renderPage();
    await userEvent.click(aiSwitch());
    await expect(aiSwitch()).not.toBeChecked();
    save.reject(new Error("boom"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The request failed. Try again."));
    await expect(aiSwitch()).toBeChecked();
    expect(api.undo).toBeUndefined();
  });

  it("takes no second change while a save runs", async () => {
    const save = deferred<unknown>();
    api.updateAssistantSettings.mockReturnValue(save.promise);
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Restricted/ }));
    await userEvent.click(within(choices()).getByRole("radio", { name: /^Own vLLM/ }));
    expect(api.updateAssistantSettings).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
    save.resolve(undefined);
    // The save is over once the page frees its choices; the radio shows it, no toast.
    await waitFor(() => expect(aiSwitch()).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("locks every choice while a save runs, and frees them after", async () => {
    const save = deferred<unknown>();
    api.updateAssistantSettings.mockReturnValue(save.promise);
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [
      { ...CONNECTION, active: true },
      { ...CONNECTION, id: "c2", name: "Second" },
    ];
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Restricted/ }));
    for (const radio of [
      ...within(choices()).getAllByRole("radio"),
      ...within(screen.getByRole("radiogroup", { name: "Data policy" })).getAllByRole("radio"),
    ]) {
      await expect(radio).toHaveAttribute("aria-disabled", "true");
    }
    await expect(screen.getByRole("switch", { name: FALLBACK })).toBeDisabled();
    await expect(aiSwitch()).toBeDisabled();
    save.resolve(SETTINGS);
    // The save is over once the page frees its choices; the radio shows it, no toast.
    await waitFor(() => expect(aiSwitch()).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();
    await expect(within(choices()).getByRole("radio", { name: /^Second/ })).not.toHaveAttribute(
      "aria-disabled"
    );
    await expect(screen.getByRole("switch", { name: FALLBACK })).toBeEnabled();
  });

  it("fails an undo that comes while another save runs, so its toast says so", async () => {
    renderPage();
    await userEvent.click(aiSwitch());
    await waitFor(() => expect(api.undo).toBeDefined());
    const save = deferred<unknown>();
    api.updateAssistantSettings.mockReturnValue(save.promise);
    await userEvent.click(screen.getByRole("radio", { name: /^Restricted/ }));
    await expect(api.undo?.()).rejects.toThrow();
    expect(api.updateAssistantSettings).toHaveBeenCalledTimes(2);
    save.resolve(SETTINGS);
    // The save is over once the page frees its choices; the radio shows it, no toast.
    await waitFor(() => expect(aiSwitch()).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("puts the saved settings from the answer into the cache and reads the rest again", async () => {
    const saved = { ...SETTINGS, enabled: false };
    api.updateAssistantSettings.mockResolvedValue(saved);
    renderPage();
    await userEvent.click(aiSwitch());
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith(saved, { revalidate: false }));
    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(api.mutateConnections).toHaveBeenCalled();
    expect(api.refreshAssistantStatus).toHaveBeenCalled();
  });

  it("undoes with the settings as they are by then, not as they were", async () => {
    const { rerender } = renderPage();
    await userEvent.click(aiSwitch());
    await waitFor(() => expect(api.undo).toBeDefined());
    // Meanwhile the data policy changed (and the settings were read again).
    api.settings = { ...SETTINGS, enabled: false, data_policy: "restricted" };
    rerender(page());
    await api.undo?.();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith({
      enabled: true,
      active_connection_id: null,
      data_policy: "restricted",
      allow_default_fallback: false,
    });
  });

  it("makes a tested own connection active from its radio card, with undo", async () => {
    renderPage();
    await userEvent.click(within(choices()).getByRole("radio", { name: /^Own vLLM/ }));
    expect(api.updateAssistantSettings).toHaveBeenCalledWith(
      expect.objectContaining({ active_connection_id: "c1", enabled: true })
    );
    await waitFor(() => expect(api.undoMessage).toBe("Own vLLM now answers all questions."));
    await api.undo?.();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ active_connection_id: null, allow_default_fallback: false })
    );
  });

  it("goes back to GOAT AI without the fallback, with undo", async () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1", allow_default_fallback: true };
    api.connections = [{ ...CONNECTION, active: true }];
    renderPage();
    await userEvent.click(within(choices()).getByRole("radio", { name: /^GOAT AI/ }));
    expect(api.updateAssistantSettings).toHaveBeenCalledWith({
      enabled: true,
      active_connection_id: null,
      data_policy: "standard",
      allow_default_fallback: false,
    });
    await waitFor(() => expect(api.undoMessage).toBe("GOAT AI (included) now answers all questions."));
    await api.undo?.();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ active_connection_id: "c1", allow_default_fallback: true })
    );
  });

  it("asks for a test before an untested connection can be chosen", async () => {
    api.connections = [{ ...CONNECTION, last_test_ok: null }];
    renderPage();
    await userEvent.click(within(choices()).getByRole("radio", { name: /^Own vLLM/ }));
    expect(api.updateAssistantSettings).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Test the connection before you use it.");
  });

  it("offers no choice while AI is off, but tests and adds connections", async () => {
    api.settings = { ...SETTINGS, enabled: false };
    renderPage();
    expect(screen.getByText("Off. The assistant is hidden for all members.")).toBeInTheDocument();
    expect(screen.getByText("AI is off. You can still create and test connections.")).toBeInTheDocument();
    for (const radio of within(choices()).getAllByRole("radio")) {
      await expect(radio).toHaveAttribute("aria-disabled", "true");
    }
    expect(within(choices()).getByRole("radio", { name: /^GOAT AI/ })).not.toHaveTextContent("Active");
    await userEvent.click(within(choices()).getByRole("radio", { name: /^Own vLLM/ }));
    expect(api.updateAssistantSettings).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    await expect(within(choices()).getByRole("button", { name: "Test" })).toBeEnabled();
    await expect(screen.getByRole("button", { name: "Own connection" })).toBeEnabled();
  });

  it("says when GOAT AI is not available on the instance", async () => {
    api.settings = {
      ...SETTINGS,
      instance: { ...SETTINGS.instance, goat_ai: { available: false, provider: null, model: null } },
    };
    renderPage();
    const goatAi = within(choices()).getByRole("radio", { name: /^GOAT AI/ });
    expect(goatAi).toHaveTextContent("GOAT AI is not available on this instance.");
    // Nothing answers, so nothing is shown as chosen.
    await expect(goatAi).toHaveAttribute("aria-checked", "false");
    await expect(goatAi).toHaveAttribute("aria-disabled", "true");
    expect(goatAi).not.toHaveTextContent("Active");
  });

  it("says what an own connection is while there is none", () => {
    api.connections = [];
    renderPage();
    expect(screen.getByText(/^No own connection yet\./)).toBeInTheDocument();
    expect(within(choices()).getAllByRole("radio")).toHaveLength(1);
  });

  it("offers no fallback switch while GOAT AI answers", () => {
    renderPage();
    expect(screen.queryByRole("switch", { name: FALLBACK })).toBeNull();
  });

  it("offers the fallback switch under the active own connection and saves it at once", async () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [{ ...CONNECTION, active: true }];
    renderPage();
    expect(within(choices()).getByRole("radio", { name: /^Own vLLM/ })).toHaveTextContent("Active");
    const fallback = screen.getByRole("switch", { name: FALLBACK });
    await userEvent.click(fallback);
    expect(api.updateAssistantSettings).toHaveBeenCalledWith(
      expect.objectContaining({ allow_default_fallback: true, active_connection_id: "c1" })
    );
    // The switch shows it: no toast, and no undo.
    await waitFor(() => expect(aiSwitch()).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.undo).toBeUndefined();
  });

  it("offers no fallback switch when GOAT AI is not available", () => {
    api.settings = {
      ...SETTINGS,
      active_connection_id: "c1",
      instance: { ...SETTINGS.instance, goat_ai: { available: false, provider: null, model: null } },
    };
    api.connections = [{ ...CONNECTION, active: true }];
    renderPage();
    expect(screen.queryByRole("switch", { name: FALLBACK })).toBeNull();
  });

  it("tests a connection and shows a pass in its row, without a toast", async () => {
    api.testAssistantConnection.mockImplementation(async () => {
      // The service stores the result: the list read again carries it.
      api.connections = [{ ...CONNECTION, last_test_ok: true }];
      return { ...CONNECTION, last_test_ok: true };
    });
    renderPage();
    await userEvent.click(within(choices()).getByRole("button", { name: "Test" }));
    expect(api.testAssistantConnection).toHaveBeenCalledWith("c1");
    await waitFor(() =>
      expect(within(choices()).getByRole("radio", { name: /^Own vLLM/ })).toHaveTextContent("Test passed")
    );
    expect(api.refreshAssistantStatus).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the test running, and a failed test with the provider's answer", async () => {
    const run = deferred<unknown>();
    api.testAssistantConnection.mockReturnValue(run.promise);
    renderPage();
    await userEvent.click(within(choices()).getByRole("button", { name: "Test" }));
    expect(within(choices()).getByRole("radio", { name: /^Own vLLM/ })).toHaveTextContent("Being tested");
    run.resolve({ ...CONNECTION, last_test_ok: false, last_test_error: "HTTP 401" });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Test failed: HTTP 401"));
    expect(within(choices()).getByRole("radio", { name: /^Own vLLM/ })).not.toHaveTextContent("Being tested");
  });

  it("does not ask for a test when the active connection that failed is clicked: the banner says it", async () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [{ ...CONNECTION, active: true, last_test_ok: false, last_test_error: "HTTP 401" }];
    renderPage();
    await userEvent.click(within(choices()).getByRole("radio", { name: /^Own vLLM/ }));
    expect(toast.info).not.toHaveBeenCalled();
    expect(api.updateAssistantSettings).not.toHaveBeenCalled();
  });

  it("warns when the active connection failed its last test", () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [{ ...CONNECTION, active: true, last_test_ok: false, last_test_error: "HTTP 401" }];
    renderPage();
    expect(
      screen.getByText(
        "The active connection failed its last check: HTTP 401 Members may see that AI is unavailable until this is fixed."
      )
    ).toBeInTheDocument();
  });

  it("warns of a failed active connection without a dangling colon when the service gave no detail", () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [{ ...CONNECTION, active: true, last_test_ok: false, last_test_error: null }];
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /^The active connection failed its last check\. Members may see/
    );
  });

  it("says why members cannot use AI while nothing can answer", () => {
    api.settings = { ...SETTINGS, status: "no_connection" };
    renderPage();
    expect(screen.getByText(/^AI is enabled, but no connection is available\./)).toBeInTheDocument();
  });

  it("explains a missing secrets key and offers no own connection", async () => {
    api.settings = {
      ...SETTINGS,
      instance: { ...SETTINGS.instance, secrets_key_configured: false, org_connections: false },
    };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /^Own connections are unavailable because the instance has no key/
    );
    const add = screen.getByRole("button", { name: "Own connection" });
    await expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      /^Own connections are unavailable because the instance has no key/
    );
  });

  it("says when own connections are switched off on the instance", async () => {
    api.settings = { ...SETTINGS, instance: { ...SETTINGS.instance, org_connections: false } };
    renderPage();
    const add = screen.getByRole("button", { name: "Own connection" });
    await expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription("Own connections are switched off on this instance.");
    expect(screen.queryByText(/no key for storing credentials/)).toBeNull();
  });

  it("does not let the active connection be deleted, and says why", async () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [{ ...CONNECTION, active: true }];
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Own vLLM" }));
    await expect(screen.getByRole("menuitem", { name: /Delete connection/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByText("Choose another active connection first.")).toBeInTheDocument();
  });

  it("deletes a connection after asking", async () => {
    api.deleteAssistantConnection.mockImplementation(async () => {
      api.connections = [];
    });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Own vLLM" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete connection/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete the connection Own vLLM?");
    expect(dialog).toHaveTextContent(
      "The stored key is deleted. Conversations already held with this connection stay."
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete connection" }));
    expect(api.deleteAssistantConnection).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.mutateConnections).toHaveBeenCalled();
    // It leaves the list: no toast says so.
    expect(within(choices()).queryByRole("radio", { name: /^Own vLLM/ })).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps the delete dialog busy while it deletes, and open when it fails", async () => {
    const removal = deferred<unknown>();
    api.deleteAssistantConnection.mockReturnValue(removal.promise);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Own vLLM" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete connection/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete connection" }));
    // Cancel and the header's X (named after it) wait while it deletes.
    for (const button of within(dialog).getAllByRole("button", { name: "Cancel" })) {
      await expect(button).toBeDisabled();
    }
    removal.reject(new Error("boom"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The request failed. Try again."));
    for (const button of within(dialog).getAllByRole("button", { name: "Cancel" })) {
      await expect(button).toBeEnabled();
    }
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("saves a new connection, closes the dialog and tests it", async () => {
    const created = { ...CONNECTION, id: "c2", name: "LAN model", last_test_ok: null };
    api.createAssistantConnection.mockResolvedValue(created);
    api.testAssistantConnection.mockResolvedValue({ ...created, last_test_ok: true });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Own connection" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Add own connection");
    expect(dialog).toHaveTextContent(
      "Your provider, your key, your model. After saving we test the connection."
    );
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "LAN model");
    await userEvent.type(within(dialog).getByLabelText(/^Base URL/), "https://llm.example.org/v1");
    await userEvent.type(within(dialog).getByLabelText(/^Model ID/), "llama");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(api.testAssistantConnection).toHaveBeenCalledWith("c2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(api.refreshAssistantStatus).toHaveBeenCalled());
    await waitFor(() => expect(within(choices()).getByRole("button", { name: "Test" })).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("edits a connection in the dialog", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Own vLLM" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Edit connection");
    await expect(within(dialog).getByLabelText(/^Name/)).toHaveValue("Own vLLM");
    // The stored key never comes back.
    await expect(within(dialog).getByLabelText(/^API key/)).toHaveValue("");
  });

  it("saves the data policy at once", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Restricted/ }));
    expect(api.updateAssistantSettings).toHaveBeenCalledWith(
      expect.objectContaining({ data_policy: "restricted" })
    );
    // The radio shows it: no toast, and no undo.
    await waitFor(() => expect(aiSwitch()).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.undo).toBeUndefined();
  });

  it("picks and undoes a connection with the fallback off while the instance has no GOAT AI", async () => {
    api.settings = {
      ...SETTINGS,
      active_connection_id: "c1",
      allow_default_fallback: true,
      instance: { ...SETTINGS.instance, goat_ai: { available: false, provider: null, model: null } },
    };
    api.connections = [
      { ...CONNECTION, active: true },
      { ...CONNECTION, id: "c2", name: "Second" },
    ];
    renderPage();
    await userEvent.click(within(choices()).getByRole("radio", { name: /^Second/ }));
    expect(api.updateAssistantSettings).toHaveBeenCalledWith({
      enabled: true,
      active_connection_id: "c2",
      data_policy: "standard",
      allow_default_fallback: false,
    });
    await waitFor(() => expect(api.undo).toBeDefined());
    await api.undo?.();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith({
      enabled: true,
      active_connection_id: "c1",
      data_policy: "standard",
      allow_default_fallback: false,
    });
  });

  it("sends a stored fallback as off while the instance has no GOAT AI, which the service would refuse", async () => {
    api.settings = {
      ...SETTINGS,
      active_connection_id: "c1",
      allow_default_fallback: true,
      instance: { ...SETTINGS.instance, goat_ai: { available: false, provider: null, model: null } },
    };
    api.connections = [{ ...CONNECTION, active: true }];
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Restricted/ }));
    expect(api.updateAssistantSettings).toHaveBeenCalledWith({
      enabled: true,
      active_connection_id: "c1",
      data_policy: "restricted",
      allow_default_fallback: false,
    });
  });

  it("shows card skeletons while the settings load", () => {
    api.settings = undefined;
    renderPage();
    expect(screen.getByRole("heading", { name: "AI" })).toBeInTheDocument();
    expect(screen.getAllByRole("status", { name: "Loading" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("names no connection in the switch line while the connections failed to load", () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [];
    api.connectionsError = new Error("down");
    renderPage();
    expect(screen.getByText("On. All members see the assistant.")).toBeInTheDocument();
  });

  it("keeps the nameless line and the retry while SWR tries the connections again", () => {
    // SWR keeps the error while it retries, and sets isLoading again.
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [];
    api.connectionsError = new Error("down");
    api.connectionsLoading = true;
    renderPage();
    expect(screen.getByText("On. All members see the assistant.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("keeps the connections it has when reading them again fails", () => {
    api.connectionsError = new Error("down");
    renderPage();
    expect(within(choices()).getByRole("radio", { name: /^Own vLLM/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("waits for the active connection's name while the connections load", async () => {
    api.settings = { ...SETTINGS, active_connection_id: "c1" };
    api.connections = [];
    api.connectionsLoading = true;
    renderPage();
    expect(screen.queryByText(/^On\. All members see the assistant\./)).toBeNull();
    await expect(screen.getByRole("switch", { name: "AI for this organization" })).toBeChecked();
  });

  it("shows a skeleton in the connections card while the connections load", () => {
    api.connections = [];
    api.connectionsLoading = true;
    renderPage();
    expect(screen.queryByRole("radiogroup", { name: "What the assistant answers with" })).toBeNull();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText(/^No own connection yet\./)).toBeNull();
    expect(aiSwitch()).toBeInTheDocument();
  });

  it("offers a retry in the connections card when the connections fail", async () => {
    api.connections = [];
    api.connectionsError = new Error("down");
    renderPage();
    expect(screen.queryByRole("radiogroup", { name: "What the assistant answers with" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.mutateConnections).toHaveBeenCalled();
    expect(screen.getByRole("radiogroup", { name: "Data policy" })).toBeInTheDocument();
  });

  it("offers a retry when the settings fail to load", async () => {
    api.settings = undefined;
    api.error = { status: 500 };
    renderPage();
    expect(screen.getByText("That could not be loaded.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.mutate).toHaveBeenCalled();
  });

  it("says only admins may change the settings on a 403", () => {
    api.settings = undefined;
    api.error = { status: 403, info: { detail: { code: "forbidden" } } };
    renderPage();
    expect(screen.getByText("Only organization admins can change the AI settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the connections when reading the settings again fails", () => {
    api.error = { status: 500 };
    renderPage();
    expect(within(choices()).getByRole("radio", { name: /^Own vLLM/ })).toBeInTheDocument();
  });

  it("does not ask for the connections once the settings were refused", () => {
    api.settings = undefined;
    api.error = { status: 403, info: { detail: { code: "not_admin" } } };
    renderPage();
    expect(api.connectionsEnabled).toBe(false);
  });

  it("keeps the refusal or the retry in sight while SWR tries the settings again", async () => {
    api.settings = undefined;
    api.settingsLoading = true;
    api.error = { status: 403, info: { detail: { code: "not_admin" } } };
    const { unmount } = renderPage();
    expect(screen.getByText("Only organization admins can change the AI settings.")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    unmount();
    api.error = { status: 500 };
    renderPage();
    expect(screen.getByText("That could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("says when the account belongs to no organization", () => {
    api.settings = undefined;
    api.error = { status: 403, info: { detail: { code: "no_organization" } } };
    renderPage();
    expect(screen.getByText("Your account does not belong to an organization.")).toBeInTheDocument();
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AiSettingsPage from "@/app/(dashboard)/settings/organization/ai/page";

const api = vi.hoisted(() => ({
  useAssistantSettings: vi.fn(),
  useAssistantConnections: vi.fn(),
  updateAssistantSettings: vi.fn(),
  createAssistantConnection: vi.fn(),
  updateAssistantConnection: vi.fn(),
  deleteAssistantConnection: vi.fn(),
  testAssistantConnection: vi.fn(),
  refreshAssistantStatus: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  // Interpolated values follow the key, so a test sees what a text was given.
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === "ai_settings_goat_ai_hosted_in" ? `${key}:${String(options?.place)}` : key,
  }),
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));
vi.mock("@/lib/api/assistant", () => ({ ...api, AssistantApiError: class extends Error {} }));

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
  key_last4: "1234",
  credentials_readable: true,
  capabilities: {},
  tested_model: false,
  last_test_at: null,
  last_test_ok: null,
  last_test_error: null,
  active: false,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

function given(settings: object, connections: object[]) {
  api.useAssistantSettings.mockReturnValue({ settings, isLoading: false, error: undefined, mutate: vi.fn() });
  api.useAssistantConnections.mockReturnValue({
    connections,
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  });
}

const PASSED = { ...CONNECTION, last_test_ok: true, tested_model: true };
const FAILED = { ...CONNECTION, last_test_ok: false, last_test_error: "HTTP 401" };

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  given(SETTINGS, []);
});

describe("AI settings page", () => {
  it("shows GOAT AI as the active connection with its model, provider and where it is hosted", () => {
    render(<AiSettingsPage />);
    expect(screen.getAllByText("ai_settings_goat_ai").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "eu.anthropic.claude-sonnet-4-5 · Amazon Bedrock · ai_settings_goat_ai_hosted_in:assistant_hosted_place_eu"
      ).length
    ).toBeGreaterThan(0);
  });

  it("names GOAT AI's model alone where the instance names nothing else", () => {
    given(
      {
        ...SETTINGS,
        instance: {
          ...SETTINGS.instance,
          goat_ai: { ...SETTINGS.instance.goat_ai, provider: null, hosted_in: null },
        },
      },
      []
    );
    render(<AiSettingsPage />);
    expect(screen.getAllByText("eu.anthropic.claude-sonnet-4-5").length).toBeGreaterThan(0);
  });

  it("warns when the active connection failed its last check", () => {
    const failed = {
      ...CONNECTION,
      active: true,
      last_test_ok: false,
      last_test_error: "The provider rejected the credentials (HTTP 401).",
    };
    given({ ...SETTINGS, active_connection_id: "c1" }, [failed]);
    render(<AiSettingsPage />);
    expect(screen.getByText("ai_settings_banner_failed")).toBeInTheDocument();
  });

  it("shows a failed check without a dangling colon when the service gave no detail", () => {
    given({ ...SETTINGS, active_connection_id: "c1" }, [
      { ...CONNECTION, active: true, last_test_ok: false, last_test_error: null },
    ]);
    render(<AiSettingsPage />);
    expect(screen.getByText("ai_settings_banner_failed_no_detail")).toBeInTheDocument();
    expect(screen.queryByText("ai_settings_banner_failed")).not.toBeInTheDocument();
  });

  it("does not let the active connection be deleted", async () => {
    given({ ...SETTINGS, active_connection_id: "c1" }, [{ ...CONNECTION, active: true, last_test_ok: true }]);
    render(<AiSettingsPage />);
    await expect(screen.getByRole("button", { name: "ai_settings_delete_connection" })).toBeDisabled();
  });

  it("says why own connections are unavailable when the service has no secrets key", async () => {
    given(
      {
        ...SETTINGS,
        instance: { ...SETTINGS.instance, org_connections: false, secrets_key_configured: false },
      },
      []
    );
    render(<AiSettingsPage />);
    expect(screen.getByText("ai_settings_secrets_key_missing")).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "ai_settings_add_connection" })).toBeDisabled();
  });

  it("does not mention the secrets key when it is configured", () => {
    render(<AiSettingsPage />);
    expect(screen.queryByText("ai_settings_secrets_key_missing")).not.toBeInTheDocument();
  });

  it("tests a connection on request", async () => {
    given(SETTINGS, [CONNECTION]);
    api.testAssistantConnection.mockResolvedValue({ ...CONNECTION, last_test_ok: true });
    render(<AiSettingsPage />);
    await userEvent.click(screen.getByRole("button", { name: "ai_settings_test_connection" }));
    expect(api.testAssistantConnection).toHaveBeenCalledWith("c1");
  });

  it("keeps Save disabled until an OpenAI compatible connection is complete", async () => {
    render(<AiSettingsPage />);
    await userEvent.click(screen.getByRole("button", { name: "ai_settings_add_connection" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "save" });
    await expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/^name/), "Own vLLM");
    await userEvent.type(
      within(dialog).getByLabelText(/^ai_settings_field_base_url/),
      "https://llm.example.org/v1"
    );
    await userEvent.type(within(dialog).getByLabelText(/^ai_settings_field_model/), "qwen3");
    await expect(save).toBeEnabled();
  });
});

describe("AI settings page: using a connection", () => {
  const useButton = () => screen.queryByRole("button", { name: "ai_settings_use_connection" });

  it("offers no Use action before a test or after a failed one", async () => {
    given(SETTINGS, [CONNECTION, { ...FAILED, id: "c2", name: "Broken" }]);
    render(<AiSettingsPage />);
    expect(useButton()).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "ai_settings_test_connection" })).toHaveLength(2);
    // the hint in the Active connection select stays where it was
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByText("ai_settings_connection_needs_test")).toHaveLength(2);
  });

  it("offers the Use action once the test passed, on that connection only", () => {
    given(SETTINGS, [PASSED, { ...CONNECTION, id: "c2", name: "Other" }]);
    render(<AiSettingsPage />);
    expect(screen.getAllByRole("button", { name: "ai_settings_use_connection" })).toHaveLength(1);
  });

  it("shows the Use action after a test passes in this session", async () => {
    given(SETTINGS, [CONNECTION]);
    api.testAssistantConnection.mockResolvedValue(PASSED);
    api.useAssistantConnections.mockReturnValue({
      connections: [CONNECTION],
      isLoading: false,
      error: undefined,
      // the refresh after the test brings the stored result
      mutate: vi.fn(async () => {
        api.useAssistantConnections.mockReturnValue({
          connections: [PASSED],
          isLoading: false,
          error: undefined,
          mutate: vi.fn(),
        });
      }),
    });
    render(<AiSettingsPage />);
    expect(useButton()).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ai_settings_test_connection" }));
    expect(await screen.findByRole("button", { name: "ai_settings_use_connection" })).toBeInTheDocument();
  });

  it("makes the connection active and keeps enabled, data policy and fallback", async () => {
    const settings = {
      ...SETTINGS,
      enabled: false,
      active_connection_id: "c2",
      data_policy: "restricted",
      allow_default_fallback: true,
    };
    given(settings, [PASSED, { ...PASSED, id: "c2", name: "Current", active: true }]);
    api.updateAssistantSettings.mockResolvedValue({ ...settings, active_connection_id: "c1" });
    render(<AiSettingsPage />);
    await userEvent.click(screen.getByRole("button", { name: "ai_settings_use_connection" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("ai_settings_save_success"));
    expect(api.updateAssistantSettings).toHaveBeenCalledTimes(1);
    expect(api.updateAssistantSettings).toHaveBeenCalledWith({
      enabled: false,
      active_connection_id: "c1",
      data_policy: "restricted",
      allow_default_fallback: true,
    });
    // The dock in this tab reads again whether GOAT AI answers.
    expect(api.refreshAssistantStatus).toHaveBeenCalled();
  });

  it("saves the form as it stands, like Save with the connection chosen in the select", async () => {
    const settings = { ...SETTINGS, active_connection_id: "c2", allow_default_fallback: false };
    given(settings, [PASSED, { ...PASSED, id: "c2", name: "Current", active: true }]);
    api.updateAssistantSettings.mockResolvedValue(settings);
    render(<AiSettingsPage />);
    await userEvent.click(screen.getByRole("checkbox", { name: /ai_settings_fallback_label/ }));
    await userEvent.click(screen.getByRole("button", { name: "ai_settings_use_connection" }));
    await waitFor(() => expect(api.updateAssistantSettings).toHaveBeenCalled());
    expect(api.updateAssistantSettings).toHaveBeenCalledWith({
      enabled: true,
      active_connection_id: "c1",
      data_policy: "standard",
      allow_default_fallback: true,
    });
  });

  it("reports a failed save and keeps the action", async () => {
    given(SETTINGS, [PASSED]);
    api.updateAssistantSettings.mockRejectedValue(new Error("boom"));
    render(<AiSettingsPage />);
    await userEvent.click(screen.getByRole("button", { name: "ai_settings_use_connection" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ai_settings_error_generic"));
    expect(toast.success).not.toHaveBeenCalled();
    await expect(screen.getByRole("button", { name: "ai_settings_use_connection" })).toBeEnabled();
  });

  it("marks the active connection with an Active badge and offers no Use action on it", () => {
    given({ ...SETTINGS, active_connection_id: "c1" }, [
      { ...PASSED, active: true },
      { ...PASSED, id: "c2", name: "Other" },
    ]);
    render(<AiSettingsPage />);
    expect(screen.getAllByText("active")).toHaveLength(1);
    const [row] = screen.getAllByRole("listitem");
    expect(within(row).getByText("active")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "ai_settings_use_connection" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "ai_settings_use_connection" })).toHaveLength(1);
  });

  it("shows no Active badge while no connection is active", () => {
    given(SETTINGS, [PASSED]);
    render(<AiSettingsPage />);
    expect(screen.queryByText("active")).not.toBeInTheDocument();
  });
});

describe("AI settings page: GOAT AI until a connection is active", () => {
  const hint = () => screen.queryByText("ai_settings_goat_ai_until_active");

  it("says GOAT AI is used when a tested connection exists but none is active", () => {
    given(SETTINGS, [PASSED]);
    render(<AiSettingsPage />);
    expect(hint()).toBeInTheDocument();
  });

  it("stays out when a connection is active", () => {
    given({ ...SETTINGS, active_connection_id: "c1" }, [{ ...PASSED, active: true }]);
    render(<AiSettingsPage />);
    expect(hint()).not.toBeInTheDocument();
  });

  it("stays out when no connection passed its test", () => {
    given(SETTINGS, [CONNECTION, { ...FAILED, id: "c2", name: "Broken" }]);
    render(<AiSettingsPage />);
    expect(hint()).not.toBeInTheDocument();
  });

  it("stays out without connections", () => {
    render(<AiSettingsPage />);
    expect(hint()).not.toBeInTheDocument();
  });

  it("stays out when AI is off or GOAT AI is not available, where it would not be true", () => {
    given({ ...SETTINGS, enabled: false }, [PASSED]);
    const { unmount } = render(<AiSettingsPage />);
    expect(hint()).not.toBeInTheDocument();
    unmount();
    given({ ...SETTINGS, instance: { ...SETTINGS.instance, goat_ai: { available: false } } }, [PASSED]);
    render(<AiSettingsPage />);
    expect(hint()).not.toBeInTheDocument();
  });
});

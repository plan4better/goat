import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import AiPage from "@/app/(dashboard)/settings/ai/page";

const SETTINGS = {
  enabled: true,
  active_connection_id: null,
  data_policy: "standard",
  allow_default_fallback: false,
  status: "ok",
  instance: {
    goat_ai: { available: true, provider: null, model: null, hosted_in: "EU" },
    org_connections: true,
    secrets_key_configured: true,
    allowed_providers: ["openai_compatible"],
    private_endpoints: false,
  },
};

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: { billing: false } }) }));
vi.mock("@/lib/api/usage", () => ({ useCreditBalance: () => ({ balance: undefined, mutate: vi.fn() }) }));
vi.mock("@/lib/api/assistant", () => ({
  useAssistantSettings: () => ({ settings: SETTINGS, isLoading: false, error: undefined, mutate: vi.fn() }),
  useAssistantConnections: () => ({ connections: [], isLoading: false, error: undefined, mutate: vi.fn() }),
  updateAssistantSettings: vi.fn(),
  testAssistantConnection: vi.fn(),
  deleteAssistantConnection: vi.fn(),
  refreshAssistantStatus: vi.fn(),
  AssistantApiError: class extends Error {},
}));
// Code a deploy removed (a tab opened before it): every load of it fails.
vi.mock("@/components/settings/ai/ConnectionDialog", () => {
  throw new Error("Failed to load chunk");
});

describe("AI page when a dialog's code does not load", () => {
  it("shows a notice in place of the dialog instead of failing the page", async () => {
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <AiPage />
      </I18nextProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "Own connection" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This part could not be loaded.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "AI" })).toBeInTheDocument();
  });
});

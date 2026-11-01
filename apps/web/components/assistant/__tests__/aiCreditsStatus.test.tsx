import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import Composer from "@/components/assistant/Composer";

import AiSettingsPage from "@/app/(dashboard)/settings/organization/ai/page";

/**
 * The AI settings page and the dock in one tab, on the app's own SWR cache:
 * what the assistant answers comes from a fetcher that reads `server`.
 */
const { server, fetcherMock } = vi.hoisted(() => {
  const server = {
    status: { available: true, goat_ai: true, is_admin: true } as Record<string, unknown>,
    settings: {
      enabled: true,
      active_connection_id: null as string | null,
      data_policy: "standard",
      allow_default_fallback: false,
      status: "ok",
      instance: {
        goat_ai: { available: true, provider: null, model: "goat-ai", hosted_in: null },
        org_connections: true,
        secrets_key_configured: true,
        allowed_providers: ["openai_compatible"],
        private_endpoints: false,
      },
    },
    connections: [
      {
        id: "c1",
        name: "Own vLLM",
        provider: "openai_compatible",
        base_url: "https://llm.example.org/v1",
        region: null,
        model: "qwen3",
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
      },
    ],
  };
  const fetcherMock = vi.fn(async (key: string | [string]) => {
    const url = Array.isArray(key) ? key[0] : key;
    if (url.endsWith("/status")) return server.status;
    if (url.endsWith("/settings")) return server.settings;
    if (url.endsWith("/connections")) return server.connections;
    throw new Error(`unexpected request ${url}`);
  });
  return { server, fetcherMock };
});

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));
vi.mock("@/lib/api/fetcher", () => ({
  fetcher: fetcherMock,
  getAccessToken: vi.fn(),
  apiRequestAuth: vi.fn(),
}));
// The save: the server takes the own connection.
vi.mock("@/lib/assistant/http", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assistantFetch: vi.fn(async (_path: string, init: { body?: { active_connection_id?: string } }) => {
    server.settings = { ...server.settings, active_connection_id: init.body?.active_connection_id ?? null };
    server.status = { ...server.status, goat_ai: false };
    return server.settings;
  }),
}));
// Billing is on and the pool is empty.
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: { billing: true } }) }));
vi.mock("@/lib/api/usage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCreditBalance: (enabled: boolean) => ({
    balance: enabled
      ? {
          used_ai_credits: 1000,
          total_ai_credits: 1000,
          ai_credit_tiers: [{ max_steps: null, credits: 1 }],
          credits_reset_at: "2026-12-01T00:00:00",
          plan_renewal_date: null,
          on_trial: false,
        }
      : undefined,
  }),
}));
vi.mock("@/lib/api/projects", () => ({ useProjects: () => ({ projects: { items: [] }, isLoading: false }) }));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

describe("the dock's AI credits and the AI settings", () => {
  it("unblock the composer when an admin switches to an own connection while the pool is used up", async () => {
    render(
      <SWRConfig value={{ dedupingInterval: 0 }}>
        <AiSettingsPage />
        <Composer
          draft=""
          onDraftChange={vi.fn()}
          onSend={vi.fn()}
          busy={false}
          chips={[]}
          onRemoveChip={vi.fn()}
          mentionsEnabled={false}
          onAddSource={vi.fn()}
        />
      </SWRConfig>
    );
    const composer = () => screen.queryByRole("textbox", { name: "assistant_composer_placeholder" });
    await screen.findByText("assistant_credits_used_up");
    expect(composer()).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "ai_settings_use_connection" }));

    // The save reads /status again: an own connection answers, so the pool no longer holds the dock back.
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(screen.queryByText("assistant_credits_used_up")).toBeNull();
  });
});

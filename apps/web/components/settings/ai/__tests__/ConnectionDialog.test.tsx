import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { AssistantApiError } from "@/lib/api/assistant";

import ConnectionDialog, { assistantErrorText } from "@/components/settings/ai/ConnectionDialog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real API client runs in these tests; only the network and the session are stubbed.
vi.mock("next-auth/react", () => ({ getSession: () => Promise.resolve(null), signIn: vi.fn() }));
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));

const answer = (status: number, body: unknown) =>
  vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
    );

afterEach(() => vi.unstubAllGlobals());

/** Echoes the key and its variables, so the test sees which text was picked. */
const t = ((key: string, options?: { message?: string }) =>
  options?.message !== undefined ? `${key}|${options.message}` : key) as never;

const CODES = [
  "name_taken",
  "endpoint_not_allowed",
  "provider_not_allowed",
  "org_connections_unavailable",
  "connection_not_tested",
  "connection_not_allowed",
  "connection_not_found",
  "connection_changed",
  "connection_active",
  "credentials_unreadable",
  "credentials_required",
  "goat_ai_unavailable",
  "test_in_progress",
  "invalid_request",
  "not_found",
  "no_organization",
  "not_admin",
];

describe("assistantErrorText", () => {
  it.each(CODES)("has a text in both languages for %s", (code) => {
    const text = assistantErrorText(new AssistantApiError(409, code), t);
    expect(text).not.toBe("ai_settings_error_generic");
    expect(en).toHaveProperty(text);
    expect(de).toHaveProperty(text);
  });

  it("appends the service's own wording to a known code", () => {
    expect(assistantErrorText(new AssistantApiError(422, "invalid_request", "Field required"), t)).toBe(
      "ai_settings_error_invalid_request Field required"
    );
  });

  it("shows the failed test's message", () => {
    expect(assistantErrorText(new AssistantApiError(422, "test_failed", "HTTP 401"), t)).toBe(
      "ai_settings_error_test_failed|HTTP 401"
    );
  });

  it("falls back to the generic text for anything else", () => {
    expect(assistantErrorText(new AssistantApiError(500, "request_failed"), t)).toBe(
      "ai_settings_error_generic"
    );
    expect(assistantErrorText(new Error("network"), t)).toBe("ai_settings_error_generic");
  });
});

describe("ConnectionDialog secrets", () => {
  const renderDialog = (onClose = vi.fn(), onSaved = vi.fn()) => {
    render(
      <ConnectionDialog
        open
        connection={null}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
    return { onClose, onSaved };
  };
  const keyField = () => screen.getByLabelText(/^ai_settings_field_api_key/) as HTMLInputElement;

  it("keeps password managers from filling the key field", () => {
    renderDialog();
    expect(keyField().autocomplete).toBe("new-password");
  });

  it("clears a typed key when the dialog is cancelled", async () => {
    const { onClose } = renderDialog();
    await userEvent.type(keyField(), "sk-secret");
    expect(keyField().value).toBe("sk-secret");
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onClose).toHaveBeenCalled();
    // The parent here keeps the dialog mounted and open: the key must already be gone.
    expect(keyField().value).toBe("");
  });

  it("clears the typed key after a successful save", async () => {
    const fetchMock = answer(201, { id: "c9", name: "Own vLLM" });
    vi.stubGlobal("fetch", fetchMock);
    const { onClose, onSaved } = renderDialog();
    await userEvent.type(screen.getByLabelText(/^name/), "Own vLLM");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_base_url/), "https://llm.example.org/v1");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_model/), "qwen3");
    await userEvent.type(keyField(), "sk-secret");
    await userEvent.click(screen.getByRole("button", { name: "settings_ai_save_and_test" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://assistant.test/connections",
      expect.objectContaining({ method: "POST" })
    );
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    // The page tests what was saved, so it gets the service's answer.
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "c9" }));
    expect(keyField().value).toBe("");
    // The service's answer, not the form with the typed key.
    expect(JSON.stringify(onSaved.mock.calls)).not.toContain("sk-secret");
  });
});

describe("ConnectionDialog provider order", () => {
  it("offers the providers only for an OpenRouter connection, and sends them as a list", async () => {
    const fetchMock = answer(201, {});
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ConnectionDialog
        open
        connection={null}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const baseUrl = screen.getByLabelText(/^ai_settings_field_base_url/);
    await userEvent.type(baseUrl, "https://llm.example.org/v1");
    expect(screen.queryByLabelText(/^ai_settings_field_provider_order/)).toBeNull();
    await userEvent.clear(baseUrl);
    await userEvent.type(baseUrl, "https://openrouter.ai/api/v1");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_provider_order/), "DeepInfra, Together");
    await userEvent.click(screen.getByLabelText("ai_settings_field_allow_fallbacks"));
    await userEvent.type(screen.getByLabelText(/^name/), "OpenRouter");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_model/), "deepseek/deepseek-v4.1-flash");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_api_key/), "sk-or");
    await userEvent.click(screen.getByRole("button", { name: "settings_ai_save_and_test" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ provider_order: ["DeepInfra", "Together"], allow_fallbacks: false });
  });
});

describe("ConnectionDialog failed save", () => {
  const fillCompatible = async () => {
    await userEvent.type(screen.getByLabelText(/^name/), "LAN model");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_base_url/), "https://10.0.0.5/v1");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_model/), "llama");
  };
  const open = () =>
    render(
      <ConnectionDialog
        open
        connection={null}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

  it("shows a refused address in the dialog and on the base URL field", async () => {
    // The body the service answers for a private address: no `field` key.
    vi.stubGlobal(
      "fetch",
      answer(422, {
        detail: { code: "endpoint_not_allowed", message: "10.0.0.5 is a private or internal address." },
      })
    );
    open();
    await fillCompatible();
    await userEvent.click(screen.getByRole("button", { name: "settings_ai_save_and_test" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "ai_settings_error_endpoint_not_allowed 10.0.0.5 is a private or internal address."
    );
    const baseUrl = screen.getByLabelText(/^ai_settings_field_base_url/);
    expect(baseUrl.getAttribute("aria-invalid")).toBe("true");
    expect(baseUrl).toHaveAccessibleDescription(/10\.0\.0\.5 is a private or internal address\./);
  });

  it("shows any coded error in the dialog and clears it when a field changes", async () => {
    vi.stubGlobal("fetch", answer(409, { detail: { code: "name_taken" } }));
    open();
    await fillCompatible();
    await userEvent.click(screen.getByRole("button", { name: "settings_ai_save_and_test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ai_settings_error_name_taken");
    await userEvent.type(screen.getByLabelText(/^name/), "2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the service message of an invalid connection", async () => {
    vi.stubGlobal(
      "fetch",
      answer(422, { detail: { code: "invalid_connection", message: "Enter a region.", field: "region" } })
    );
    open();
    await fillCompatible();
    await userEvent.click(screen.getByRole("button", { name: "settings_ai_save_and_test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a region.");
  });
});

const EDITED = {
  id: "c1",
  name: "Own vLLM",
  provider: "openai_compatible" as const,
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

describe("ConnectionDialog titles and labels", () => {
  it("adds with its own title and subtitle, labels above the fields", () => {
    render(
      <ConnectionDialog
        open
        connection={null}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("settings_ai_dialog_add_title");
    expect(dialog).toHaveTextContent("settings_ai_dialog_add_subtitle");
    expect(within(dialog).getByRole("button", { name: "settings_ai_save_and_test" })).toBeInTheDocument();
    // A real label outside the field, not MUI's floating one.
    const name = screen.getByLabelText(/^name/);
    const label = document.querySelector(`label[for="${name.id}"]`);
    expect(label?.closest(".MuiTextField-root")).toBeNull();
    expect(screen.getByRole("combobox", { name: /^ai_settings_field_provider/ })).toBeInTheDocument();
  });

  it("edits under the connection's title, without the add subtitle and without the stored key", () => {
    render(
      <ConnectionDialog
        open
        connection={EDITED}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("ai_settings_edit_connection");
    expect(dialog).not.toHaveTextContent("settings_ai_dialog_add_title");
    expect(dialog).not.toHaveTextContent("settings_ai_dialog_add_subtitle");
    expect((screen.getByLabelText(/^ai_settings_field_api_key/) as HTMLInputElement).value).toBe("");
    expect(dialog).not.toHaveTextContent("1234");
  });
});

describe("ConnectionDialog completeness", () => {
  it("keeps Save and test disabled until an OpenAI compatible connection is complete", async () => {
    render(
      <ConnectionDialog
        open
        connection={null}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const save = screen.getByRole("button", { name: "settings_ai_save_and_test" });
    await expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^name/), "Own vLLM");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_base_url/), "https://llm.example.org/v1");
    await expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_model/), "qwen3");
    await expect(save).toBeEnabled();
  });
});

describe("ConnectionDialog field errors", () => {
  const open = () =>
    render(
      <ConnectionDialog
        open
        connection={null}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

  it("shows a field's error once it was left, not while typing", async () => {
    open();
    const name = screen.getByLabelText(/^name/);
    await userEvent.type(name, "x");
    await userEvent.clear(name);
    expect(screen.queryByText("ai_settings_error_required")).toBeNull();
    await userEvent.tab();
    expect(screen.getByText("ai_settings_error_required")).toBeInTheDocument();
    await expect(name).toHaveAttribute("aria-invalid", "true");
  });

  it("shows every missing field's error after Enter, which counts as a save attempt", async () => {
    open();
    await userEvent.type(screen.getByLabelText(/^name/), "LAN model{Enter}");
    await vi.waitFor(() => expect(screen.getAllByText("ai_settings_error_required")).toHaveLength(2));
    await expect(screen.getByLabelText(/^ai_settings_field_base_url/)).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    await expect(screen.getByLabelText(/^ai_settings_field_model/)).toHaveAttribute("aria-invalid", "true");
  });
});

describe("ConnectionDialog while saving", () => {
  it("keeps the fields read only, not disabled, so a retry after a blur sends them again", async () => {
    let fail!: (reason: unknown) => void;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          fail = reject;
        })
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "c9" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(
      <ConnectionDialog
        open
        connection={null}
        allowedProviders={["openai_compatible"]}
        allowHttp={false}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );
    const name = screen.getByLabelText(/^name/) as HTMLInputElement;
    await userEvent.type(name, "LAN model");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_base_url/), "https://llm.example.org/v1");
    await userEvent.type(screen.getByLabelText(/^ai_settings_field_model/), "llama");
    await userEvent.click(screen.getByRole("button", { name: "settings_ai_save_and_test" }));
    await vi.waitFor(() => expect(name.readOnly).toBe(true));
    await expect(name).toHaveAttribute("aria-readonly", "true");
    expect(name.disabled).toBe(false);
    // A blur while saving must not empty the field in the form's state.
    name.focus();
    name.blur();
    fail(new TypeError("Failed to fetch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("ai_settings_error_generic");
    expect(name.readOnly).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "settings_ai_save_and_test" }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "c9" })));
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body).toMatchObject({ name: "LAN model", base_url: "https://llm.example.org/v1", model: "llama" });
  });
});

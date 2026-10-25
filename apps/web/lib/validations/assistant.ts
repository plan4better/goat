import * as z from "zod";

/** Provider types of the assistant's model layer (spec §4.2), in the order the admin page lists them. */
export const ASSISTANT_PROVIDERS = [
  "anthropic",
  "bedrock",
  "vertex",
  "azure_openai",
  "openai",
  "mistral",
  "openai_compatible",
] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];
export type DataPolicy = "standard" | "restricted";
export type AssistantUnavailableReason =
  | "no_organization"
  | "disabled"
  | "no_connection"
  | "connection_not_allowed"
  | "credentials_unreadable";

/** GET /status (every member). */
export interface AssistantStatus {
  available: boolean;
  reason: AssistantUnavailableReason | null;
  is_admin: boolean;
  provider: string | null;
  model: string | null;
  data_policy: DataPolicy;
  /** Surfaces where the assistant is switched off (spec §6.3); the dock hides there. */
  disabled_surfaces: string[];
}

/** GET/PUT /settings (organization admins). */
export interface AssistantSettings {
  enabled: boolean;
  active_connection_id: string | null;
  data_policy: DataPolicy;
  allow_default_fallback: boolean;
  status: "ok" | AssistantUnavailableReason;
  instance: {
    goat_ai: { available: boolean; provider: string | null; model: string | null };
    org_connections: boolean;
    /** False when the service has no ASSISTANT_SECRETS_KEY: own connections are unavailable. */
    secrets_key_configured: boolean;
    allowed_providers: AssistantProvider[];
    private_endpoints: boolean;
  };
}
export type AssistantSettingsUpdate = Pick<
  AssistantSettings,
  "enabled" | "active_connection_id" | "data_policy" | "allow_default_fallback"
>;

/** One item of GET /connections. The key itself never leaves the server. */
export interface AssistantConnection {
  id: string;
  name: string;
  provider: AssistantProvider;
  base_url: string | null;
  region: string | null;
  model: string;
  /** OpenRouter only: the providers to send the model to, in order; empty, OpenRouter chooses. */
  provider_order: string[];
  allow_fallbacks: boolean;
  key_last4: string | null;
  credentials_readable: boolean;
  capabilities: Record<string, unknown>;
  tested_model: boolean;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type SecretField = "api_key" | "access_key_id" | "secret_access_key" | "service_account_json";

export interface ProviderFields {
  baseUrl: boolean;
  region: boolean;
  secrets: SecretField[];
  optionalSecrets: SecretField[];
  claudeOnly: boolean;
}

/** Mirrors apps/assistant llm/providers.py (NEEDS_BASE_URL, NEEDS_REGION, SECRET_FIELDS, CLAUDE_ONLY). */
export const PROVIDER_FIELDS: Record<AssistantProvider, ProviderFields> = {
  anthropic: { baseUrl: false, region: false, secrets: ["api_key"], optionalSecrets: [], claudeOnly: false },
  bedrock: {
    baseUrl: false,
    region: true,
    secrets: ["access_key_id", "secret_access_key"],
    optionalSecrets: [],
    claudeOnly: true,
  },
  vertex: {
    baseUrl: false,
    region: true,
    secrets: ["service_account_json"],
    optionalSecrets: [],
    claudeOnly: true,
  },
  azure_openai: {
    baseUrl: true,
    region: false,
    secrets: ["api_key"],
    optionalSecrets: [],
    claudeOnly: false,
  },
  openai: { baseUrl: false, region: false, secrets: ["api_key"], optionalSecrets: [], claudeOnly: false },
  mistral: { baseUrl: false, region: false, secrets: ["api_key"], optionalSecrets: [], claudeOnly: false },
  openai_compatible: {
    baseUrl: true,
    region: false,
    secrets: ["api_key"],
    optionalSecrets: ["api_key"],
    claudeOnly: false,
  },
};

/** Product names stay untranslated; `openai_compatible` has the label `ai_settings_provider_openai_compatible`. */
export const PROVIDER_NAMES: Record<AssistantProvider, string | null> = {
  anthropic: "Anthropic",
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  azure_openai: "Azure OpenAI",
  openai: "OpenAI",
  mistral: "Mistral AI",
  openai_compatible: null,
};

/** OpenRouter itself, not a host that merely starts with its name; as the assistant service judges it. */
export function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/** The provider names of the comma-separated field, trimmed, without empty or repeated ones. */
export const providerNames = (text: string): string[] =>
  Array.from(
    new Set(
      text
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    )
  );

export interface ConnectionFormValues {
  name: string;
  provider: AssistantProvider;
  model: string;
  /** Comma-separated in the form; a list in the payload. */
  provider_order: string;
  allow_fallbacks: boolean;
  base_url: string;
  region: string;
  api_key: string;
  access_key_id: string;
  secret_access_key: string;
  service_account_json: string;
}

export const emptyConnectionForm = (provider: AssistantProvider): ConnectionFormValues => ({
  name: "",
  provider,
  model: "",
  provider_order: "",
  allow_fallbacks: true,
  base_url: "",
  region: "",
  api_key: "",
  access_key_id: "",
  secret_access_key: "",
  service_account_json: "",
});

/** Secrets start empty when editing: an empty field keeps the stored value. */
export const toConnectionFormValues = (connection: AssistantConnection): ConnectionFormValues => ({
  ...emptyConnectionForm(connection.provider),
  name: connection.name,
  model: connection.model,
  provider_order: connection.provider_order.join(", "),
  allow_fallbacks: connection.allow_fallbacks,
  base_url: connection.base_url ?? "",
  region: connection.region ?? "",
});

interface SchemaOptions {
  mode: "create" | "edit";
  /** The instance allows private endpoints, which includes plain http. */
  allowHttp: boolean;
  /** When editing: a different provider needs new credentials. */
  originalProvider?: AssistantProvider;
}

/** Client-side checks for quick feedback; the server checks everything again. Messages are i18n keys. */
export function connectionFormSchema({ mode, allowHttp, originalProvider }: SchemaOptions) {
  return z
    .object({
      name: z.string().trim().min(1, "ai_settings_error_required").max(120),
      provider: z.enum(ASSISTANT_PROVIDERS),
      model: z.string().trim().min(1, "ai_settings_error_required").max(200),
      provider_order: z.string(),
      allow_fallbacks: z.boolean(),
      base_url: z.string(),
      region: z.string(),
      api_key: z.string(),
      access_key_id: z.string(),
      secret_access_key: z.string(),
      service_account_json: z.string(),
    })
    .superRefine((values, ctx) => {
      const fields = PROVIDER_FIELDS[values.provider];
      const issue = (path: keyof ConnectionFormValues, message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

      const baseUrl = values.base_url.trim();
      if (fields.baseUrl) {
        if (!baseUrl) issue("base_url", "ai_settings_error_required");
        else if (!(baseUrl.startsWith("https://") || (allowHttp && baseUrl.startsWith("http://"))))
          issue("base_url", "ai_settings_error_https");
      }
      if (fields.region && !values.region.trim()) issue("region", "ai_settings_error_required");
      if (providerNames(values.provider_order).length && !(fields.baseUrl && isOpenRouterUrl(baseUrl)))
        issue("provider_order", "ai_settings_error_openrouter_only");
      if (fields.claudeOnly) {
        const model = values.model.trim();
        // An inference profile ARN does not name its model; the connection test shows whether it works.
        if (model && !model.startsWith("arn:aws:bedrock:") && !model.toLowerCase().includes("claude"))
          issue("model", "ai_settings_error_claude_only");
      }
      const secretsRequired = mode === "create" || values.provider !== originalProvider;
      if (secretsRequired) {
        for (const secret of fields.secrets) {
          if (!fields.optionalSecrets.includes(secret) && !values[secret].trim())
            issue(secret, "ai_settings_error_required");
        }
      }
      if (values.provider === "vertex" && values.service_account_json.trim()) {
        try {
          const parsed = JSON.parse(values.service_account_json);
          if (parsed?.type !== "service_account") issue("service_account_json", "ai_settings_error_json");
        } catch {
          issue("service_account_json", "ai_settings_error_json");
        }
      }
    });
}

/** Body of POST /connections and PATCH /connections/{id}. */
export interface ConnectionPayload {
  name: string;
  provider: AssistantProvider;
  model: string;
  provider_order: string[];
  allow_fallbacks: boolean;
  base_url: string | null;
  region: string | null;
  credentials?: Partial<Record<SecretField, string>>;
}

export function toConnectionPayload(
  values: ConnectionFormValues,
  mode: "create" | "edit"
): ConnectionPayload {
  const fields = PROVIDER_FIELDS[values.provider];
  const credentials: Partial<Record<SecretField, string>> = {};
  for (const secret of fields.secrets) {
    const value = values[secret].trim();
    if (value) credentials[secret] = value;
  }
  const payload: ConnectionPayload = {
    name: values.name.trim(),
    provider: values.provider,
    model: values.model.trim(),
    provider_order:
      fields.baseUrl && isOpenRouterUrl(values.base_url) ? providerNames(values.provider_order) : [],
    allow_fallbacks: values.allow_fallbacks,
    base_url: fields.baseUrl ? values.base_url.trim() : null,
    region: fields.region ? values.region.trim() : null,
  };
  // Editing without a new secret leaves `credentials` out, so the stored ones stay.
  if (mode === "create" || Object.keys(credentials).length > 0) payload.credentials = credentials;
  return payload;
}

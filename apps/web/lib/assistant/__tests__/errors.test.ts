import { describe, expect, it } from "vitest";

import {
  AssistantRequestError,
  assistantErrorKey,
  runStatusKey,
  toRequestError,
} from "@/lib/assistant/errors";

/** What the AI SDK throws when the run request is refused (APICallError). */
const refused = (statusCode: number, detail?: unknown) => ({
  name: "AI_APICallError",
  message: "x",
  statusCode,
  responseBody: detail === undefined ? "" : JSON.stringify({ detail }),
});

describe("assistant error texts", () => {
  it("maps refusal codes to texts", () => {
    expect(assistantErrorKey(refused(409, { code: "conversation_busy" }))).toBe(
      "assistant_error_conversation_busy"
    );
    expect(assistantErrorKey(refused(429, { code: "user_run_limit" }))).toBe(
      "assistant_error_user_run_limit"
    );
    expect(assistantErrorKey(refused(503, { code: "shutting_down" }))).toBe("assistant_error_shutting_down");
    expect(assistantErrorKey(refused(409, { code: "conversation_bound", project_id: "p" }))).toBe(
      "assistant_error_conversation_bound"
    );
    expect(assistantErrorKey(refused(403, { code: "ai_unavailable", reason: "disabled" }))).toBe(
      "assistant_error_ai_disabled"
    );
    expect(assistantErrorKey(refused(503, { code: "ai_unavailable", reason: "no_connection" }))).toBe(
      "assistant_error_ai_unavailable"
    );
    expect(assistantErrorKey(refused(403, { code: "surface_disabled", surface: "catalog" }))).toBe(
      "assistant_error_surface_disabled"
    );
    expect(assistantErrorKey(refused(401))).toBe("assistant_error_login_failed");
    expect(
      assistantErrorKey(refused(422, { code: "invalid_request", field: "message.text", message: "x" }))
    ).toBe("assistant_error_invalid_request");
    // An answer without a detail object (a proxy's error page) is generic.
    expect(assistantErrorKey(refused(502))).toBe("assistant_error_generic");
    expect(assistantErrorKey(new AssistantRequestError(403, "project_access_lost"))).toBe(
      "assistant_error_project_access_lost"
    );
    expect(assistantErrorKey(new TypeError("Failed to fetch"))).toBe("assistant_error_offline");
    expect(assistantErrorKey(new Error("boom"))).toBe("assistant_error_generic");
  });

  it("maps the refusals of an Undo to texts", () => {
    expect(assistantErrorKey(refused(403, { code: "undo_not_allowed" }))).toBe(
      "assistant_error_undo_not_allowed"
    );
    expect(assistantErrorKey(refused(503, { code: "undo_unavailable" }))).toBe(
      "assistant_error_undo_unavailable"
    );
    expect(assistantErrorKey(refused(409, { code: "run_active" }))).toBe("assistant_error_undo_running");
    expect(assistantErrorKey(refused(404, { code: "nothing_to_undo" }))).toBe(
      "assistant_error_nothing_to_undo"
    );
  });

  it("keeps the field a refusal blames through the shared path", () => {
    const body = { code: "invalid_request", field: "message.text", message: "x" };
    expect(toRequestError(refused(422, body))?.field).toBe("message.text");
    expect(
      toRequestError(new AssistantRequestError(422, "invalid_request", "x", { field: "a" }))?.field
    ).toBe("a");
  });

  it("keeps the date of an AI credits refusal and whether it ends a trial", () => {
    const body = {
      code: "ai_credits_used_up",
      message: "The organization's AI credits are used up.",
      resets_on: "2026-12-01T00:00:00",
      on_trial: false,
    };
    const error = toRequestError(refused(402, body));
    expect(error?.code).toBe("ai_credits_used_up");
    expect(error?.resetsOn).toBe("2026-12-01T00:00:00");
    expect(error?.onTrial).toBe(false);
    expect(assistantErrorKey(error)).toBe("assistant_error_ai_credits_used_up");
    const trial = toRequestError(refused(402, { ...body, resets_on: null, on_trial: true }));
    expect(trial?.resetsOn).toBeUndefined();
    expect(trial?.onTrial).toBe(true);
    // Anything but a boolean is not a trial flag.
    expect(toRequestError(refused(402, { ...body, on_trial: "yes" }))?.onTrial).toBeUndefined();
  });

  it("maps the real 401 answer, whose detail is a string", () => {
    const unauthenticated = {
      ...refused(401),
      responseBody: JSON.stringify({ detail: "Not authenticated" }),
    };
    expect(assistantErrorKey(unauthenticated)).toBe("assistant_error_login_failed");
    expect(toRequestError(unauthenticated)?.code).toBe("request_failed");
  });

  it("maps run endings to texts", () => {
    expect(runStatusKey({ status: "cancelled", error: null, code: null })).toBe("assistant_run_cancelled");
    expect(runStatusKey({ status: "interrupted", error: null, code: null })).toBe(
      "assistant_run_interrupted"
    );
    expect(runStatusKey({ status: "failed", error: "x", code: "goat_ai_busy" })).toBe(
      "assistant_run_error_goat_ai_busy"
    );
    expect(runStatusKey({ status: "failed", error: "x", code: null })).toBe("assistant_run_error_unknown");
  });
});

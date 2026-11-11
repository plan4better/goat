import { afterEach, describe, expect, it, vi } from "vitest";

import { resendState } from "@/components/settings/members/resend";

describe("resendState", () => {
  const sent = "2026-11-02T14:25:00"; // naive UTC, as core sends it

  afterEach(() => vi.unstubAllEnvs());

  it("waits ten minutes from the last send, reading core's time as UTC on a clock east of UTC", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    // The zone took effect: read as local time, the send would be an hour early.
    expect(new Date(sent).toISOString()).toBe("2026-11-02T13:25:00.000Z");
    const state = resendState(sent, new Date("2026-11-02T14:34:59Z"));
    expect(state.allowed).toBe(false);
    expect(state.from?.toISOString()).toBe("2026-11-02T14:35:00.000Z");
  });

  it("allows it from the tenth minute on", () => {
    expect(resendState(sent, new Date("2026-11-02T14:35:00Z")).allowed).toBe(true);
    expect(resendState("2026-11-02T14:25:00+00:00", new Date("2026-11-02T15:00:00Z")).allowed).toBe(true);
  });

  it("allows it at once without a date", () => {
    expect(resendState(null, new Date())).toEqual({ allowed: true, from: null });
    expect(resendState(undefined, new Date())).toEqual({ allowed: true, from: null });
  });

  it("leaves a date it cannot read to core, as if there were none", () => {
    expect(resendState("not a date", new Date())).toEqual({ allowed: true, from: null });
  });
});

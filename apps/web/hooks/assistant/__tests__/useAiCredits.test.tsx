import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDockState, resetAssistantStore, setDockState } from "@/lib/assistant/store";

import { useAiCredits } from "@/hooks/assistant/useAiCredits";

const state = vi.hoisted(() => ({
  features: undefined as { billing?: boolean } | undefined,
  status: undefined as { goat_ai?: boolean; is_admin?: boolean } | undefined,
  balance: undefined as Record<string, unknown> | undefined,
  balanceEnabled: [] as boolean[],
}));
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: state.features }) }));
vi.mock("@/lib/api/assistant", () => ({ useAssistantStatus: () => ({ status: state.status }) }));
vi.mock("@/lib/api/usage", () => ({
  useCreditBalance: (enabled: boolean) => {
    state.balanceEnabled.push(enabled);
    return { balance: enabled ? state.balance : undefined };
  },
}));

const TIERS = [
  { max_steps: 10, credits: 1 },
  { max_steps: null, credits: 3 },
];
const BALANCE = {
  used_ai_credits: 412,
  total_ai_credits: 1000,
  ai_credit_tiers: TIERS,
  credits_reset_at: "2026-12-01T00:00:00",
  plan_renewal_date: "2026-11-30T00:00:00",
  on_trial: false,
};

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  state.features = { billing: true };
  state.status = { goat_ai: true, is_admin: false };
  state.balance = { ...BALANCE };
  state.balanceEnabled = [];
});

describe("useAiCredits", () => {
  it("gives the pool where GOAT AI answers and the organization has a limit", () => {
    const { result } = renderHook(() => useAiCredits());
    expect(result.current.pool).toEqual({
      used: 412,
      total: 1000,
      left: 588,
      percent: 41,
      level: "ok",
      resetsOn: "2026-12-01T00:00:00",
      onTrial: false,
      tiers: TIERS,
    });
    expect(result.current.usedUp).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  it("names a trial's end and the admin", () => {
    state.balance = { ...BALANCE, on_trial: true };
    state.status = { goat_ai: true, is_admin: true };
    const { result } = renderHook(() => useAiCredits());
    expect(result.current.pool).toMatchObject({ onTrial: true, resetsOn: "2026-11-30T00:00:00" });
    expect(result.current.isAdmin).toBe(true);
  });

  it("asks for no balance and shows nothing where billing is off or not known yet", () => {
    state.features = { billing: false };
    const off = renderHook(() => useAiCredits());
    expect(off.result.current).toMatchObject({ pool: null, usedUp: null });
    state.features = undefined;
    const loading = renderHook(() => useAiCredits());
    expect(loading.result.current).toMatchObject({ pool: null, usedUp: null });
    expect(state.balanceEnabled).not.toContain(true);
  });

  it("shows nothing without a limit", () => {
    state.balance = { ...BALANCE, total_ai_credits: null };
    expect(renderHook(() => useAiCredits()).result.current).toMatchObject({ pool: null, usedUp: null });
  });

  it("shows nothing where an own connection answers, also with the pool used up, and asks for no balance", () => {
    state.balance = { ...BALANCE, used_ai_credits: 1000 };
    for (const status of [{ goat_ai: false }, {}, undefined]) {
      state.status = status;
      expect(renderHook(() => useAiCredits()).result.current).toMatchObject({ pool: null, usedUp: null });
    }
    expect(state.balanceEnabled).not.toContain(true);
  });

  it("is low under a tenth left and used up at none", () => {
    state.balance = { ...BALANCE, used_ai_credits: 962 };
    expect(renderHook(() => useAiCredits()).result.current.pool).toMatchObject({ level: "low", left: 38 });
    state.balance = { ...BALANCE, used_ai_credits: 1003 };
    const { result } = renderHook(() => useAiCredits());
    expect(result.current.pool).toMatchObject({ level: "empty", left: 0, percent: 100 });
    expect(result.current.usedUp).toEqual({ resetsOn: "2026-12-01T00:00:00", onTrial: false });
  });

  it("takes the assistant's refusal at once and keeps it until a later balance shows credits left", () => {
    const { result, rerender } = renderHook(() => useAiCredits());
    expect(result.current.usedUp).toBeNull();
    // The balance read before the refusal still shows credits left.
    act(() => setDockState({ aiCreditsUsedUp: { resetsOn: "2026-12-01T00:00:00", onTrial: false } }));
    expect(result.current.usedUp).toEqual({ resetsOn: "2026-12-01T00:00:00", onTrial: false });
    // The balance read again agrees.
    state.balance = { ...BALANCE, used_ai_credits: 1000 };
    rerender();
    expect(result.current.usedUp).not.toBeNull();
    expect(getDockState().aiCreditsUsedUp).not.toBeNull();
    // Credits came back (a reset, a bigger allowance).
    state.balance = { ...BALANCE, used_ai_credits: 0 };
    rerender();
    expect(getDockState().aiCreditsUsedUp).toBeNull();
    expect(result.current.usedUp).toBeNull();
  });

  it("drops a refusal once an own connection answers, since the pool no longer applies", () => {
    setDockState({ aiCreditsUsedUp: { resetsOn: "2026-12-01T12:00:00", onTrial: false } });
    state.status = { goat_ai: false, is_admin: true };
    expect(renderHook(() => useAiCredits()).result.current.usedUp).toBeNull();
  });

  it("takes the refusal's date over the balance's, and the balance's when the refusal has none", () => {
    setDockState({ aiCreditsUsedUp: { resetsOn: "2027-01-01T00:00:00", onTrial: false } });
    expect(renderHook(() => useAiCredits()).result.current.usedUp?.resetsOn).toBe("2027-01-01T00:00:00");
    setDockState({ aiCreditsUsedUp: { resetsOn: null, onTrial: true } });
    expect(renderHook(() => useAiCredits()).result.current.usedUp).toEqual({
      resetsOn: "2026-11-30T00:00:00",
      onTrial: true,
    });
  });
});

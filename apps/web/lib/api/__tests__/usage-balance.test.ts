import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CREDITS_API_BASE_URL, refreshCreditBalance, useCreditBalance } from "@/lib/api/usage";

const { swrMock, mutateMock } = vi.hoisted(() => ({
  swrMock: vi.fn((_key: unknown, _fetcher?: unknown) => ({})),
  mutateMock: vi.fn(),
}));
vi.mock("@/lib/api/fetcher", () => ({ fetcher: vi.fn() }));
vi.mock("swr", () => ({
  default: (key: unknown, fetcher: unknown) => swrMock(key, fetcher),
  mutate: mutateMock,
}));

describe("credit balance", () => {
  beforeEach(() => {
    swrMock.mockClear();
    mutateMock.mockClear();
  });

  it("asks for the balance unless told not to, as the dock is where billing is off", () => {
    renderHook(() => useCreditBalance());
    expect(swrMock.mock.calls[0][0]).toBe(`${CREDITS_API_BASE_URL}/balance`);
    renderHook(() => useCreditBalance(false));
    expect(swrMock.mock.calls[1][0]).toBeNull();
  });

  it("reads the balance again for everyone who shows it", () => {
    void refreshCreditBalance();
    expect(mutateMock).toHaveBeenCalledWith(`${CREDITS_API_BASE_URL}/balance`);
  });
});

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOW_TICK_MS, useNow } from "@/hooks/assistant/useNow";

function Clock({ label }: { label: string }) {
  const now = useNow();
  return <span data-testid={label}>{now}</span>;
}

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 19, 10, 8));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks every reader with one shared timer, and stops it when the last one leaves", () => {
    const start = Date.now();
    const { unmount } = render(
      <>
        <Clock label="a" />
        <Clock label="b" />
      </>
    );
    expect(screen.getByTestId("a").textContent).toBe(String(start));
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    expect(screen.getByTestId("a").textContent).toBe(String(start + NOW_TICK_MS));
    expect(screen.getByTestId("b").textContent).toBe(String(start + NOW_TICK_MS));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

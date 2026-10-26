import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SaveConflict } from "@/lib/utils/revisionedSaver";

import ConflictBanner from "@/components/common/ConflictBanner";

vi.mock("react-i18next", async () => {
  const { commonI18n } = await import("@/i18n/__tests__/commonI18n");
  const i18n = commonI18n("en");
  const t = i18n.getFixedT("en", "common");
  return { useTranslation: () => ({ t, i18n }) };
});

/** Read off the DOM property: the repo's ESLint setup reads jest-dom's
 * `toBeDisabled`/`toBeEnabled` as Playwright's (async) matchers. */
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

const conflict: SaveConflict = {
  id: "wf-1",
  revision: 5,
  updatedAt: "2026-10-25T09:12:03+00:00",
  updatedBy: { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null },
};

describe("ConflictBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-25T09:14:03Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says who changed the document and when, with Reload and Keep mine", () => {
    render(
      <ConflictBanner document="workflow" conflict={conflict} onReload={vi.fn()} onKeepMine={vi.fn()} />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This workflow was changed elsewhere (by Ada Lovelace, 2 minutes ago)."
    );
    expect(button("Reload").disabled).toBe(false);
    expect(button("Keep mine").disabled).toBe(false);
  });

  it("names the document it is shown for", () => {
    render(
      <ConflictBanner
        document="report_layout"
        conflict={{ ...conflict, updatedBy: null }}
        onReload={vi.fn()}
        onKeepMine={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This layout was changed elsewhere (2 minutes ago).");
  });

  it("runs Reload and Keep mine, one at a time", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let finish: () => void = () => undefined;
    const onReload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const onKeepMine = vi.fn();
    render(
      <ConflictBanner document="dashboard" conflict={conflict} onReload={onReload} onKeepMine={onKeepMine} />
    );

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(button("Keep mine").disabled).toBe(true);

    await act(async () => {
      finish();
    });
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
  });

  it("keeps each button's label on one line, as German's longer ones need", () => {
    render(
      <ConflictBanner document="workflow" conflict={conflict} onReload={vi.fn()} onKeepMine={vi.fn()} />
    );
    for (const name of ["Reload", "Keep mine"]) {
      expect(getComputedStyle(button(name)).whiteSpace, name).toBe("nowrap");
      expect(getComputedStyle(button(name)).flexShrink, name).toBe("0");
    }
  });

  it("says when the assistant changed the workflow while the person edited it", () => {
    render(
      <ConflictBanner
        document="workflow"
        conflict={conflict}
        byAssistant
        onReload={vi.fn()}
        onKeepMine={vi.fn()}
      />
    );
    expect(screen.getByText("The assistant changed this workflow while you were editing.")).toBeTruthy();
    expect(button("Reload")).toBeTruthy();
    expect(button("Keep mine")).toBeTruthy();
  });

  it("keeps the text of every other conflict", () => {
    render(
      <ConflictBanner
        document="workflow"
        conflict={conflict}
        byAssistant={false}
        onReload={vi.fn()}
        onKeepMine={vi.fn()}
      />
    );
    expect(
      screen.getByText("This workflow was changed elsewhere (by Ada Lovelace, 2 minutes ago).")
    ).toBeTruthy();
    expect(screen.queryByText(/The assistant changed/)).toBeNull();
  });
});

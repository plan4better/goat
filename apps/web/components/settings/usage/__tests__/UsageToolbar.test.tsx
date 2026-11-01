import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import {
  DateRangePill,
  ExportPill,
  type MemberOption,
  MemberPill,
  UsageToolbar,
} from "@/components/settings/usage/UsageToolbar";

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const theme = createAppTheme({ mode: "light", locale: "en" });

const wrap = (node: ReactNode, language: "en" | "de" = "en") =>
  render(
    <ThemeProvider theme={theme}>
      <I18nextProvider i18n={commonI18n(language)}>{node}</I18nextProvider>
    </ThemeProvider>
  );

beforeEach(() => {
  // Only the clock: the captions of the day ranges count back from today.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DateRangePill", () => {
  it("chooses a preset and closes", async () => {
    const onChange = vi.fn();
    wrap(<DateRangePill value={{ preset: "period" }} onChange={onChange} onTrial={false} hasPeriod />);
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    expect(screen.getByText("Period")).toBeInTheDocument();
    // The day ranges say which days they cover.
    expect(screen.getByRole("menuitem", { name: /Last 7 days/ })).toHaveTextContent("15 to 21 Nov 2026");
    expect(screen.getByRole("menuitem", { name: /Last 30 days/ })).toHaveTextContent("23 Oct to 21 Nov 2026");
    // DOM properties rather than jest-dom's attribute, state and focus matchers: the
    // repo's ESLint setup reads those as Playwright's (async) matchers.
    expect(screen.getByRole("menuitem", { name: /This period/ }).classList).toContain("Mui-selected");
    await userEvent.click(screen.getByRole("menuitem", { name: /Last 7 days/ }));
    expect(onChange).toHaveBeenCalledWith({ preset: "d7" });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: /Last 7 days/ })).not.toBeInTheDocument()
    );
  });

  it("names the range in force on the pill and fills it", () => {
    wrap(
      <DateRangePill
        value={{ preset: "custom", from: "2026-11-03", to: "2026-11-14" }}
        onChange={vi.fn()}
        onTrial={false}
        hasPeriod
      />
    );
    expect(screen.getByRole("button", { name: "3 to 14 Nov 2026" })).toBeInTheDocument();
  });

  it("applies a custom range only with both dates", async () => {
    const onChange = vi.fn();
    wrap(<DateRangePill value={{ preset: "period" }} onChange={onChange} onTrial={false} hasPeriod />);
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-03" } });
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-14" } });
    expect(apply.disabled).toBe(false);
    await userEvent.click(apply);
    expect(onChange).toHaveBeenCalledWith({ preset: "custom", from: "2026-11-03", to: "2026-11-14" });
  });

  it("offers custom days from 2020 up to today", async () => {
    wrap(<DateRangePill value={{ preset: "period" }} onChange={vi.fn()} onTrial={false} hasPeriod />);
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    for (const label of ["From", "To"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect([input.min, input.max], label).toEqual(["2020-01-01", "2026-11-21"]);
    }
  });

  it("applies typed days past the fields' bounds as the nearest days, in order", async () => {
    // The pill, the list and the export then read the same days, and a range
    // typed wholly after today still reads one day instead of none.
    const onChange = vi.fn();
    wrap(<DateRangePill value={{ preset: "period" }} onChange={onChange} onTrial={false} hasPeriod />);
    const apply = async (from: string, to: string) => {
      await userEvent.click(screen.getByRole("button", { name: "This period" }));
      fireEvent.change(screen.getByLabelText("From"), { target: { value: from } });
      fireEvent.change(screen.getByLabelText("To"), { target: { value: to } });
      await userEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(screen.queryByLabelText("From")).not.toBeInTheDocument());
    };
    await apply("2027-01-31", "2019-03-01");
    expect(onChange).toHaveBeenLastCalledWith({ preset: "custom", from: "2020-01-01", to: "2026-11-21" });
    await apply("2030-01-01", "2030-02-01");
    expect(onChange).toHaveBeenLastCalledWith({ preset: "custom", from: "2026-11-21", to: "2026-11-21" });
    await apply("2026-11-14", "2026-11-03");
    expect(onChange).toHaveBeenLastCalledWith({ preset: "custom", from: "2026-11-03", to: "2026-11-14" });
  });

  it("drops the typed days on Cancel", async () => {
    const onChange = vi.fn();
    wrap(<DateRangePill value={{ preset: "period" }} onChange={onChange} onTrial={false} hasPeriod />);
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-03" } });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText("From")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("");
  });

  it("offers a trial no last period", async () => {
    wrap(<DateRangePill value={{ preset: "period" }} onChange={vi.fn()} onTrial hasPeriod />);
    await userEvent.click(screen.getByRole("button", { name: "Whole trial" }));
    expect(screen.getByRole("menuitem", { name: /Whole trial/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Last period/ })).not.toBeInTheDocument();
  });

  it("offers no last period without a known period", async () => {
    wrap(<DateRangePill value={{ preset: "period" }} onChange={vi.fn()} onTrial={false} hasPeriod={false} />);
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    expect(screen.getByRole("menuitem", { name: /Last 30 days/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Last period/ })).not.toBeInTheDocument();
  });

  it("names the days of this period and the last one from the period's start", async () => {
    wrap(
      <DateRangePill
        value={{ preset: "period" }}
        onChange={vi.fn()}
        onTrial={false}
        hasPeriod
        periodStart="2026-11-15T12:00:00"
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    expect(screen.getByRole("menuitem", { name: /This period/ })).toHaveTextContent("15 to 21 Nov 2026");
    // The month before the period's start, up to the day before it.
    expect(screen.getByRole("menuitem", { name: /Last period/ })).toHaveTextContent("15 Oct to 14 Nov 2026");
  });

  it("names the days of a whole trial from its start", async () => {
    wrap(
      <DateRangePill
        value={{ preset: "period" }}
        onChange={vi.fn()}
        onTrial
        hasPeriod
        periodStart="2026-11-15T12:00:00"
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Whole trial" }));
    expect(screen.getByRole("menuitem", { name: /Whole trial/ })).toHaveTextContent("15 to 21 Nov 2026");
  });
});

describe("MemberPill", () => {
  const options: MemberOption[] = [
    { id: "u1", name: "Jonas Keller", sub: "952 credits" },
    { id: "u2", name: "Anna Weber", sub: "590 credits" },
  ];

  it("picks and clears a member", async () => {
    const onChange = vi.fn();
    const { unmount } = wrap(<MemberPill value={null} options={options} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "All members" }));
    expect(screen.getByRole("menuitem", { name: /Anna Weber/ })).toHaveTextContent("590 credits");
    await userEvent.click(screen.getByRole("menuitem", { name: /Anna Weber/ }));
    expect(onChange).toHaveBeenCalledWith("u2");
    unmount();

    wrap(<MemberPill value="u2" options={options} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Anna Weber" }));
    expect(screen.getByRole("menuitem", { name: /Anna Weber/ }).classList).toContain("Mui-selected");
    await userEvent.click(screen.getByRole("menuitem", { name: "All members" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("takes another name for everyone", () => {
    wrap(<MemberPill value={null} options={options} onChange={vi.fn()} allLabel="All owners" />);
    expect(screen.getByRole("button", { name: "All owners" })).toBeInTheDocument();
  });

  it("names a chosen member who is not among the options", () => {
    // Narrowed to a member with no usage in the range picked since.
    const { unmount } = wrap(
      <MemberPill value="u9" options={options} onChange={vi.fn()} valueLabel="Paul Schmidt" />
    );
    expect(screen.getByRole("button", { name: "Paul Schmidt" })).toBeInTheDocument();
    unmount();

    // An option's own name comes first.
    wrap(<MemberPill value="u2" options={options} onChange={vi.fn()} valueLabel="Someone else" />);
    expect(screen.getByRole("button", { name: "Anna Weber" })).toBeInTheDocument();
  });

  it("keeps a name for assistive tech while the chosen member's name loads", () => {
    wrap(<MemberPill value="u9" options={options} onChange={vi.fn()} valueLabel="" />);
    const pill = screen.getByRole("button", { name: "Member" });
    // Nothing on screen claims everyone while one member is chosen.
    expect(pill).not.toHaveTextContent("All members");
  });
});

describe("ExportPill", () => {
  it("waits for the export and names a failed one", async () => {
    let fail: (error: Error) => void = () => {};
    const onExport = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        })
    );
    wrap(
      <UsageToolbar>
        <ExportPill onExport={onExport} />
      </UsageToolbar>
    );
    const pill = screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement;
    await userEvent.click(pill);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(pill.disabled).toBe(true);
    fail(new Error("500"));
    await waitFor(() => expect(pill.disabled).toBe(false));
    expect(toast.error).toHaveBeenCalledWith("The export failed. Please try again.");
  });

  it("names the export in German", () => {
    wrap(<ExportPill onExport={vi.fn(async () => {})} />, "de");
    expect(screen.getByRole("button", { name: "CSV exportieren" })).toBeInTheDocument();
  });
});

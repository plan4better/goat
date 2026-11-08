import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { declaredStyle } from "@/lib/__tests__/declaredStyle";

import {
  type UsageColumn,
  UsageList,
  type UsageListProps,
  UsagePersonCell,
  UsageTitleCell,
} from "@/components/settings/usage/UsageList";

interface Row {
  id: string;
  name: string;
  by: string;
  credits: number;
}

const rows: Row[] = Array.from({ length: 48 }, (_, i) => ({
  id: `w${i}`,
  name: `Workflow ${i}`,
  by: "Anna Weber",
  credits: 100 - i,
}));

const cols: UsageColumn<Row>[] = [
  { key: "name", label: "Workflow", width: "minmax(0, 1fr)", sortable: true, render: (r) => r.name },
  { key: "by", label: "Started by", width: "170px", render: (r) => r.by },
  {
    key: "credits",
    label: "Credits",
    width: "100px",
    align: "right",
    sortable: true,
    main: true,
    render: (r) => String(r.credits),
  },
];

const theme = createAppTheme({ mode: "light", locale: "en" });

const renderList = (props: Partial<UsageListProps<Row>> = {}) =>
  render(
    <ThemeProvider theme={theme}>
      <I18nextProvider i18n={commonI18n("en")}>
        <UsageList
          label="Workflows"
          noun={() => "workflows"}
          columns={cols}
          rows={rows.slice(0, 10)}
          rowKey={(r) => r.id}
          total={48}
          page={1}
          onPage={vi.fn()}
          sort={{ key: "credits", dir: "desc" }}
          onSort={vi.fn()}
          emptyTitle="None"
          {...props}
        />
      </I18nextProvider>
    </ThemeProvider>
  );

const realMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe("UsageList", () => {
  it("says which rows it shows and pages", async () => {
    const onPage = vi.fn();
    renderList({ onPage });
    expect(screen.getByText("1–10 of 48 workflows")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Workflows" })).toBeInTheDocument();
    // The header row and ten rows.
    expect(screen.getAllByRole("row")).toHaveLength(11);
    await userEvent.click(screen.getByRole("button", { name: /page 2/i }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it("writes the range of a later page and no pager for one page", () => {
    renderList({ rows: rows.slice(40), page: 5 });
    expect(screen.getByText("41–48 of 48 workflows")).toBeInTheDocument();
    renderList({ rows: rows.slice(0, 4), total: 4 });
    expect(screen.getByText("1–4 of 4 workflows")).toBeInTheDocument();
    // Only the first list (48 rows) has pages.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  it("marks the sorted column and sorts by a click", async () => {
    const onSort = vi.fn();
    renderList({ onSort });
    // DOM properties rather than jest-dom's attribute, state and focus matchers: the
    // repo's ESLint setup reads those as Playwright's (async) matchers.
    expect(screen.getByRole("columnheader", { name: "Credits" }).getAttribute("aria-sort")).toBe(
      "descending"
    );
    expect(screen.getByRole("columnheader", { name: "Workflow" }).getAttribute("aria-sort")).toBe("none");
    // A column that does not sort says nothing about sorting.
    expect(screen.getByRole("columnheader", { name: "Started by" }).hasAttribute("aria-sort")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Workflow" }));
    expect(onSort).toHaveBeenCalledWith("name");
  });

  it("writes its buttons in the app's font, not the browser's button font", () => {
    renderList({
      chips: [
        { label: "A", onRemove: vi.fn() },
        { label: "B", onRemove: vi.fn() },
      ],
      onClearAll: vi.fn(),
    });
    for (const name of ["Workflow", "Remove all"]) {
      expect(declaredStyle(screen.getByRole("button", { name }), "font-family")).toBe("inherit");
    }
  });

  it("shows chips and Remove all from two on", async () => {
    const removeMember = vi.fn();
    const removeSearch = vi.fn();
    const onClearAll = vi.fn();
    const { unmount } = renderList({
      chips: [{ label: "Member: Anna Weber", onRemove: removeMember }],
      onClearAll,
    });
    expect(screen.getByText("Member: Anna Weber")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove all" })).not.toBeInTheDocument();
    unmount();

    renderList({
      chips: [
        { label: "Member: Anna Weber", onRemove: removeMember },
        { label: "Search: kita", onRemove: removeSearch },
      ],
      onClearAll,
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    const remove = screen.getByTitle("Remove the filter Search: kita").closest("svg");
    fireEvent.click(remove as SVGElement);
    expect(removeSearch).toHaveBeenCalledTimes(1);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it("names a chip's remove button with the text as typed", () => {
    renderList({ chips: [{ label: "Search: O'Brien & Co", onRemove: vi.fn() }] });
    expect(screen.getByTitle("Remove the filter Search: O'Brien & Co")).toBeInTheDocument();
  });

  it("shows the empty state at 0 and the skeleton while loading", () => {
    const { unmount } = renderList({
      rows: [],
      total: 0,
      emptyTitle: "No workflows with these filters",
      emptyHint: "Try another name or clear the filters.",
      chips: [{ label: "Search: kita", onRemove: vi.fn() }],
    });
    expect(screen.getByText("No workflows")).toBeInTheDocument();
    expect(screen.getByText("No workflows with these filters")).toBeInTheDocument();
    expect(screen.getByText("Try another name or clear the filters.")).toBeInTheDocument();
    // The filters that emptied the list stay there to be removed.
    expect(screen.getByText("Search: kita")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    unmount();

    const { container } = renderList({ rows: undefined, isLoading: true });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/of 48/)).not.toBeInTheDocument();
    const skeletons = container.querySelectorAll<HTMLElement>(".MuiSkeleton-root");
    expect(skeletons).toHaveLength(7);
    // The loading rows are as high as the real ones.
    expect(skeletons[1].style.height).toBe("57px");
  });

  it("keeps the rows in sight while the next page loads", () => {
    const onPage = vi.fn();
    // Page 2 asked for, page 1's rows still at hand.
    const { container } = renderList({ rows: rows.slice(0, 10), page: 2, isLoading: true, onPage });
    expect(container.querySelector(".MuiSkeleton-root")).toBeNull();
    const table = screen.getByRole("table", { name: "Workflows" });
    expect(within(table).getByText("Workflow 0")).toBeInTheDocument();
    expect(table.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("11–20 of 48 workflows")).toBeInTheDocument();
    expect(onPage).not.toHaveBeenCalled();
  });

  it("asks for the last page when a filter leaves fewer pages", () => {
    // Page 4 of a list that now has 15 rows: two pages.
    const onPage = vi.fn();
    renderList({ rows: [], total: 15, page: 4, onPage });
    expect(onPage).toHaveBeenCalledWith(2);
    expect(screen.getByText("11–15 of 15 workflows")).toBeInTheDocument();
  });

  it("keeps the first and the main column on a phone", () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    renderList();
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      expect.stringContaining("Workflow"),
      expect.stringContaining("Credits"),
    ]);
    expect(within(screen.getAllByRole("row")[1]).getAllByRole("cell")).toHaveLength(2);
  });
});

describe("UsageTitleCell", () => {
  const wrap = (node: ReactNode) =>
    render(
      <ThemeProvider theme={theme}>
        <I18nextProvider i18n={commonI18n("en")}>{node}</I18nextProvider>
      </ThemeProvider>
    );

  it("links the name, or narrows by it with a hint", async () => {
    const { unmount } = wrap(<UsageTitleCell title="Kitas" sub="12 runs" href="/projects/p1" />);
    expect(screen.getByRole("link", { name: "Kitas" }).getAttribute("href")).toBe("/projects/p1");
    expect(screen.getByText("12 runs")).toBeInTheDocument();
    unmount();

    const onClick = vi.fn();
    wrap(<UsageTitleCell title="Anna Weber" onClick={onClick} hint="Show only Anna Weber" />);
    const button = screen.getByRole("button", { name: "Anna Weber" });
    expect(button.getAttribute("title")).toBe("Show only Anna Weber");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("names a person beside their avatar, as a button when it narrows", async () => {
    const onClick = vi.fn();
    const { unmount } = wrap(<UsagePersonCell id="u2" name="Anna Weber" />);
    expect(screen.getByText("Anna Weber")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();

    wrap(
      <UsagePersonCell id="u2" name="Anna Weber" onClick={onClick} hint="Show only layers of Anna Weber" />
    );
    await userEvent.click(screen.getByRole("button", { name: "Anna Weber" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

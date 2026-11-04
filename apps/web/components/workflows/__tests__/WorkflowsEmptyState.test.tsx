import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTemplates } from "@/lib/api/templates";
import { DOCS_URL } from "@/lib/constants";

import WorkflowsEmptyState from "@/components/workflows/WorkflowsEmptyState";

const { templatesState, languageState } = vi.hoisted(() => ({
  templatesState: { total: 0 },
  languageState: { language: "en" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: languageState }),
}));
vi.mock("@/lib/api/templates", () => ({
  useTemplates: vi.fn(() => ({ page: { items: [], total: templatesState.total } })),
}));

const makeCreation = (overrides: Partial<Parameters<typeof WorkflowsEmptyState>[0]["creation"]> = {}) => ({
  canCreate: true,
  isCreating: false,
  createFromScratch: vi.fn(async () => undefined),
  openTemplateBrowser: vi.fn(),
  ...overrides,
});

describe("WorkflowsEmptyState", () => {
  beforeEach(() => {
    templatesState.total = 0;
    languageState.language = "en";
  });

  it("says what a workflow is and starts a new one from scratch", async () => {
    const creation = makeCreation();
    const user = userEvent.setup();
    render(<WorkflowsEmptyState creation={creation} />);

    expect(screen.getByRole("heading", { name: "workflow_empty_title" })).toBeInTheDocument();
    expect(screen.getByText("workflow_empty_body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "workflow_empty_new" }));
    expect(creation.createFromScratch).toHaveBeenCalledTimes(1);
  });

  it("offers a template only when the user can see a workflow template", async () => {
    const creation = makeCreation();
    const user = userEvent.setup();
    const { rerender } = render(<WorkflowsEmptyState creation={creation} />);
    expect(useTemplates).toHaveBeenCalledWith({ source: "all", kind: "workflow", size: 1 });
    expect(screen.queryByRole("button", { name: "workflow_empty_template" })).not.toBeInTheDocument();

    templatesState.total = 2;
    rerender(<WorkflowsEmptyState creation={creation} />);
    await user.click(screen.getByRole("button", { name: "workflow_empty_template" }));
    expect(creation.openTemplateBrowser).toHaveBeenCalledTimes(1);
  });

  it("links to the workflows page of the docs, in German for a German UI", () => {
    const { rerender } = render(<WorkflowsEmptyState creation={makeCreation()} />);
    // DOM properties rather than jest-dom's `toHaveAttribute` and `toBeDisabled`:
    // the repo's ESLint setup reads them as Playwright's (async) matchers.
    expect(screen.getByRole("link", { name: "workflow_empty_learn" }).getAttribute("href")).toBe(
      `${DOCS_URL}/workflows/workflow_interface`
    );

    languageState.language = "de";
    rerender(<WorkflowsEmptyState creation={makeCreation()} />);
    expect(screen.getByRole("link", { name: "workflow_empty_learn" }).getAttribute("href")).toBe(
      `${DOCS_URL}/de/workflows/workflow_interface`
    );
  });

  it("waits while a workflow is being created", () => {
    render(<WorkflowsEmptyState creation={makeCreation({ isCreating: true })} />);
    expect((screen.getByRole("button", { name: "workflow_empty_new" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});

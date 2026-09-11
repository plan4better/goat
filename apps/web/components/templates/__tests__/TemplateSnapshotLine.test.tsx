import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TemplateRead } from "@/lib/validations/template";

import TemplateSnapshotLine from "@/components/templates/TemplateSnapshotLine";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));

const projectId = "00000000-0000-0000-0000-0000000000p1".replace("p1", "0001");
const workflowId = "00000000-0000-0000-0000-000000000011";

const base = {
  id: "t1",
  name: "T",
  payload_kind: "workflow",
  updated_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  source: {
    kind: "workflow",
    project_id: projectId,
    project_name: "Analysis",
    workflow_id: workflowId,
    workflow_name: "Güteklassen",
    layout_id: null,
    layout_name: null,
    available: true,
  },
} as unknown as TemplateRead;

describe("TemplateSnapshotLine", () => {
  it("links the workflow and the project it was saved from", async () => {
    render(<TemplateSnapshotLine template={base} onRefresh={async () => {}} />);
    await expect(screen.getByRole("link", { name: /Güteklassen/ })).toHaveAttribute(
      "href",
      `/map/${projectId}?workflow=${workflowId}`
    );
    await expect(screen.getByRole("link", { name: /Analysis/ })).toHaveAttribute("href", `/map/${projectId}`);
    await expect(screen.getByRole("button", { name: "update_template_from_source" })).toBeEnabled();
  });

  it("says the source is gone and disables the refresh", async () => {
    const gone = {
      ...base,
      source: { ...(base.source as object), available: false, workflow_name: null },
    } as TemplateRead;
    render(<TemplateSnapshotLine template={gone} onRefresh={async () => {}} />);
    expect(screen.getByText('source_unavailable:{"kind":"template_kind_workflow"}')).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "update_template_from_source" })).toBeDisabled();
  });

  it("runs the refresh", () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<TemplateSnapshotLine template={base} onRefresh={onRefresh} />);
    screen.getByRole("button", { name: "update_template_from_source" }).click();
    expect(onRefresh).toHaveBeenCalled();
  });
});

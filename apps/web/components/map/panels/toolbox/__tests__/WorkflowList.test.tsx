import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import WorkflowList from "@/components/map/panels/toolbox/WorkflowList";

const description =
  "Created with the GOAT AI assistant. Check the steps and settings before you use the results.";

vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "p1" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/api/workflows", () => ({
  useWorkflows: () => ({
    workflows: [{ id: "w1", name: "Schools nearby", description }],
    isLoading: false,
  }),
}));

describe("WorkflowList", () => {
  it("keeps a long description whole and leaves the cut to the line clamp", () => {
    render(<WorkflowList onSelectWorkflow={vi.fn()} />);

    expect(screen.getByText(description)).toBeInTheDocument();
  });
});

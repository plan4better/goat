import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import AddLayerMenu from "@/components/addLayer/AddLayerMenu";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/** The dialog a menu entry opens, reduced to which source it was asked for. */
const opened: (string | null)[] = [];
vi.mock("@/components/addLayer/AddLayerDialog", () => ({
  default: ({ source }: { source: string | null }) => {
    opened.push(source);
    return source ? <div data-testid="dialog">{source}</div> : null;
  },
}));

describe("AddLayerMenu", () => {
  const anchor = () => document.body.appendChild(document.createElement("button"));

  it("groups the entries: new data, then what is already in GOAT", () => {
    render(<AddLayerMenu anchorEl={anchor()} onClose={vi.fn()} projectId="p1" />);
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["upload_dataset", "create_layer", "connect_service", "my_datasets", "catalog"]);
    expect(screen.getByText("add_layer_group_new")).toBeInTheDocument();
    expect(screen.getByText("add_layer_group_existing")).toBeInTheDocument();
    // GOAT's open data lives in Connect data's rail, not in the menu.
    expect(screen.queryByText("connect_group_goat")).not.toBeInTheDocument();
  });

  it("opens Connect data", async () => {
    const user = userEvent.setup();
    render(<AddLayerMenu anchorEl={anchor()} onClose={vi.fn()} projectId="p1" />);
    await user.click(screen.getByRole("menuitem", { name: "connect_service" }));
    expect(screen.getByTestId("dialog").textContent).toBe("connect");
  });

  it("keeps the project-only entries out without a project", () => {
    render(<AddLayerMenu anchorEl={anchor()} onClose={vi.fn()} />);
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["upload_dataset", "connect_service"]);
  });
});

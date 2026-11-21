import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ManageIconsDialog } from "@/components/map/panels/style/marker/ManageIconDialog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe("ManageIconsDialog", () => {
  it("renders the title, the empty state and the dismissing action", () => {
    render(<ManageIconsDialog open onClose={vi.fn()} markers={[]} onDelete={vi.fn()} onUpdate={vi.fn()} />);

    expect(screen.getByText("manage_icons")).toBeInTheDocument();
    expect(screen.getByText("no_custom_icons")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "cancel" })).toBeInTheDocument();
  });

  it("closes from that action", () => {
    const onClose = vi.fn();
    render(<ManageIconsDialog open onClose={onClose} markers={[]} onDelete={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("loads each icon as a CORS request, as the map loads it", async () => {
    const url = "https://core.example/api/v2/asset/file/users/u1/icons/bench.png";
    render(
      <ManageIconsDialog
        open
        onClose={vi.fn()}
        markers={[{ id: "1", name: "Bench", url, source: "custom", category: "" }]}
        onDelete={vi.fn()}
        onUpdate={vi.fn()}
      />
    );

    const image = await screen.findByAltText("Bench");
    expect(image.getAttribute("src")).toBe(url);
    expect(image.getAttribute("crossorigin")).toBe("anonymous");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProjectPickerMenu from "@/components/assistant/messages/ProjectPickerMenu";

const content = vi.hoisted(() => ({ params: [] as unknown[] }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/lib/api/content", () => ({
  useSpaces: () => ({ spaces: [{ id: "s1", kind: "team", name: "Radverkehr team" }] }),
  useContent: (params: unknown) => {
    content.params.push(params);
    return {
      isLoading: false,
      page: {
        items: [
          { id: "p1", name: "Radnetz", my_role: "owner", space_id: "s1" },
          { id: "p2", name: "Nur lesen", my_role: "viewer", space_id: "s1" },
          { id: "p3", name: "Parken", my_role: "editor", space_id: "s1" },
        ],
      },
    };
  },
}));

describe("ProjectPickerMenu", () => {
  it("lists the recent projects the user may edit, with their space, and hands back the pick", () => {
    const onPick = vi.fn();
    render(<ProjectPickerMenu anchor={document.body} onClose={vi.fn()} onPick={onPick} />);
    expect(screen.getByText("Radnetz")).toBeTruthy();
    expect(screen.getByText("Parken")).toBeTruthy();
    // A project the user can only view cannot take a layer.
    expect(screen.queryByText("Nur lesen")).toBeNull();
    expect(screen.getAllByText("Radverkehr team")).toHaveLength(2);
    expect(content.params[0]).toMatchObject({ view: "recent", types: "project", order_by: "last_opened_at" });
    fireEvent.click(screen.getByText("Parken"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "p3" }));
  });
});

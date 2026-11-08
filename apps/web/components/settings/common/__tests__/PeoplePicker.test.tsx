import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import PeoplePicker, { type Person } from "@/components/settings/common/PeoplePicker";

const PEOPLE: Person[] = [
  { id: "u1", name: "Anna Weber", email: "anna@x.de", roleWord: "Bearbeiter" },
  { id: "u2", name: "ben@x.de", email: "ben@x.de", roleWord: "Betrachter" },
];

function Picker({ people = PEOPLE }: { people?: Person[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  return (
    <I18nextProvider i18n={commonI18n("de")}>
      <PeoplePicker
        people={people}
        selected={selected}
        onToggle={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
        query={query}
        onQuery={setQuery}
      />
    </I18nextProvider>
  );
}

describe("PeoplePicker", () => {
  it("counts who is not in the team and who is chosen", async () => {
    render(<Picker />);
    expect(screen.getByRole("status")).toHaveTextContent("2 Personen der Organisation nicht im Team");
    await userEvent.click(screen.getByRole("checkbox", { name: "Anna Weber" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 ausgewählt, 2 nicht im Team");
    await expect(screen.getByRole("checkbox", { name: "Anna Weber" })).toBeChecked();
  });

  it("ticks a person by keyboard, the box itself taking the focus, the address as its description", async () => {
    render(<Picker />);
    await userEvent.click(screen.getByPlaceholderText("Name oder E-Mail suchen"));
    await userEvent.tab();
    const anna = screen.getByRole("checkbox", { name: "Anna Weber" });
    await expect(anna).toHaveFocus();
    await expect(anna).toHaveAccessibleDescription("anna@x.de · Bearbeiter");
    await userEvent.keyboard(" ");
    await expect(anna).toBeChecked();
    // Clicking the name ticks it too, as the row is the box's label.
    await userEvent.click(screen.getByText("ben@x.de"));
    await expect(screen.getByRole("checkbox", { name: "ben@x.de" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("2 ausgewählt, 2 nicht im Team");
  });

  it("keeps the box's focus circle inside the scrolling list", () => {
    render(<Picker />);
    const box = screen
      .getByRole("checkbox", { name: "Anna Weber" })
      .closest(".MuiCheckbox-root") as HTMLElement;
    // No negative edge margin, which pushes the circle past the list's overflow edge.
    expect(parseFloat(getComputedStyle(box).marginLeft || "0")).toBeGreaterThanOrEqual(0);
  });

  it("finds people by name or address and says when nobody matches", async () => {
    render(<Picker />);
    await userEvent.type(screen.getByPlaceholderText("Name oder E-Mail suchen"), "BEN@");
    expect(screen.queryByRole("checkbox", { name: "Anna Weber" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "ben@x.de" })).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Name oder E-Mail suchen"), "zzz");
    expect(screen.getByText("Niemand passt zu dieser Suche.")).toBeInTheDocument();
  });

  it("says so when everyone is in the team already", () => {
    render(<Picker people={[]} />);
    expect(screen.getByText("Alle Personen der Organisation sind schon in diesem Team.")).toBeInTheDocument();
    // Not also "0 Personen der Organisation nicht im Team".
    expect(screen.queryByRole("status")).toBeNull();
  });
});

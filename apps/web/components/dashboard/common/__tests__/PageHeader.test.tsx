import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PageHeader from "@/components/dashboard/common/PageHeader";

describe("PageHeader", () => {
  it("is a level one heading by default, as on Home and Content", () => {
    render(<PageHeader title="Content" />);
    expect(screen.getByRole("heading", { level: 1, name: "Content" })).toBeInTheDocument();
  });

  it("names the nav group above a level two title on a settings page", () => {
    render(
      <PageHeader level={2} eyebrow="Konto" title="Profil" subtitle="So sehen Sie andere." titleId="t" />
    );
    const heading = screen.getByRole("heading", { level: 2, name: "Profil" });
    expect(heading.id).toBe("t");
    const eyebrow = screen.getByText("Konto");
    expect(eyebrow.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("So sehen Sie andere.")).toBeInTheDocument();
  });

  it("breaks a long word in the subtitle instead of running past the column", () => {
    render(<PageHeader level={2} title="Mitglieder" subtitle="Stadtverwaltungsorganisationseinheitsname" />);
    expect(getComputedStyle(screen.getByText("Stadtverwaltungsorganisationseinheitsname")).overflowWrap).toBe(
      "anywhere"
    );
  });
});

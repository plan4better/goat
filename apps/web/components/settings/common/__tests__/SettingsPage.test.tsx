import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsPage from "@/components/settings/common/SettingsPage";

/** The nearest ancestor that scrolls, or null. */
const scrollerOf = (element: Element) => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "auto") return node;
  }
  return null;
};

const page = (body = "first card") => (
  <SettingsPage header={<PageHeader level={2} eyebrow="Account" title="Profile" subtitle="Who you are." />}>
    <section>{body}</section>
    <section>second card</section>
  </SettingsPage>
);

describe("SettingsPage", () => {
  it("scrolls the page as one: its heading first, then the cards, in a single scroll area", () => {
    render(page());
    const heading = screen.getByRole("heading", { level: 2, name: "Profile" });
    const body = scrollerOf(screen.getByText("first card"));
    expect(body).not.toBeNull();
    expect(scrollerOf(heading)).toBe(body);
    expect(scrollerOf(screen.getByText("second card"))).toBe(body);
    expect(scrollerOf(body as Element)).toBeNull();
    expect(
      heading.compareDocumentPosition(screen.getByText("first card")) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("is only the scroll area when a page has no heading of its own", () => {
    const { container } = render(
      <SettingsPage>
        <section>only card</section>
      </SettingsPage>
    );
    expect(scrollerOf(screen.getByText("only card"))).toBe(container.firstElementChild);
  });
});

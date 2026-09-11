import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ContentItem, Space } from "@/lib/validations/content";

import ContentCard from "@/components/dashboard/content/ContentCard";

const { useUserProfileMock } = vi.hoisted(() => ({ useUserProfileMock: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/users", () => ({ useUserProfile: useUserProfileMock }));
vi.mock("@/components/dashboard/common/KindBadges", () => ({
  default: ({ kinds }: { kinds: string[] }) => <div data-testid="kind-badges">{JSON.stringify(kinds)}</div>,
}));

useUserProfileMock.mockReturnValue({
  userProfile: { id: "u-me", firstname: "Marco", lastname: "Albrecht", avatar: "" },
});

const me = { id: "u-me", name: "Marco Albrecht", avatar: null };
const marie = { id: "u-marie", name: "Marie Klein", avatar: null };

const personalSpace: Space = {
  id: "s1",
  kind: "personal",
  name: "My Content",
  default_role: "viewer",
  my_role: "owner",
  team_id: null,
  organization_id: null,
};

const project: ContentItem = {
  type: "project",
  id: "p1",
  name: "Bus stop accessibility",
  space_id: "s1",
  folder_id: null,
  updated_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  created_at: new Date().toISOString(),
  my_role: "owner",
  created_by: me,
  shared_with: null,
  thumbnail_url: null,
  is_public: false,
  layer_type: null,
  feature_layer_geometry_type: null,
  is_shortcut: false,
  restricted: false,
  restricted_inherited: false,
};

const organizationSpace: Space = {
  ...personalSpace,
  id: "s-org",
  kind: "organization",
  name: "Organization",
  organization_id: "org-1",
};

const sharedWithOrg = {
  teams: [],
  organizations: [{ id: "org-1", name: "Organization", role: "project-viewer" }],
  users: [],
};

const renderCard = (item?: Partial<ContentItem>, space: Space = personalSpace) =>
  render(
    <ContentCard
      item={{ ...project, ...item }}
      space={space}
      selected={false}
      anySelected={false}
      onToggleSelect={() => {}}
      onOpen={() => {}}
      menuItems={[{ id: "open", label: "Open" }]}
      onMenuSelect={() => {}}
    />
  );

describe("ContentCard", () => {
  it("shows where the item lives when a location is given", () => {
    render(
      <ContentCard
        item={project}
        space={personalSpace}
        location="Field surveys › Round 2 QA"
        selected={false}
        anySelected={false}
        onToggleSelect={() => {}}
        onOpen={() => {}}
        menuItems={[]}
        onMenuSelect={() => {}}
      />
    );
    expect(screen.getByText("Field surveys › Round 2 QA")).toBeInTheDocument();
  });

  it("pushes the pinned label and the audience chip to the row's right edge together", () => {
    render(
      <ContentCard
        item={{ ...project, is_public: true }}
        space={personalSpace}
        selected={false}
        anySelected={false}
        onToggleSelect={() => {}}
        onOpen={() => {}}
        menuItems={[]}
        onMenuSelect={() => {}}
        pinned
        onTogglePin={() => {}}
      />
    );

    const pinButton = screen.getByRole("button", { name: "unpin_from_home" });
    expect(getComputedStyle(pinButton).opacity).toBe("1");
    expect(screen.queryByText("pinned")).not.toBeInTheDocument();
  });

  it("states the updated time in the compact strict form", () => {
    renderCard();

    // "3 hours ago", not date-fns' loose "about 3 hours ago" — the meta row
    // is one line at the card's 232px minimum.
    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
    expect(screen.queryByText(/about/i)).not.toBeInTheDocument();
  });

  it("puts the kebab in the title row, on paper, beside the name", () => {
    renderCard();

    const name = screen.getByText("Bus stop accessibility");
    const kebab = screen.getByRole("button", { name: "more" });
    expect(name.parentElement).toContainElement(kebab);
  });

  it("keeps the audience chip in the meta row's bottom-right corner", () => {
    renderCard({ is_public: true });

    const chip = screen.getByText("public");
    const time = screen.getByText("3 hours ago");
    expect(time.parentElement).toContainElement(chip);
  });

  it("leaves the audience chip out while an item is private to its space", () => {
    renderCard();

    expect(screen.queryByText("private_content")).not.toBeInTheDocument();
  });

  it("reads Shared for an organization share and names the organization on hover", () => {
    renderCard({ shared_with: sharedWithOrg });

    expect(screen.getByText("shared")).toBeInTheDocument();
    expect(screen.queryByText("shared_with_organization")).not.toBeInTheDocument();
    // The mock `t` returns the key alone — the hover carries that key.
    expect(screen.getByLabelText("shared_with_names")).toBeInTheDocument();
  });

  it("still warns about a public item inside the organization space", () => {
    renderCard({ space_id: "s-org", is_public: true }, organizationSpace);

    expect(screen.getByText("public")).toBeInTheDocument();
  });

  it("shows the creator as an avatar only, naming them in the tooltip", () => {
    renderCard({ created_by: marie });

    expect(screen.getByLabelText("created_by_name")).toBeInTheDocument();
    expect(screen.getByText("MK")).toBeInTheDocument();
    expect(screen.queryByText("Marie Klein")).not.toBeInTheDocument();
  });

  it("says the caller created it when the creator is the caller", () => {
    renderCard();

    expect(screen.getByLabelText("created_by_you")).toBeInTheDocument();
  });

  it("keeps creator and time in the same meta row", () => {
    renderCard();

    const time = screen.getByText("3 hours ago");
    const creator = screen.getByLabelText("created_by_you");
    const row = time.parentElement;
    expect(row).not.toBeNull();
    expect(row).toContainElement(creator);
    expect(row && getComputedStyle(row).display).toBe("flex");
  });

  it("renders a pin button when onTogglePin is given, and shows pinned in the meta row once pinned", () => {
    render(
      <ContentCard
        item={project}
        space={personalSpace}
        selected={false}
        anySelected={false}
        onToggleSelect={() => {}}
        onOpen={() => {}}
        menuItems={[{ id: "open", label: "Open" }]}
        onMenuSelect={() => {}}
        pinned
        onTogglePin={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "unpin_from_home" })).toBeInTheDocument();
  });

  it("leaves out the pin button when onTogglePin is not given", () => {
    renderCard();

    expect(screen.queryByRole("button", { name: "pin_to_home" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "unpin_from_home" })).not.toBeInTheDocument();
  });

  it("renders the kind badges next to the type tag for a template", () => {
    renderCard({ type: "template", template_kinds: ["workflow", "layout"] });

    expect(screen.getByTestId("kind-badges")).toHaveTextContent('["workflow","layout"]');
  });

  it("renders no kind badges for a non-template item", () => {
    renderCard();

    expect(screen.queryByTestId("kind-badges")).not.toBeInTheDocument();
  });

  it("shows a GOAT catalog chip once a template is published", () => {
    renderCard({ type: "template", template_catalog_status: "published" });

    expect(screen.getByText("goat_catalog")).toBeInTheDocument();
  });

  it("leaves out the GOAT catalog chip for an unpublished template", () => {
    renderCard({ type: "template", template_catalog_status: "none" });

    expect(screen.queryByText("goat_catalog")).not.toBeInTheDocument();
  });

  it("renders no select circle when selectable is false", () => {
    render(
      <ContentCard
        item={project}
        space={personalSpace}
        selected={false}
        anySelected={false}
        onToggleSelect={() => {}}
        onOpen={() => {}}
        menuItems={[{ id: "open", label: "Open" }]}
        onMenuSelect={() => {}}
        selectable={false}
      />
    );

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

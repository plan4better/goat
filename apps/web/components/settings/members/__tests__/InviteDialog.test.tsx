import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ApiError } from "@/lib/api/apiError";

import InviteDialog from "@/components/settings/members/InviteDialog";
import { seatsOf } from "@/components/settings/members/seats";

const api = vi.hoisted(() => ({ inviteMember: vi.fn() }));
vi.mock("@/lib/api/organizations", () => ({ inviteMember: api.inviteMember }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const renderDialog = (props: Partial<Parameters<typeof InviteDialog>[0]> = {}) => {
  const onClose = vi.fn();
  const onChanged = vi.fn().mockResolvedValue(undefined);
  render(
    <I18nextProvider i18n={commonI18n("en")}>
      <InviteDialog
        organizationId="org-1"
        organizationName="Stadt Musterhausen"
        seats={seatsOf({ used_editors: 3, total_editors: 5, used_viewers: 0, total_viewers: null })}
        known={new Set(["otto@example.com"])}
        onClose={onClose}
        onChanged={onChanged}
        {...props}
      />
    </I18nextProvider>
  );
  return { onClose, onChanged };
};

const addresses = () => screen.getByLabelText("Email addresses");

describe("InviteDialog", () => {
  beforeEach(() => {
    api.inviteMember.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.warning).mockReset();
  });

  it("starts on Editor while an editor seat is free and shows each pool's free seats", async () => {
    renderDialog();
    await expect(screen.getByRole("radio", { name: /^Editor/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^Editor/ })).toHaveTextContent("2 of 5 free");
    expect(screen.getByRole("radio", { name: /^Viewer/ })).toHaveTextContent("No limit");
    await expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  });

  it("names invalid and known addresses, one problem at a time", async () => {
    renderDialog();
    await userEvent.type(addresses(), "nope, Otto@Example.com,");
    expect(screen.getByRole("alert")).toHaveTextContent("This address is invalid: nope.");
    fireEvent.click(screen.getByTitle("Remove nope").closest("svg") as SVGElement);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "otto@example.com already belongs to the organization or is invited."
    );
    await expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  });

  it("refuses more people than the chosen pool has free seats", async () => {
    renderDialog();
    await userEvent.type(addresses(), "a@x.de b@x.de c@x.de ");
    expect(screen.getByRole("alert")).toHaveTextContent("Only 2 editor seats are free for 3 invitations.");
    await expect(screen.getByRole("radio", { name: /^Editor/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("radio", { name: /^Viewer/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    await expect(screen.getByRole("button", { name: "Send 3 invitations" })).toBeEnabled();
  });

  it("refuses more than 20 addresses at once", async () => {
    renderDialog({
      seats: seatsOf({ used_editors: 0, total_editors: null, used_viewers: 0, total_viewers: null }),
    });
    await userEvent.click(addresses());
    await userEvent.paste(Array.from({ length: 21 }, (_, i) => `p${i}@x.de`).join(","));
    expect(screen.getByRole("alert")).toHaveTextContent("At most 20 addresses at once.");
    await expect(screen.getByRole("button", { name: "Send 21 invitations" })).toBeDisabled();
  });

  it("sends one request per address, in order, and closes when all went out", async () => {
    api.inviteMember.mockResolvedValue(answer({ account_setup: null }));
    const { onClose, onChanged } = renderDialog();
    await userEvent.type(addresses(), "a@x.de,b@x.de,");
    await userEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    expect(api.inviteMember.mock.calls.map(([, body]) => body)).toEqual([
      { user_email: "a@x.de", role: "organization-editor" },
      { user_email: "b@x.de", role: "organization-editor" },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith("2 invitations sent.");
    expect(onClose).toHaveBeenCalled();
  });

  it("takes each address out of the field once it went out, so the refreshed list never flags it", async () => {
    // What the dialog shows while the next request goes out, after the page
    // has read the list (and so the address just invited) again.
    const shown: (string | null)[] = [];
    api.inviteMember.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      shown.push(screen.queryByRole("alert")?.textContent ?? null);
      return answer({ account_setup: null });
    });
    const onClose = vi.fn();
    const Page = () => {
      const [known, setKnown] = useState(new Set<string>());
      const [usedEditors, setUsedEditors] = useState(0);
      return (
        <InviteDialog
          organizationId="org-1"
          organizationName="Stadt Musterhausen"
          seats={seatsOf({
            used_editors: usedEditors,
            total_editors: 2,
            used_viewers: 0,
            total_viewers: null,
          })}
          known={known}
          onClose={onClose}
          onChanged={async () => {
            const invited = api.inviteMember.mock.calls.map(([, body]) => body.user_email as string);
            setKnown(new Set(invited));
            setUsedEditors(invited.length);
          }}
        />
      );
    };
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <Page />
      </I18nextProvider>
    );
    await userEvent.type(addresses(), "a@x.de,b@x.de,");
    await userEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(shown).toEqual([null, null]);
  });

  it("goes on after a failure: the next address still goes out and leaves the field", async () => {
    api.inviteMember
      .mockRejectedValueOnce(new ApiError(400, "User has already been invited"))
      .mockResolvedValueOnce(answer({ account_setup: null }));
    const { onClose, onChanged } = renderDialog();
    await userEvent.type(addresses(), "a@x.de,b@x.de,");
    await userEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    expect(api.inviteMember.mock.calls.map(([, body]) => body.user_email)).toEqual(["a@x.de", "b@x.de"]);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Invitation sent to b@x.de.");
    expect(screen.getByRole("alert")).toHaveTextContent("a@x.de: User has already been invited");
    expect(screen.queryByText("b@x.de")).toBeNull();
    await expect(screen.getByText("a@x.de").closest(".MuiChip-root")).toHaveAttribute("data-invalid", "true");
    // The one left can be sent again.
    await expect(screen.getByRole("button", { name: "Send invitation" })).toBeEnabled();
  });

  it("says once, in amber, that an address someone else invited meanwhile belongs already", async () => {
    // b@x.de was invited from elsewhere while this dialog was open: core refuses
    // it, and the refreshed list knows it now.
    api.inviteMember.mockRejectedValueOnce(new ApiError(400, "User has already been invited"));
    const Page = () => {
      const [known, setKnown] = useState(new Set<string>(["otto@example.com"]));
      return (
        <InviteDialog
          organizationId="org-1"
          organizationName="Stadt Musterhausen"
          seats={seatsOf({ used_editors: 3, total_editors: 5, used_viewers: 0, total_viewers: null })}
          known={known}
          onClose={vi.fn()}
          onChanged={async () => setKnown(new Set(["otto@example.com", "b@x.de"]))}
        />
      );
    };
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <Page />
      </I18nextProvider>
    );
    await userEvent.type(addresses(), "b@x.de,");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("b@x.de already belongs to the organization or is invited.");
    expect(screen.queryByText(/User has already been invited/)).toBeNull();
  });

  it("keeps what failed, with its reason, and reports what went out (and a manual account setup)", async () => {
    api.inviteMember
      .mockResolvedValueOnce(answer({ account_setup: "manual" }))
      .mockRejectedValueOnce(new ApiError(400, "User has already been invited"))
      .mockRejectedValueOnce(new ApiError(502));
    const { onClose } = renderDialog({
      seats: seatsOf({ used_editors: 0, total_editors: 10, used_viewers: 0, total_viewers: null }),
    });
    await userEvent.type(addresses(), "a@x.de,b@x.de,c@x.de,");
    await userEvent.click(screen.getByRole("button", { name: "Send 3 invitations" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Invitation sent to a@x.de.");
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/^a@x\.de: Member invited\./));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("b@x.de: User has already been invited");
    expect(alert).toHaveTextContent("The account for c@x.de cannot be created right now. Try again later.");
    expect(screen.queryByText("a@x.de")).toBeNull();
    await expect(screen.getByText("b@x.de").closest(".MuiChip-root")).toHaveAttribute("data-invalid", "true");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { statusOf } from "@/lib/api/apiError";
import {
  assignDomainToProject,
  deleteCustomDomain,
  recheckCustomDomain,
  unassignDomainFromProject,
} from "@/lib/api/customDomains";
import { updateSystemSettings } from "@/lib/api/system/client";
import { deleteAccount } from "@/lib/api/users";

const { apiRequestAuth } = vi.hoisted(() => ({ apiRequestAuth: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth, fetcher: vi.fn() }));

const refused = (status: number) =>
  new Response(JSON.stringify({ detail: "No" }), { status, headers: { "Content-Type": "application/json" } });

// A caller that branches on the status (statusOf) gets it from every one of
// these, as from the other settings mutations.
describe("settings API calls that are refused", () => {
  beforeEach(() => apiRequestAuth.mockReset());

  it.each([
    ["deleteCustomDomain", () => deleteCustomDomain("org-1", "d1")],
    ["recheckCustomDomain", () => recheckCustomDomain("org-1", "d1")],
    ["assignDomainToProject", () => assignDomainToProject("p1", "d1")],
    ["unassignDomainFromProject", () => unassignDomainFromProject("p1")],
    ["updateSystemSettings", () => updateSystemSettings({ preferred_language: "de" })],
    ["deleteAccount", () => deleteAccount()],
  ])("%s throws an error that carries the status", async (_name, call) => {
    apiRequestAuth.mockResolvedValue(refused(409));
    const error = await call().catch((caught: unknown) => caught);
    expect(statusOf(error)).toBe(409);
  });

  it("keeps the status of an answer without a JSON body", async () => {
    apiRequestAuth.mockResolvedValue(new Response("Bad gateway", { status: 502 }));
    const error = await deleteAccount().catch((caught: unknown) => caught);
    expect(statusOf(error)).toBe(502);
  });
});

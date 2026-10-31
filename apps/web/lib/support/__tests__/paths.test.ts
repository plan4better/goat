import { describe, expect, it } from "vitest";

import { SUPPORT_MAILTO } from "@/lib/constants";

import { newTicketPath, reportProblemHref } from "../paths";

describe("newTicketPath", () => {
  it("carries the page the user came from", () => {
    expect(newTicketPath("/map/abc")).toBe("/support/new?from=%2Fmap%2Fabc");
  });

  it("names no page from the support pages themselves", () => {
    for (const from of [
      "/support",
      "/support/00040",
      "/support/new",
      "/support?tab=closed",
      null,
      undefined,
    ]) {
      expect(newTicketPath(from)).toBe("/support/new");
    }
    expect(newTicketPath("/supporters")).toBe("/support/new?from=%2Fsupporters");
  });
});

describe("reportProblemHref", () => {
  it("opens a new ticket from the page where there are support tickets", () => {
    expect(reportProblemHref(true, "/map/abc")).toBe("/support/new?from=%2Fmap%2Fabc");
  });

  it("writes an email to support without tickets", () => {
    expect(reportProblemHref(false, "/map/abc")).toBe(SUPPORT_MAILTO);
    expect(reportProblemHref(false, "/map/abc", "mailto:help@example.com")).toBe("mailto:help@example.com");
  });

  it("leads nowhere with neither", () => {
    expect(reportProblemHref(false, "/map/abc", "")).toBeNull();
  });
});

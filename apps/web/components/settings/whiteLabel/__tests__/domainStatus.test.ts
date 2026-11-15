import { describe, expect, it } from "vitest";

import type { CustomDomain } from "@/lib/validations/customDomain";

import { domainState, recheckOutcome } from "@/components/settings/whiteLabel/domainStatus";

const domain = (dns_status: CustomDomain["dns_status"], cert_status: CustomDomain["cert_status"]) =>
  ({ dns_status, cert_status }) as CustomDomain;

describe("domain status", () => {
  it("names the four states", () => {
    expect(domainState(domain("pending", "pending"))).toBe("pending_dns");
    expect(domainState(domain("verified", "issuing"))).toBe("issuing");
    expect(domainState(domain("verified", "active"))).toBe("active");
    expect(domainState(domain("failed", "pending"))).toBe("failed");
  });

  it("says what a recheck found", () => {
    expect(recheckOutcome(domain("pending", "pending"), domain("verified", "issuing"))).toBe("found");
    expect(recheckOutcome(domain("pending", "pending"), domain("failed", "pending"))).toBe("wrong");
    expect(recheckOutcome(domain("pending", "pending"), domain("pending", "pending"))).toBe("unchanged");
  });
});

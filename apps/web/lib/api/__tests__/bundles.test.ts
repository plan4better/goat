import { describe, expect, it } from "vitest";

import { detectBundleType, sniffXPlan } from "@/lib/api/bundles";

const XPLAN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<xplan:XPlanAuszug xmlns:xplan="http://www.xplanung.de/xplangml/5/1" ' +
  'xmlns:gml="http://www.opengis.net/gml/3.2" gml:id="A">' +
  '<gml:featureMember><xplan:BP_Plan gml:id="P"><xplan:name>T1</xplan:name>' +
  "</xplan:BP_Plan></gml:featureMember></xplan:XPlanAuszug>";

// Another GML that only mentions the XPlanung namespace in a comment.
const NOT_XPLAN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  "<!-- converted from http://www.xplanung.de/xplangml/5/1 -->\n" +
  '<t:Collection xmlns:t="http://example.org/t" xmlns:gml="http://www.opengis.net/gml/3.2"/>';

const file = (name: string, content = "") => new File([content], name);

describe("detectBundleType", () => {
  it("recognises an XPlan plan by its content", async () => {
    expect((await detectBundleType(file("plan.gml", XPLAN)))?.type).toBe("xplan");
    // Declared without a prefix, in single quotes, or with spaces around `=`.
    for (const declaration of [
      'xmlns="http://www.xplanung.de/xplangml/5/4"',
      "xmlns:xp='http://www.xplanung.de/xplangml/5/4'",
      'xmlns:xp = "http://www.xplanung.de/xplangml/5/4"',
    ]) {
      expect((await sniffXPlan(file("p.gml", `<XPlanAuszug ${declaration}/>`))).isXPlan).toBe(true);
    }
  });

  it("leaves other GML a plain dataset", async () => {
    expect(await detectBundleType(file("other.gml", NOT_XPLAN))).toBeNull();
  });

  it("still recognises GTFS and Overture by name", async () => {
    expect((await detectBundleType(file("vbb_gtfs.zip")))?.type).toBe("pt_network_gtfs");
    expect((await detectBundleType(file("overture.zip")))?.type).toBe("street_network");
  });

  it("reads the plan name", async () => {
    expect(await sniffXPlan(file("plan.gml", XPLAN))).toEqual({ isXPlan: true, planName: "T1" });
    // The plan's own name, not a Bereich's before it, with its entities and declared
    // encoding read as the file means them.
    const latin1 = new Uint8Array(
      [
        '<?xml version="1.0" encoding="ISO-8859-1"?>',
        '<xplan:XPlanAuszug xmlns:xplan="http://www.xplanung.de/xplangml/5/1">',
        "<xplan:BP_Bereich><xplan:name>Bereich 1</xplan:name></xplan:BP_Bereich>",
        "<xplan:BP_Plan><xplan:name>Bergedorf &amp; L\u00f6hbr\u00fcgge</xplan:name></xplan:BP_Plan>",
      ]
        .join("")
        .split("")
        .map((c) => c.charCodeAt(0))
    );
    expect((await sniffXPlan(new File([latin1], "plan.gml"))).planName).toBe("Bergedorf & Löhbrügge");
  });
});

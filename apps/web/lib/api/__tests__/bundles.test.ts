import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { detectBundleType, sniffXPlan, zipMemberNames } from "@/lib/api/bundles";

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

/** A ZIP archive of the members, compressed as archivers write it, with an optional comment at its end. */
const zip = (name: string, members: Record<string, string>, comment = ""): File => {
  const text = new TextEncoder();
  const u16 = (n: number) => [n & 255, n >> 8];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
  const local: number[] = [];
  const directory: number[] = [];
  let count = 0;
  for (const [member, content] of Object.entries(members)) {
    const path = [...text.encode(member)];
    const data = [...deflateRawSync(text.encode(content))];
    // version, flags, deflate, time, date, crc (not checked here), sizes, name and extra lengths
    const head = [...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length)];
    const sizes = [...u32(content.length), ...u16(path.length), ...u16(0)];
    directory.push(...u32(0x02014b50), ...u16(20), ...head, ...sizes, ...u16(0), ...u16(0), ...u16(0), ...u32(0));
    directory.push(...u32(local.length), ...path);
    local.push(...u32(0x04034b50), ...head, ...sizes, ...path, ...data);
    count += 1;
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count)];
  end.push(...u32(directory.length), ...u32(local.length), ...u16(comment.length), ...text.encode(comment));
  return new File([new Uint8Array([...local, ...directory, ...end])], name);
};

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

  it("takes a file it cannot read, or a name it cannot decode, as no plan", async () => {
    // A file that was moved or cannot be read: the upload goes on as a plain dataset and fails there with a message.
    const unreadable = file("gone.gml", XPLAN);
    unreadable.slice = () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }) as unknown as Blob;
    expect(await sniffXPlan(unreadable)).toEqual({ isXPlan: false, planName: null });
    expect(await detectBundleType(unreadable)).toBeNull();
    // A character reference outside Unicode in the plan's name: still a plan, without a suggested name.
    const odd = XPLAN.replace("<xplan:name>T1</xplan:name>", "<xplan:name>T&#x110000;</xplan:name>");
    expect(await sniffXPlan(file("odd.gml", odd))).toEqual({ isXPlan: true, planName: null });
  });

  it("recognises a zipped plan by the xplan.gml in it", async () => {
    // A plan's archive holds the plan as `xplan.gml`, its documents beside it; its own name says nothing.
    const archive = zip("BPlan004_5-1.zip", { "BPlan004_5-1.pdf": "%PDF", "xplan.gml": XPLAN });
    expect(await zipMemberNames(archive)).toEqual(["BPlan004_5-1.pdf", "xplan.gml"]);
    expect((await detectBundleType(archive))?.type).toBe("xplan");
    // In a folder of the archive, and with a comment after the archive's directory.
    expect((await detectBundleType(zip("plan.zip", { "Plan 4/XPlan.gml": XPLAN }, "exported")))?.type).toBe("xplan");
  });

  it("leaves any other zip what it was", async () => {
    // Another GML, a name that only ends like the plan's, and a file that only mentions it.
    expect(await detectBundleType(zip("parcels.zip", { "parcels.gml": XPLAN }))).toBeNull();
    expect(await detectBundleType(zip("old.zip", { "old_xplan.gml": XPLAN }))).toBeNull();
    expect(await detectBundleType(zip("notes.zip", { "readme.txt": "see xplan.gml" }))).toBeNull();
    // No archive at all, and one that cannot be read.
    expect(await detectBundleType(file("plan.zip", "xplan.gml"))).toBeNull();
    expect(await zipMemberNames(file("empty.zip"))).toEqual([]);
    const unreadable = zip("gone.zip", { "xplan.gml": XPLAN });
    unreadable.slice = () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }) as unknown as Blob;
    expect(await detectBundleType(unreadable)).toBeNull();
    // A feed is a feed by its name, whatever else it holds.
    expect((await detectBundleType(zip("vbb_gtfs.zip", { "xplan.gml": XPLAN })))?.type).toBe("pt_network_gtfs");
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

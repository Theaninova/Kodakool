import { describe, it, expect } from "vitest";
import { buildProjectExportModel, projectPrintHtml, projectXlsx, xlsxHeader, xlsxTotals } from "./project-export";
import type { StoreBlob } from "$lib/client/blob";
import type { Instructions } from "./instructions";

function blob(): StoreBlob {
  return {
    version: 1,
    users: [],
    projects: [{ id: "p1", name: "example" }],
    members: [],
    documents: [
      {
        id: "d1",
        project_id: "p1",
        name: "article",
        kind: "text",
        folder: "",
        text: "alpha beta",
        codes: JSON.stringify([
          { device: "cat1", line: 1, range: [0, 5], excerpt: "alpha" },
          { device: "cat1", line: 1, range: [6, 10], excerpt: "beta" },
          { code: "2", line: 1, range: [0, 5], excerpt: "alpha" },
        ]),
      },
      { id: "d2", project_id: "p1", name: "other", kind: "text", folder: "", text: "gamma", codes: "[]" },
    ],
    catalogs: [],
    pdfs: [],
    states: [],
    meta: [],
  };
}

const instr: Instructions = {
  version: 1,
  title: "Codes",
  devices: [
    { id: "cat1", name: "Kategorie", kind: "device", examples: [], children: [] },
    { id: "cat2", name: "Zweite", kind: "device", examples: [], children: [] },
  ],
};

const colorOf = () => ({ marker: "#aabbcc", on: "#111111" });

// parse the store-only zip the workbook is written with: central directory ->
// name -> bytes, failing loudly on any bad header, size or CRC.
function unzip(zip: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);
  let eocd = zip.length - 22;
  while (eocd >= 0 && u32(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("EOCD not found");
  const count = u16(eocd + 10);
  const central = u32(eocd + 16);
  const out: Record<string, Uint8Array> = {};
  let p = central;
  for (let i = 0; i < count; i++) {
    if (u32(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const crc = u32(p + 16);
    const size = u32(p + 20);
    const nlen = u16(p + 28);
    const local = u32(p + 42);
    const name = Buffer.from(zip.slice(p + 46, p + 46 + nlen)).toString("utf8");
    if (u32(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    if (u16(local + 8) !== 0) throw new Error(`${name} is not stored`);
    if (u32(local + 14) !== crc) throw new Error(`crc mismatch for ${name}`);
    if (u32(local + 18) !== size) throw new Error(`size mismatch for ${name}`);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    const data = zip.slice(start, start + size);
    let c = ~0;
    for (let j = 0; j < data.length; j++) {
      c ^= data[j];
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    if (~c >>> 0 !== crc) throw new Error(`bad crc value for ${name}`);
    out[name] = data;
    p += 46 + nlen + u16(p + 30) + u16(p + 32);
  }
  return out;
}

const text = (files: Record<string, Uint8Array>, name: string): string => Buffer.from(files[name]).toString("utf8");

describe("buildProjectExportModel", () => {
  it("groups occurrences per code and document, resolving legacy codes", () => {
    const m = buildProjectExportModel("example", blob(), instr);
    expect(m.entries).toBe(3);
    expect(m.docs.map((d) => d.name)).toEqual(["article", "other"]);
    expect(m.docs[0].total).toBe(3);
    expect(m.rows.map((r) => r.code)).toEqual(["1", "2"]);
    const [cat1, cat2] = m.rows;
    expect(cat1.names).toEqual(["Kategorie"]);
    expect(cat1.counts).toEqual([2, 0]);
    expect(cat1.total).toBe(2);
    expect(cat1.occurrences).toEqual([
      { doc: "article", excerpt: "alpha" },
      { doc: "article", excerpt: "beta" },
    ]);
    // the legacy code "2" entry lands on the device that owns that code
    expect(cat2.counts).toEqual([1, 0]);
    expect(cat2.occurrences).toEqual([{ doc: "article", excerpt: "alpha" }]);
    // marks land on the text: alpha is covered by both codes
    expect(m.docs[0].marks.length).toBe(3);
    expect(m.docs[0].marks.map((mk) => [mk.from, mk.to])).toEqual([
      [0, 5],
      [0, 5],
      [6, 10],
    ]);
  });
});

describe("xlsx", () => {
  it("builds the template header, rows and totals", () => {
    const m = buildProjectExportModel("example", blob(), instr);
    expect(xlsxHeader(m)).toEqual([
      "code Name 1",
      "vorkommen in allen Texten",
      'vorkommen in "article"',
      'vorkommen in "other"',
      "Texstelle 1",
      "Texstelle 2",
    ]);
    // [entries summed, per-document: article, other]
    expect(xlsxTotals(m)).toEqual([3, 3, 0]);
  });

  it("writes the sheet with formulas and the Sum row", () => {
    const m = buildProjectExportModel("example", blob(), instr);
    const files = unzip(projectXlsx(m));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/theme/theme1.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(text(files, "xl/workbook.xml")).toContain('name="example"');
    expect(text(files, "xl/styles.xml")).toContain("FFFFF2CC");
    const sheet = text(files, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("vorkommen in allen Texten");
    expect(sheet).toContain("vorkommen in &quot;article&quot;");
    expect(sheet).toContain("Texstelle 1");
    expect(sheet).toContain("Kategorie");
    expect(sheet).toContain("Zweite");
    expect(sheet).toContain("<f>SUM(C2:D2)</f>");
    expect(sheet).toContain("Sum = ");
  });
});

describe("projectPrintHtml", () => {
  it("lays out coding-view pages with labels, overviews and totals", () => {
    const html = projectPrintHtml(buildProjectExportModel("example", blob(), instr), colorOf);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Kodierungsexport");
    expect(html).toContain("Übersicht");
    expect(html).toContain("Insgesamt 3 Codierungen in diesem Text.");
    expect(html).toContain("Gesamtübersicht");
    expect(html).toContain("Insgesamt 3 Codierungen im Projekt.");
    expect(html).toContain('class="m"');
    expect(html).toContain("data-label=");
    expect(html).toContain("#aabbcc");
    expect(html).toContain(">alpha<");
    expect(html).toContain("window.print()");
  });

  it("escapes text", () => {
    const b = blob();
    b.documents[0].name = "a<b";
    b.documents[0].text = "<script>x</script>";
    const html = projectPrintHtml(buildProjectExportModel("p", b, instr), colorOf);
    expect(html).not.toContain("<script>x");
    // after stripping the generated tags, the text reads as escaped text again
    const plain = html.replace(/<[^>]+>/g, "");
    expect(plain).toContain("a&lt;b");
    expect(plain).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

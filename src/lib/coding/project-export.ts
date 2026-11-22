import type { StoreBlob } from "$lib/client/blob";
import type { Instructions, FrameDevice } from "./instructions";
import type { CodeEntry } from "./types";
import { lineStarts } from "./edit";
import { buildCatalogView, flattenCatalog, indexCatalog } from "./catalog-view";
import { compareNames } from "./display";

/**
 * Project export (issue: "PDF und xlsx"): one shared model over the scoped export
 * blob + the catalog, then two renderers — a minimal XLSX writer (hand-built
 * OOXML zip) and a print-styled HTML document whose layout mirrors the coding
 * view (hatched-look marks, label chips above the marks, overview table per text
 * up top, project-wide code totals at the end). The HTML is handed to a print
 * window: the browser's "Save as PDF" produces the file.
 */

export interface ExportMark {
  from: number;
  to: number;
  short: string;
  code: string;
}

export interface ExportDoc {
  name: string;
  text: string;
  total: number;
  marks: ExportMark[];
}

export interface ExportCodeRow {
  id: string;
  /** derived numeric code, e.g. "1.2" (or the raw key for orphans) */
  code: string;
  /** path from the root: one name per tree level */
  names: string[];
  /** short tag shown on chips/rows */
  short: string;
  /** entries per document index */
  counts: number[];
  total: number;
  occurrences: { doc: string; excerpt: string }[];
}

export interface ExportModel {
  project: string;
  docs: ExportDoc[];
  /** catalog order (parents before children), orphans appended */
  rows: ExportCodeRow[];
  /** total entries across the project */
  entries: number;
}

function pathNamesOf(instr: Instructions | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (d: FrameDevice, path: string[]): void => {
    const p = [...path, d.name];
    out.set(d.id, p);
    d.children.forEach((c) => walk(c, p));
  };
  if (instr) instr.devices.forEach((d) => walk(d, []));
  return out;
}

function parseCodes(raw: string | undefined): CodeEntry[] {
  try {
    const v = JSON.parse(raw ?? "[]") as CodeEntry[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Scope: dump must already be scoped to `project` (scopeToProject / exportProject). */
export function buildProjectExportModel(project: string, dump: StoreBlob, instr: Instructions | null): ExportModel {
  const projIds = new Set(dump.projects.map((p) => p.id));
  const docRows = dump.documents.filter((d) => projIds.has(d.project_id)).sort((a, b) => compareNames(a.name, b.name));
  const allKeys: string[] = [];
  for (const d of docRows)
    for (const e of parseCodes(d.codes)) {
      const k = e.device ?? e.code ?? "";
      if (k !== "") allKeys.push(k);
    }

  const cat = buildCatalogView(instr, allKeys);
  const idx = indexCatalog(cat);
  const flat = flattenCatalog(cat);
  const paths = pathNamesOf(instr);
  const docs: ExportDoc[] = docRows.map((d) => ({ name: d.name, text: d.text ?? "", total: 0, marks: [] }));
  const rows: ExportCodeRow[] = flat.map((n) => ({
    id: n.id,
    code: n.code,
    names: paths.get(n.id) ?? [n.name !== "" ? n.name : n.code],
    short: n.slug?.short ?? n.code,
    counts: docs.map(() => 0),
    total: 0,
    occurrences: [],
  }));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  docRows.forEach((d, di) => {
    const doc = docs[di];
    const starts = lineStarts(doc.text);
    for (const e of parseCodes(d.codes)) {
      const key = e.device ?? e.code ?? "";
      if (key === "") continue;
      const id = idx.keyToId.get(key) ?? key;
      let row = rowById.get(id);
      if (!row) {
        row = { id, code: id, names: [key], short: id, counts: docs.map(() => 0), total: 0, occurrences: [] };
        rowById.set(id, row);
        rows.push(row);
      }
      row.counts[di]++;
      row.total++;
      row.occurrences.push({ doc: doc.name, excerpt: e.excerpt });
      doc.total++;
      const from = (starts[e.line - 1] ?? 0) + e.range[0];
      const to = (starts[(e.endLine ?? e.line) - 1] ?? 0) + e.range[1];
      if (from >= 0 && to > from)
        doc.marks.push({
          from: Math.min(from, doc.text.length),
          to: Math.min(to, doc.text.length),
          short: row.short,
          code: row.code,
        });
    }
  });
  for (const d of docs) d.marks.sort((a, b) => a.from - b.from);
  return { project, docs, rows, entries: allKeys.length };
}

/* ------------------------------------------------------------------ XLSX ---- */

/** XLSX template header labels (Unbenannte Tabelle): depth columns, totals, per-text counts, occurrences */
export function xlsxHeader(model: ExportModel): string[] {
  const depth = Math.max(1, ...model.rows.map((r) => r.names.length));
  const head: string[] = [];
  for (let i = 0; i < depth; i++) head.push(i === 0 ? "code Name 1" : `unter code Name ${i}`);
  head.push("vorkommen in allen Texten");
  for (const d of model.docs) head.push(`vorkommen in "${d.name}"`);
  const maxOcc = Math.max(0, ...model.rows.map((r) => r.occurrences.length));
  for (let i = 1; i <= maxOcc; i++) head.push(`Texstelle ${i}`);
  return head;
}

/** one row per catalog code: staggered path cells, total, per-text counts, occurrence excerpts */
export function xlsxRows(model: ExportModel): (string | number)[][] {
  return model.rows.map((r) => {
    const cells: (string | number)[] = [];
    for (const n of r.names) cells.push(n);
    cells.push(r.total);
    cells.push(...r.counts);
    for (const o of r.occurrences) cells.push(`${o.doc}: ${o.excerpt}`);
    return cells;
  });
}

/** the "Sum =" totals row of every count column */
export function xlsxTotals(model: ExportModel): number[] {
  const sums = model.rows.reduce((a, r) => a + r.total, 0);
  const perDoc = model.docs.map((_, di) => model.rows.reduce((a, r) => a + r.counts[di], 0));
  return [sums, ...perDoc];
}

const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => XML_ESC[c]);

/** 0-based column index -> A1 reference (A, B, …, Z, AA…) */
function colRef(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - r - 1) / 26);
  }
  return s;
}

function strCell(ref: string, style: number, text: string): string {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}
function numCell(ref: string, style: number, n: number, formula?: string): string {
  return `<c r="${ref}" s="${style}">${formula === undefined ? "" : `<f>${formula}</f>`}<v>${n}</v></c>`;
}

export function projectSheetXml(model: ExportModel): string {
  const depth = Math.max(1, ...model.rows.map((r) => r.names.length));
  const totalCol = depth; // 0-based column of "vorkommen in allen Texten"
  const firstDocCol = depth + 1;
  const lastDocCol = depth + model.docs.length;
  const head = xlsxHeader(model);
  const body = xlsxRows(model);
  const totals = xlsxTotals(model);
  const rowsXml: string[] = [];

  const headCells = head.map((h, i) => strCell(`${colRef(i)}1`, 1, h)).join("");
  rowsXml.push(`<row r="1">${headCells}</row>`);

  body.forEach((cells, ri) => {
    const r = ri + 2;
    const cs = cells.map((v, i) => {
      const ref = `${colRef(i)}${r}`;
      if (typeof v === "number") {
        if (i === totalCol && model.docs.length > 0) {
          const f = `SUM(${colRef(firstDocCol)}${r}:${colRef(lastDocCol)}${r})`;
          return numCell(ref, 3, v, f);
        }
        return numCell(ref, 2, v);
      }
      return strCell(ref, 2, String(v));
    });
    // the total of a code with no per-text columns has nothing to sum
    cs[totalCol] = model.docs.length > 0 ? cs[totalCol] : numCell(`${colRef(totalCol)}${r}`, 3, model.rows[ri].total);
    rowsXml.push(`<row r="${r}">${cs.join("")}</row>`);
  });

  const sumRow = model.rows.length + 2;
  const sumCells = [strCell(`A${sumRow}`, 4, "Sum = ")];
  for (let i = 0; i < totals.length; i++) {
    const col = i === 0 ? totalCol : firstDocCol + i - 1;
    sumCells.push(numCell(`${colRef(col)}${sumRow}`, 4, totals[i]));
  }
  rowsXml.push(`<row r="${sumRow}">${sumCells.join("")}</row>`);

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowsXml.join("")}</sheetData></worksheet>`
  );
}

/* the hand-rolled zip: store method only — Excel accepts uncompressed entries */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (~c >>> 0) >>> 0;
}

export function zipEntries(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const DOS_TIME = ((8 << 11) | (1 << 5)) & 0xffff; // 08:01
  const DOS_DATE = (((2026 - 1980) << 9) | (1 << 5) | 1) & 0xffff; // 2026-01-01
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(10, DOS_TIME, true);
    v.setUint16(12, DOS_DATE, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    const cd = new Uint8Array(46 + nameBytes.length);
    const w = new DataView(cd.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(4, 20, true);
    w.setUint16(8, 20, true);
    w.setUint16(10, DOS_TIME, true);
    w.setUint16(12, DOS_DATE, true);
    w.setUint32(16, crc, true);
    w.setUint32(20, size, true);
    w.setUint32(24, size, true);
    w.setUint16(28, nameBytes.length, true);
    w.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    chunks.push(lh, f.data);
    offset += lh.length + size;
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint16(12, centralSize, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(new ArrayBuffer(offset + centralSize + 22));
  let at = 0;
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const XLSX_STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2"><font><sz val="10"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font>` +
  `<font><b/><sz val="10"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="3"><border/>` +
  `<border><left style="medium"><color rgb="FF000000"/></left><top style="medium"><color rgb="FF000000"/></top>` +
  `<bottom style="medium"><color rgb="FF000000"/></bottom><right style="medium"><color rgb="FF000000"/></right></border>` +
  `<border><top style="double"><color rgb="FF000000"/></top></border></borders>` +
  `<cellStyleXfs count="1"><xf borderId="0" fillId="0" fontId="0" numFmtId="0"/></cellStyleXfs>` +
  `<cellXfs count="5">` +
  `<xf borderId="0" fillId="0" fontId="0" numFmtId="0" applyFont="1"/>` +
  `<xf borderId="1" fillId="2" fontId="1" numFmtId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
  `<xf borderId="0" fillId="0" fontId="0" numFmtId="0" applyFont="1"/>` +
  `<xf borderId="0" fillId="2" fontId="0" numFmtId="0" applyFill="1"/>` +
  `<xf borderId="2" fillId="0" fontId="1" numFmtId="0" applyFont="1" applyBorder="1"/>` +
  `</cellXfs><cellStyles count="1"><cellStyle xfId="0" name="Normal" builtinId="0"/></cellStyles></styleSheet>`;

const XLSX_THEME =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<theme xmlns="http://schemas.openxmlformats.org/drawingml/2006/main" name="k"><themeElements>` +
  `<clrScheme name="k"><dk1><sysClr val="windowText" lastClr="000000"/></dk1><lt1><sysClr val="window" lastClr="FFFFFF"/></lt1>` +
  `<dk2><sysClr val="windowText" lastClr="000000"/></dk2><lt2><sysClr val="window" lastClr="FFFFFF"/></lt2>` +
  `<accent1><srgbClr val="4472C4"/></accent1><accent2><srgbClr val="E7695E"/></accent2><accent3><srgbClr val="EDC24A"/></accent3>` +
  `<accent4><srgbClr val="5CA2C3"/></accent4><accent5><srgbClr val="49B18E"/></accent5><accent6><srgbClr val="E17D74"/></accent6>` +
  `<hlink><srgbClr val="0563C1"/></hlink><folHlink><srgbClr val="954F72"/></folHlink></clrScheme>` +
  `<fontScheme name="k"><majorFont><latin typeface="Arial"/><ea typeface=""/><cs typeface=""/></majorFont>` +
  `<minorFont><latin typeface="Arial"/><ea typeface=""/><cs typeface=""/></minorFont></fontScheme>` +
  `<fmtScheme name="k"><fillStyleLst><solidFill><srgbClr val="FFFFFF"/></solidFill>` +
  `<solidFill><srgbClr val="000000"/></solidFill><solidFill><srgbClr val="888888"/></solidFill></fillStyleLst>` +
  `<lnStyleLst><ln w="6350" cap="flat" algn="ctr"><solidFill><srgbClr val="000000"/></solidFill><prstDash val="solid"/></ln>` +
  `<ln w="12700" cap="flat" algn="ctr"><solidFill><srgbClr val="000000"/></solidFill><prstDash val="solid"/></ln>` +
  `<ln w="19050" cap="flat" algn="ctr"><solidFill><srgbClr val="000000"/></solidFill><prstDash val="solid"/></ln></lnStyleLst>` +
  `<effectStyleLst><effectStyle><effectLst/></effectStyle><effectStyle><effectLst/></effectStyle>` +
  `<effectStyle><effectLst/></effectStyle></effectStyleLst>` +
  `<bgFillStyleLst><solidFill><srgbClr val="FFFFFF"/></solidFill><solidFill><srgbClr val="FFFFFF"/></solidFill>` +
  `<solidFill><srgbClr val="FFFFFF"/></solidFill></bgFillStyleLst></fmtScheme></themeElements></theme>`;

export function projectXlsx(model: ExportModel): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const files = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          `<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<sheets><sheet name="${esc(model.project.slice(0, 31)) || "export"}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
          `</Relationships>`,
      ),
    },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(projectSheetXml(model)) },
    { name: "xl/styles.xml", data: enc.encode(XLSX_STYLES) },
    { name: "xl/theme/theme1.xml", data: enc.encode(XLSX_THEME) },
  ];
  return zipEntries(files);
}

/* -------------------------------------------------------------------- PDF ---- */

export function projectPrintHtml(
  model: ExportModel,
  colorOf: (code: string) => { marker: string; on: string },
): string {
  const overview = (rows: ExportCodeRow[]): string =>
    `<table class="ovw"><thead><tr><th>Code</th><th>Name</th><th>Anzahl</th></tr></thead><tbody>` +
    rows
      .map((r) => `<tr><td>${esc(r.short)}</td><td>${esc(r.names.join(" › "))}</td><td>${r.total}</td></tr>`)
      .join("") +
    `</tbody></table>`;

  const body = (text: string, marks: ExportMark[]): string => {
    const pts = [
      ...new Set([0, text.length, ...marks.flatMap((m) => [Math.max(0, m.from), Math.min(text.length, m.to)])]),
    ].sort((a, b) => a - b);
    let html = "";
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      if (b <= a) continue;
      const covering = marks.filter((m) => m.from <= a && m.to >= b);
      const chunk = esc(text.slice(a, b));
      if (covering.length === 0) {
        html += chunk;
        continue;
      }
      const c = colorOf(covering[0].code);
      const labels = [...new Set(covering.map((m) => m.short))].join(" ");
      html += `<span class="m" style="background:${c.marker};color:${c.on};--mm:${c.marker}" data-label="${esc(labels)}">${chunk}</span>`;
    }
    return html;
  };

  const sections = model.docs
    .map(
      (d) =>
        `<section class="doc"><h2>${esc(d.name)}</h2>` +
        `<h3>Übersicht — Codes in diesem Text</h3>` +
        overview(model.rows.filter((r) => (r.counts[model.docs.indexOf(d)] ?? 0) > 0)) +
        `<p class="tot">Insgesamt ${d.total} Codierungen in diesem Text.</p>` +
        `<article class="txt">${body(d.text, d.marks)}</article></section>`,
    )
    .join("");

  const allTotals = model.rows
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code, "de"));
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(model.project)} — Kodierungsexport</title>` +
    `<style>
@page { margin: 1.7cm 1.9cm; }
html { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
body { font: 11pt/1.55 Georgia, "Times New Roman", serif; color: #111; }
h1 { font-size: 20pt; margin: 0 0 0.2em; }
.meta { font-size: 9pt; color: #555; margin: 0 0 1.4em; }
h2 { font-size: 14pt; margin: 0 0 0.4em; border-bottom: 2px solid #333; }
h3 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.06em; color: #555; margin: 0.8em 0 0.3em; }
table.ovw { border-collapse: collapse; font: 9.5pt/1.35 Arial, sans-serif; margin: 0 0 0.6em; }
table.ovw th, table.ovw td { border: 1px solid #999; padding: 2px 9px; text-align: left; }
table.ovw th { background: #f1ebfa; }
p.tot { font-weight: 700; font-size: 10pt; margin: 0 0 1em; }
section.doc { break-before: page; }
section.doc:first-of-type { break-before: auto; }
.txt { white-space: pre-wrap; }
.m { position: relative; padding: 0; }
.m::before { content: attr(data-label); position: absolute; left: 0; bottom: calc(100% - 1px); font: 7pt/1 Arial, sans-serif;
  font-weight: 700; color: var(--mm); white-space: nowrap; letter-spacing: 0.02em; }
</style></head><body>` +
    `<h1>${esc(model.project)}</h1>` +
    `<p class="meta">Kodierungsexport · ${new Date().toLocaleDateString("de-DE")} · ` +
    `${model.docs.length} Texte · ${model.entries} Codierungen</p>` +
    sections +
    `<section class="doc"><h2>Gesamtübersicht aller Codes</h2>${overview(allTotals)}` +
    `<p class="tot">Insgesamt ${model.entries} Codierungen im Projekt.</p></section>` +
    `<script>window.onload = function () { window.print(); };</script></body></html>`
  );
}

/** Opens the print window; returns false when the popup was blocked. */
export function openProjectPrint(html: string): boolean {
  const w = window.open("", "_blank");
  if (w === null) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}

import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import DatabaseControls from "$lib/client/DatabaseControls.svelte";
import {
  createFolder,
  exportDatabase,
  exportProject,
  getArticleByName as getArticle,
  getLocalCatalog,
  getPdfData,
  importDatabase,
  listFolders,
  readCodes,
  saveLocalCatalog,
  savePdfData,
  type StoreBlob,
} from "$lib/local/local-api";
import { DEVICE_QUOTE, resetArticles, seedArticle, testInstructions, uploadTo } from "./fixtures";
import type { CodeEntry } from "$lib/coding/types";

const FOLDER = "test";
const NAME = "spd 1";
const TEXT = "Ein Zitat im Text.";
const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };

/** JSON columns of the export's document rows are raw strings (the server's storage) */
function jsonOf(cell: string | undefined): unknown[] {
  return JSON.parse(cell ?? "[]") as unknown[];
}

describe("database export/import", () => {
  beforeEach(async () => {
    await resetArticles();
  });

  it("exports every document, entry, PDF and catalog override", async () => {
    const id = await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry],
      versions: ["snap"],
    });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"));
    await createFolder("archive");

    const dump = (await exportDatabase()) as StoreBlob;
    expect(dump.version).toBe(1);
    expect(dump.documents).toHaveLength(1);
    expect(jsonOf(dump.documents[0].versions)).toHaveLength(1);
    expect(jsonOf(dump.documents[0].codes)).toHaveLength(1);
    expect(dump.catalogs.map((c) => JSON.parse(c.data))).toEqual([testInstructions]);
    expect(dump.pdfs).toHaveLength(1);
    expect(dump.projects.map((p) => p.name)).toContain("archive");
  });

  it("exports only the requested project's documents, entries, PDFs, catalog and folder", async () => {
    const id = await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry],
      versions: ["snap"],
    });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"));
    await seedArticle({ project: "other", name: "foreign doc", text: "x" });
    await createFolder(FOLDER);
    await createFolder("archive");

    const dump = await exportProject(FOLDER);
    expect(dump.version).toBe(1);
    expect(dump.projects.map((p) => p.name)).toEqual([FOLDER]);
    expect(dump.documents.map((d) => d.name)).toEqual([NAME]);
    expect(jsonOf(dump.documents[0].codes)).toHaveLength(1);
    expect(dump.catalogs.map((c) => JSON.parse(c.data))).toEqual([testInstructions]);
    expect(dump.pdfs).toHaveLength(1);

    // a project blob is a valid StoreBlob subset: importDatabase accepts it (replace-import)
    const counts = dump.documents.length;
    await importDatabase(dump);
    expect(counts).toBe(1);
    expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    expect(await getArticle("other", "foreign doc")).toBeNull();
  });

  it("re-imports a dump into a wiped database", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"));
    await createFolder("archive");
    const dump = (await exportDatabase()) as StoreBlob;

    await resetArticles();
    expect(await getArticle(FOLDER, NAME)).toBeNull();

    await importDatabase(dump);
    expect((await listFolders()).sort()).toEqual(["archive", "test"]);

    const art = await getArticle(FOLDER, NAME);
    expect(art?.text).toBe(TEXT);
    const codes = await readCodes(art?.id ?? "");
    expect(codes.map((c) => c.device)).toEqual([DEVICE_QUOTE]);
    expect((await getLocalCatalog(FOLDER))?.title).toBe("Test catalog");
    expect(await getPdfData(id)).toBeTruthy();
  });

  it("import replaces the store wholesale (the UI merges by id on top)", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    const dump = (await exportDatabase()) as StoreBlob;

    await seedArticle({ project: FOLDER, name: "second", text: "other" });
    await importDatabase(dump);

    // the imported snapshot wins: the document created after the export is gone
    expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    expect(await getArticle(FOLDER, "second")).toBeNull();
    expect(id).toBeTruthy();
  });

  it("rejects a foreign blob", async () => {
    await expect(importDatabase({ kind: "something-else", articles: [] })).rejects.toThrow(
      /unsupported import version/,
    );
    await expect(importDatabase(null)).rejects.toThrow(/import blob must be an object/);
  });

  it("merges a backup from another profile whose local user has a different UUID", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    render(DatabaseControls, {}, { wrapper: ColorProvider });

    // A foreign profile's backup: the same local user email under a fresh user UUID, plus a
    // project+document this store has never seen. Both user rows would collide on
    // UNIQUE(users.email) — the server rolled the import back and NOTHING was loaded.
    const own = (await exportDatabase()) as StoreBlob;
    const ownId = own.users[0].id;
    const foreign = JSON.parse(JSON.stringify(own)) as StoreBlob;
    const foreignId = crypto.randomUUID();
    foreign.users[0].id = foreignId;
    for (const p of foreign.projects) if (p.owner === ownId) p.owner = foreignId;
    const newPid = crypto.randomUUID();
    foreign.projects.push({ id: newPid, owner: foreignId, name: "restored", created: Date.now() });
    foreign.documents.push({
      id: crypto.randomUUID(),
      project_id: newPid,
      name: "restored doc",
      folder: "",
      kind: "text",
      text: TEXT,
      codes: "[]",
      versions: "[]",
      updated: Date.now(),
    });
    // a document inside a subfolder the blob's project row never registered
    foreign.documents.push({
      id: crypto.randomUUID(),
      project_id: newPid,
      name: "nested doc",
      folder: "notes",
      kind: "text",
      text: TEXT,
      codes: "[]",
      versions: "[]",
      updated: Date.now(),
    });

    uploadTo(".dbfile", new File([JSON.stringify(foreign)], "kodakool-db.json", { type: "application/json" }));
    await expect
      .poll(() => document.querySelector(".dbmsg")?.textContent, { timeout: 8000 })
      .toMatch(/imported \d+ documents/);

    // the imported data is live AND this store's own data survived the merge;
    // the foreign copy of this store's own "test" project could NOT overwrite it —
    // it landed as a freshly keyed "test1" (import never overwrites projects)
    expect(await getArticle("restored", "restored doc")).toBeTruthy();
    expect(await getArticle("restored", "nested doc")).toBeTruthy();
    expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    expect(await getArticle(`${FOLDER}1`, NAME)).toBeTruthy();
    expect((await listFolders()).sort()).toEqual(["restored", FOLDER, `${FOLDER}1`]);
    expect(document.querySelector(".dbmsg")?.textContent).toMatch(/1 as new project/);

    // one user row per email, the foreign references adopted the existing user's id,
    // and the unregistered subfolder of the nested document was registered by the merge
    const after = (await exportDatabase()) as StoreBlob;
    expect(after.users.filter((u) => u.email === own.users[0].email)).toHaveLength(1);
    expect(after.projects.find((p) => p.name === "restored")?.owner).toBe(ownId);
    expect(JSON.parse(after.projects.find((p) => p.name === "restored")?.subs ?? "[]")).toContain("notes");
  });
});

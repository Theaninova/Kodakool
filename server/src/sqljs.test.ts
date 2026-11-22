import { afterEach, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { flushNow, openSqlJsDb } from "./sqljs.ts";
import type { Db } from "./db.ts";

/** minimal IndexedDB fake: an in-memory "disk" with an armable one-shot put failure */
function makeIdb() {
  const disk = new Map<string, Uint8Array>();
  let failNext = false;
  const fake = {
    open(_name: string, _version: number) {
      const req: any = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {},
          transaction() {
            const tx: any = {
              objectStore: () => ({
                get(key: string) {
                  const r: any = {};
                  setTimeout(() => {
                    r.result = disk.get(key);
                    r.onsuccess?.();
                  }, 0);
                  return r;
                },
                put(val: Uint8Array, key: string) {
                  const r: any = {};
                  setTimeout(() => {
                    if (failNext) {
                      failNext = false;
                      tx.error = new Error("QuotaExceededError: storage quota exhausted");
                      tx.onerror?.();
                      return;
                    }
                    disk.set(key, val);
                    r.onsuccess?.();
                    tx.oncomplete?.();
                  }, 0);
                  return r;
                },
              }),
            };
            return tx;
          },
        };
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  return { disk, fake, armFail: () => (failNext = true) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function diskHas(disk: Map<string, Uint8Array>, name: string): Promise<boolean> {
  const bytes = disk.get("main");
  if (!bytes) return false;
  const SQL = await initSqlJs();
  const probe = new SQL.Database(bytes);
  try {
    const res = probe.exec(`SELECT count(*) AS n FROM documents WHERE name = '${name}'`);
    return ((res[0]?.values[0]?.[0] as number) ?? 0) > 0;
  } finally {
    probe.close();
  }
}

function insertDoc(db: Db, id: string, name: string): void {
  db.prepare(
    "INSERT INTO documents (id, project_id, name, folder, kind, text, codes, versions, updated) VALUES (?, 'p', ?, '', 'text', 'body', '[]', '[]', ?)",
  ).run(id, name, Date.now());
}

afterEach(() => {
  delete (globalThis as any).indexedDB;
});

describe("sqljs persistence (issue #11)", () => {
  it("surfaces a failed image save and retries the image on flush", async () => {
    const idb = makeIdb();
    (globalThis as any).indexedDB = idb.fake;
    const failures: string[] = [];
    const db = await openSqlJsDb((message) => failures.push(message));
    await wait(400); // schema baseline lands
    insertDoc(db, "d1", "good.txt");
    await wait(400);
    expect(await diskHas(idb.disk, "good.txt")).toBe(true);

    idb.armFail(); // the next image write fails (real cause: IndexedDB quota)
    insertDoc(db, "d2", "months-of-coding.txt");
    await wait(400);
    expect(failures).toEqual([expect.stringContaining("QuotaExceeded")]); // reported, not swallowed
    expect(await diskHas(idb.disk, "months-of-coding.txt")).toBe(false); // ...but still unsaved

    await flushNow(); // quota recovers: the image is still dirty, so the retry lands it
    expect(await diskHas(idb.disk, "months-of-coding.txt")).toBe(true);
  });

  it("flushNow persists immediately instead of after the debounce window", async () => {
    const idb = makeIdb();
    (globalThis as any).indexedDB = idb.fake;
    const db = await openSqlJsDb();
    await wait(400); // schema baseline lands
    insertDoc(db, "d1", "last-keystroke.txt");
    await wait(50); // still inside the 200 ms save debounce
    expect(await diskHas(idb.disk, "last-keystroke.txt")).toBe(false);
    await flushNow(); // the worker's "last port closed" moment
    expect(await diskHas(idb.disk, "last-keystroke.txt")).toBe(true);
    await wait(300); // the cleared debounce must not have written anything behind our back
    expect(await diskHas(idb.disk, "last-keystroke.txt")).toBe(true);
  });
});

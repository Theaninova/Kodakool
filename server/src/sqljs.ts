import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { initSchema } from "./db.ts";
import type { Db, DbStatement } from "./db.ts";

/**
 * The `Db` interface over sql.js (SQLite compiled to WebAssembly) with IndexedDB
 * persistence — the SharedWorker's storage engine.
 *
 * SharedWorker scope exposes NEITHER OPFS sync access handles NOR localStorage, so
 * the sqlite-wasm VFSes are unavailable there; IndexedDB is. sql.js keeps the whole
 * database in memory (fast, synchronous — exactly the `Db` contract the server codes
 * against) and the store is flushed as a full SQLite image to IndexedDB, debounced,
 * after every mutation. One SharedWorker per profile = one writer = no contention.
 */

const IDB_NAME = "kodakool-sqljs";
const IDB_STORE = "db";
const IDB_KEY = "main";
const SAVE_DEBOUNCE_MS = 200;

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbLoad(): Promise<Uint8Array | null> {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => {
      const value = (req.result as Uint8Array | undefined) ?? null;
      db.close();
      res(value);
    };
    req.onerror = () => {
      db.close();
      rej(req.error);
    };
  });
}

async function idbSave(bytes: Uint8Array): Promise<void> {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => {
      db.close();
      res();
    };
    tx.onerror = () => {
      db.close();
      rej(tx.error);
    };
  });
}

/** normalize sql.js row objects to plain, JSON-safe records */
function rowOf(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v === undefined ? null : v;
  return out;
}

export function wrapSqlJs(sdb: Database, onWrite: () => void): Db {
  return {
    prepare(sql: string): DbStatement {
      return {
        get(...params: unknown[]) {
          const st = sdb.prepare(sql);
          try {
            st.bind(params as never);
            return st.step() ? rowOf(st.getAsObject()) : undefined;
          } finally {
            st.free();
          }
        },
        all(...params: unknown[]) {
          const st = sdb.prepare(sql);
          const out: Record<string, unknown>[] = [];
          try {
            st.bind(params as never);
            while (st.step()) out.push(rowOf(st.getAsObject()));
          } finally {
            st.free();
          }
          return out;
        },
        run(...params: unknown[]) {
          sdb.run(sql, params as never);
          onWrite();
          // sql.js 1.15 exposes no getLastInsertId — read it from the connection
          const res = sdb.exec("SELECT last_insert_rowid() AS id");
          const lastId = (res[0]?.values[0]?.[0] as number | undefined) ?? 0;
          return { changes: sdb.getRowsModified(), lastInsertRowid: lastId };
        },
      };
    },
    exec(sql: string): void {
      sdb.run(sql);
      onWrite();
    },
  };
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  const isNode = typeof process !== "undefined" && process.versions?.node != null;
  // node: resolve through the package manager (bare specifiers are not URLs there);
  // browser: literal so vite emits the wasm asset. The node:module import is only
  // ever evaluated in node, so the worker bundle never touches it.
  const wasmUrl = isNode
    ? (await import("node:module")).createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm")
    : new URL("sql.js/dist/sql-wasm.wasm", import.meta.url).href;
  return initSqlJs({ locateFile: (f: string) => (f.endsWith(".wasm") ? wasmUrl : f) });
}

/** the store image currently holding the IndexedDB slot — one profile, one SharedWorker, one writer */
let activeStore: { save: () => Promise<void> } | undefined;

/**
 * Force-save any pending store image right now. A SharedWorker scope has no unload hook,
 * so callers (worker.ts: the last port closing) use this as the closest thing to one —
 * a write used to sit only in memory until the debounce fired (issue #11).
 */
export function flushNow(): Promise<void> {
  return activeStore ? activeStore.save() : Promise.resolve();
}

/**
 * Open the persistent store (browser: IndexedDB-backed; node/tests: plain memory).
 * The schema + additive migrations run on every open (initSchema is idempotent).
 * `onSaveError` fires when a debounced image write FAILS (quota etc.) — the image stays
 * dirty and every later write/flush retries, so durability is never silently dead (#11).
 */
export async function openSqlJsDb(onSaveError?: (message: string) => void): Promise<Db> {
  const SQL = await loadSqlJs();
  const persistent = typeof indexedDB !== "undefined";
  const saved = persistent ? await idbLoad() : null;
  const sdb = saved && saved.length > 0 ? new SQL.Database(saved) : new SQL.Database();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const doSave = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    return idbSave(sdb.export()).then(() => {
      dirty = false;
    });
  };
  const reportFailure = (e: unknown) => {
    dirty = true; // the image is still unsaved: the next write or flushNow retries it
    const message = e instanceof Error ? e.message : String(e);
    console.error("kodakool store: IndexedDB save failed:", message);
    onSaveError?.(message);
  };
  const onWrite = () => {
    if (!persistent) return;
    dirty = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      doSave().catch(reportFailure);
    }, SAVE_DEBOUNCE_MS);
  };
  activeStore = {
    save: () => (!persistent || !dirty ? Promise.resolve() : doSave().catch(reportFailure)),
  };
  const db = wrapSqlJs(sdb, onWrite);
  initSchema(db);
  // persist the freshly initialized schema too (first run creates the store)
  onWrite();
  return db;
}

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { RoomManager } from "./realtime.ts";
import { createApp } from "./app.ts";
import { nodeCrypto } from "./auth-node.ts";
import { openMemoryDb } from "./db-node.ts";
import type { Config } from "./config.ts";

/** the exact wiring of main.ts / worker.ts: ONE RoomManager shared with the REST app */

class FakeConn extends EventEmitter {
  readyState = 1;
  sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
}

const cfg: Config = {
  port: 0,
  host: "127.0.0.1",
  dataDir: ":memory:",
  secret: new TextEncoder().encode("0123456789012345678901234567890123"),
  allowRegister: true,
  oidcAllow: null,
  oidcIssuer: null,
  oidcClientId: null,
};

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(email: string) {
  const db = openMemoryDb();
  const rooms = new RoomManager(db);
  const app = createApp({ cfg, db, kdf: nodeCrypto, rooms });
  const reg = (await (
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "secret123", name: "A" }),
    })
  ).json()) as any;
  const token = reg.token as string;
  const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const proj = (await (
    await app.request("/api/projects", { method: "POST", headers: h, body: JSON.stringify({ name: "p" }) })
  ).json()) as any;
  const doc = (await (
    await app.request(`/api/projects/${proj.id}/docs`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "d.txt" }),
    })
  ).json()) as any;
  return { db, rooms, app, h, token, proj, docId: doc.id as string };
}

/** open a warm room like a page does: attach a client that types `text` (no server-side seed: no doc_states yet and a row text would be seeded, so the row text stays empty) */
function openClient(rooms: RoomManager, docId: string, text: string) {
  const conn = new FakeConn();
  const clientDoc = new Y.Doc();
  rooms.room(docId).attach(conn);
  conn.emit(
    "message",
    Buffer.from(
      encoding.encode((enc) => {
        encoding.writeVarUint(enc, 0);
        syncProtocol.writeSyncStep1(enc, clientDoc);
      }),
    ),
  );
  clientDoc.transact(() => clientDoc.getText("text").insert(0, text));
  conn.emit(
    "message",
    Buffer.from(
      encoding.encode((enc) => {
        encoding.writeVarUint(enc, 0);
        syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(clientDoc));
      }),
    ),
  );
  return { conn, clientDoc };
}

const type = (conn: FakeConn, clientDoc: Y.Doc) => {
  const text = clientDoc.getText("text");
  clientDoc.transact(() => text.insert(text.length, " (typed)"));
  conn.emit(
    "message",
    Buffer.from(
      encoding.encode((enc) => {
        encoding.writeVarUint(enc, 0);
        syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(clientDoc));
      }),
    ),
  );
};

describe("room lifecycle vs REST routes (issue #9)", () => {
  it("a restored backup survives keystrokes from a still-open tab", async () => {
    const { db, rooms, app, h, docId } = await setup("w1@b.de");
    const { conn, clientDoc } = openClient(rooms, docId, "OLD research notes");
    await wait(500); // room persist debounce
    expect(((await (await app.request(`/api/docs/${docId}`, { headers: h })).json()) as any).text).toBe(
      "OLD research notes",
    );

    // restore: export, correct the document in the blob, import
    const blob = (await (await app.request("/api/export", { headers: h })).json()) as any;
    blob.documents[0].text = "IMPORTED-CORRECTED";
    blob.documents[0].codes = "[]";
    const fixed = new Y.Doc();
    fixed.getText("text").insert(0, "IMPORTED-CORRECTED");
    blob.states = [{ doc_id: docId, b64: b64(Y.encodeStateAsUpdate(fixed)) }];
    expect((await app.request("/api/import", { method: "POST", headers: h, body: JSON.stringify(blob) })).status).toBe(
      200,
    );
    expect(((await (await app.request(`/api/docs/${docId}`, { headers: h })).json()) as any).text).toBe(
      "IMPORTED-CORRECTED",
    );

    // the stale tab presses one key: its (now retired) room must not overwrite anything
    type(conn, clientDoc);
    await wait(500);
    expect(((await (await app.request(`/api/docs/${docId}`, { headers: h })).json()) as any).text).toBe(
      "IMPORTED-CORRECTED",
    );
    const stateRow = db.prepare("SELECT state FROM doc_states WHERE doc_id = ?").get(docId) as {
      state: Uint8Array;
    };
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(stateRow.state));
    expect(reloaded.getText("text").toString()).toBe("IMPORTED-CORRECTED");
  });

  it("a merge-import that rewrites identical bytes keeps the open document collaborating", async () => {
    const { db, rooms, app, h, docId } = await setup("w2@b.de");
    const { conn, clientDoc } = openClient(rooms, docId, "notes A");
    await wait(500);
    const blob = (await (await app.request("/api/export", { headers: h })).json()) as any;
    expect((await app.request("/api/import", { method: "POST", headers: h, body: JSON.stringify(blob) })).status).toBe(
      200,
    );
    // the live client keeps editing: its room must still be the warm one (closeStale only
    // drops rooms whose persisted bytes differ from what the store now holds)
    type(conn, clientDoc);
    await wait(500);
    const row = db.prepare("SELECT text FROM documents WHERE id = ?").get(docId) as { text: string };
    expect(row.text).toBe("notes A (typed)");
  });

  it("project delete retires the warm rooms so the cascade cannot resurrect rows", async () => {
    const { db, rooms, app, h, proj, docId } = await setup("w3@b.de");
    const { conn } = openClient(rooms, docId, "doomed notes");
    await wait(500);
    expect((await app.request(`/api/projects/${proj.id}`, { method: "DELETE", headers: h })).status).toBe(204);
    await wait(600); // a pending debounce on a stale room would have landed in this window
    conn.emit("close"); // the transport notices late: detach -> persist
    await wait(600);
    expect(db.prepare("SELECT 1 FROM doc_states WHERE doc_id = ?").get(docId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM documents WHERE id = ?").get(docId)).toBeUndefined();
  });
});

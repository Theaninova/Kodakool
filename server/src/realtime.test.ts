import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { materialize, Room, RoomManager } from "./realtime.ts";
import { openMemoryDb } from "./db-node.ts";

/** minimal WebSocket stand-in: readyState + send + the events Room subscribes to */
class FakeConn extends EventEmitter {
  readyState = 1;
  sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
}

function seedDoc(db: ReturnType<typeof openMemoryDb>, id: string): void {
  db.prepare("INSERT INTO projects (id, owner, name, created) VALUES (?, ?, ?, ?)").run("p1", "u1", "proj", Date.now());
  db.prepare(
    "INSERT INTO documents (id, project_id, name, folder, kind, text, codes, versions, updated) VALUES (?, ?, ?, '', 'text', '', '[]', '[]', ?)",
  ).run(id, "p1", "d.txt", Date.now());
}

describe("materialize", () => {
  it("writes the Y.Doc text + entries into the documents row", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const ydoc = new Y.Doc();
    ydoc.getText("text").insert(0, "hello world");
    ydoc.getMap("entries").set("e1", JSON.stringify({ device: "d", line: 1, range: [0, 5], excerpt: "hello" }));
    ydoc.getMap("entries").set("e2", "{not json");
    materialize(db, "doc1", ydoc);
    const row = db.prepare("SELECT text, codes FROM documents WHERE id = ?").get("doc1") as {
      text: string;
      codes: string;
    };
    expect(row.text).toBe("hello world");
    const codes = JSON.parse(row.codes) as unknown[];
    expect(codes).toHaveLength(1); // the poisoned entry is skipped
  });
});

describe("room relay", () => {
  it("syncs a late joiner to the full state (sync step1/step2)", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const room = new Room("doc1", db);
    const a = new FakeConn();
    room.attach(a);
    // A seeds text through an update message
    const seed = new Y.Doc();
    seed.getText("text").insert(0, "shared text");
    const update = Y.encodeStateAsUpdate(seed);
    a.emit(
      "message",
      Buffer.from(
        encoding.encode((enc) => {
          encoding.writeVarUint(enc, 0);
          syncProtocol.writeUpdate(enc, update);
        }),
      ),
    );
    expect(room.doc.getText("text").toString()).toBe("shared text");

    // B joins: receives the server step1, answers with its OWN (empty) step1 → gets the full state back
    const b = new FakeConn();
    room.attach(b);
    const bdoc = new Y.Doc();
    const step1 = encoding.encode((enc) => {
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, bdoc);
    });
    b.emit("message", Buffer.from(step1));
    const reply = b.sent.at(-1)!;
    const dec = decoding.createDecoder(reply);
    expect(decoding.readVarUint(dec)).toBe(0); // MSG_SYNC
    expect(decoding.readVarUint(dec)).toBe(syncProtocol.messageYjsSyncStep2);
    const state = decoding.readVarUint8Array(dec);
    Y.applyUpdate(bdoc, state);
    expect(bdoc.getText("text").toString()).toBe("shared text");
  });

  it("relays live updates to the other members", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const room = new Room("doc1", db);
    const a = new FakeConn();
    const b = new FakeConn();
    room.attach(a);
    room.attach(b);
    a.sent.length = 0;
    b.sent.length = 0;
    room.doc.transact(() => room.doc.getText("text").insert(0, "live"), a);
    expect(b.sent.length).toBe(1);
    expect(a.sent.length).toBe(0); // the origin is not echoed
  });

  it("reaps a connection whose send fails and keeps relaying + persisting", () => {
    // a Firefox worker-scope broadcast used to throw DataCloneError (detached ArrayBuffer)
    // on the SECOND recipient of one shared message — that aborted the fanout, starving
    // the healthy tabs AND skipping the room's persist, so counts/export froze silently.
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const room = new Room("doc1", db);
    const a = new FakeConn();
    const sick = new FakeConn();
    const b = new FakeConn();
    room.attach(a);
    room.attach(sick);
    room.attach(b);
    sick.send = () => {
      throw new Error("DataCloneError: attempting to access detached ArrayBuffer");
    };
    a.sent.length = 0;
    sick.sent.length = 0;
    b.sent.length = 0;
    room.doc.transact(() => room.doc.getText("text").insert(0, "after"), a);
    expect(b.sent.length).toBe(1); // the healthy member still got the update
    expect(room.conns.has(sick)).toBe(false); // the failing conn was reaped
    expect(db.prepare("SELECT state FROM doc_states WHERE doc_id = 'doc1'").get()).toBeDefined(); // persist ran
  });

  it("relays awareness and clears it on disconnect", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const room = new Room("doc1", db);
    const a = new FakeConn();
    const b = new FakeConn();
    room.attach(a);
    room.attach(b);
    const adoc = new Y.Doc();
    const aw = new awarenessProtocol.Awareness(adoc);
    aw.setLocalStateField("user", { name: "Ann" });
    const awUpdate = awarenessProtocol.encodeAwarenessUpdate(aw, [adoc.clientID]);
    a.emit(
      "message",
      Buffer.from(
        encoding.encode((enc) => {
          encoding.writeVarUint(enc, 1);
          encoding.writeVarUint8Array(enc, awUpdate);
        }),
      ),
    );
    expect(room.awareness.getStates().get(adoc.clientID)?.user).toEqual({ name: "Ann" });
    // B received the relay
    expect(b.sent.some((m) => m[0] === 1)).toBe(true);

    a.emit("close");
    expect(room.awareness.getStates().get(adoc.clientID)).toBeUndefined();
  });

  it("persists the binary state and reloads it into a fresh room", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const room = new Room("doc1", db);
    const a = new FakeConn();
    room.attach(a);
    room.doc.transact(() => {
      room.doc.getText("text").insert(0, "persisted");
      room.doc.getMap("entries").set("e1", JSON.stringify({ device: "d", line: 1, range: [0, 4], excerpt: "pers" }));
    }, a);
    room.persist();

    const room2 = new Room("doc1", db);
    room2.load();
    expect(room2.doc.getText("text").toString()).toBe("persisted");
    expect(room2.doc.getMap("entries").size).toBe(1);
  });

  it("seeds a fresh room's text from the REST row exactly once (issue #10)", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    db.prepare("UPDATE documents SET text = ? WHERE id = ?").run("Hello world.", "doc1");

    // no doc_states row yet: the room adopts the REST text at creation (server, single writer)
    const room = new Room("doc1", db);
    room.load();
    expect(room.doc.getText("text").toString()).toBe("Hello world.");

    // two clients opening it at once both sync WITH the seeded text — neither sees an
    // empty room, so neither can seed a second copy
    const docs = [new Y.Doc(), new Y.Doc()];
    for (let i = 0; i < 2; i++) {
      const conn = new FakeConn();
      room.attach(conn);
      conn.emit(
        "message",
        Buffer.from(
          encoding.encode((enc) => {
            encoding.writeVarUint(enc, 0);
            syncProtocol.writeSyncStep1(enc, docs[i]);
          }),
        ),
      );
      const reply = conn.sent.at(-1)!;
      const dec = decoding.createDecoder(reply);
      decoding.readVarUint(dec);
      expect(decoding.readVarUint(dec)).toBe(syncProtocol.messageYjsSyncStep2);
      Y.applyUpdate(docs[i], decoding.readVarUint8Array(dec));
    }
    expect(room.doc.getText("text").toString()).toBe("Hello world.");
    expect(docs[0].getText("text").toString()).toBe("Hello world.");
    expect(docs[1].getText("text").toString()).toBe("Hello world.");
  });

  it("a closed room writes nothing: deletes do not resurrect doc_states (issue #9)", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const rooms = new RoomManager(db);
    const room = rooms.room("doc1");
    const a = new FakeConn();
    room.attach(a);
    room.doc.transact(() => room.doc.getText("text").insert(0, "warm"), a);
    room.persist();
    expect(db.prepare("SELECT state FROM doc_states WHERE doc_id = 'doc1'").get()).toBeDefined();

    // the delete route retires the room, then cascades the rows
    rooms.close("doc1");
    db.prepare("DELETE FROM doc_states WHERE doc_id = 'doc1'").run();
    db.prepare("DELETE FROM documents WHERE id = 'doc1'").run();

    // the transport notices late: detach -> persist must write nothing
    a.emit("close");
    expect(db.prepare("SELECT state FROM doc_states WHERE doc_id = 'doc1'").get()).toBeUndefined();
    // and a frame racing the close is ignored, not applied to a zombie room
    a.emit("message", Buffer.from(new Uint8Array([0])));
    expect(db.prepare("SELECT state FROM doc_states WHERE doc_id = 'doc1'").get()).toBeUndefined();
  });

  it("closeStale keeps byte-identical warm rooms but drops replaced ones (issue #9)", () => {
    const db = openMemoryDb();
    seedDoc(db, "doc1");
    const rooms = new RoomManager(db);
    const room = rooms.room("doc1");
    const a = new FakeConn();
    room.attach(a);
    room.doc.transact(() => room.doc.getText("text").insert(0, "notes"), a);
    room.persist();

    // an import that rewrites identical bytes (the app's merge-import) must NOT evict:
    // open documents keep collaborating
    const row = db.prepare("SELECT state FROM doc_states WHERE doc_id = 'doc1'").get() as {
      state: Uint8Array;
    };
    rooms.closeStale();
    expect(rooms.room("doc1")).toBe(room);

    // an import that replaced the state: the warm room goes, the next one reloads from disk
    const replacement = new Y.Doc();
    replacement.getText("text").insert(0, "imported");
    db.prepare("UPDATE doc_states SET state = ? WHERE doc_id = 'doc1'").run(Y.encodeStateAsUpdate(replacement));
    rooms.closeStale();
    expect(rooms.room("doc1")).not.toBe(room);
    expect(rooms.room("doc1").doc.getText("text").toString()).toBe("imported");
  });
});

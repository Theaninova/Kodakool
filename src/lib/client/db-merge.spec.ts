import { describe, expect, it } from "vitest";
import { mergeBlobs } from "./db-merge";
import type { StoreBlob } from "./blob";

const empty = (): StoreBlob => ({
  version: 1,
  users: [],
  projects: [],
  members: [],
  documents: [],
  catalogs: [],
  pdfs: [],
  states: [],
  meta: [],
});

const blob = (over: Partial<StoreBlob>): StoreBlob => ({ ...empty(), ...over });

describe("mergeBlobs", () => {
  it("keeps both users' rows when the emails differ, unions the rest by id", () => {
    const current = blob({
      users: [{ id: "u1", email: "a@b.de" }],
      projects: [{ id: "p1", name: "keepme" }],
      documents: [{ id: "d1", project_id: "p1", name: "a.txt" }],
    });
    const incoming = blob({
      users: [{ id: "u2", email: "c@d.de" }],
      projects: [{ id: "p2", name: "fresh" }],
      documents: [{ id: "d2", project_id: "p2", name: "b.txt" }],
    });
    const { blob: merged, fresh } = mergeBlobs(current, incoming);
    expect(fresh).toBe(0);
    expect(merged.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(merged.documents.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
  });

  it("renames a project whose name is taken to Name1 and re-keys its whole subtree", () => {
    const current = blob({
      users: [{ id: "u1", email: "a@b.de" }],
      projects: [{ id: "p1", owner: "u1", name: "Kodieren" }],
      documents: [{ id: "d1", project_id: "p1", name: "spd.txt", text: "ORIGINAL" }],
      pdfs: [{ doc_id: "d1" }],
      states: [{ doc_id: "d1" }],
    });
    // a backup of "Kodieren": same project id, same document ids, changed content
    const incoming = blob({
      users: [{ id: "u1", email: "a@b.de" }],
      projects: [{ id: "p1", owner: "u1", name: "Kodieren" }],
      documents: [{ id: "d1", project_id: "p1", name: "spd.txt", text: "BACKUP" }],
      catalogs: [{ project_id: "p1", data: "{}" }],
      pdfs: [{ doc_id: "d1" }],
      states: [{ doc_id: "d1" }],
      members: [{ project_id: "p1", user_id: "u1" }],
    });
    const { blob: merged, fresh } = mergeBlobs(current, incoming);
    expect(fresh).toBe(1);
    // the original row survives untouched — the backup landed as a new project
    expect(merged.documents.find((d) => d.id === "d1")?.text).toBe("ORIGINAL");
    const clone = merged.projects.find((p) => p.name === "Kodieren1");
    expect(clone).toBeTruthy();
    expect(clone!.id).not.toBe("p1");
    expect(merged.projects.map((p) => p.name).sort()).toEqual(["Kodieren", "Kodieren1"]);

    const cloneDoc = merged.documents.find((d) => d.project_id === clone!.id);
    expect(cloneDoc?.text).toBe("BACKUP");
    expect(cloneDoc?.id).not.toBe("d1");
    expect(merged.catalogs.find((c) => c.project_id === clone!.id)).toBeTruthy();
    expect(merged.members.find((m) => m.project_id === clone!.id)).toBeTruthy();
    expect(merged.pdfs.some((p) => p.doc_id === cloneDoc!.id)).toBe(true);
    expect(merged.states.some((s) => s.doc_id === cloneDoc!.id)).toBe(true);
    // nothing still points at the (now clone-scoped) old ids besides the original's own rows
    expect(merged.pdfs).toHaveLength(2);
    expect(merged.states).toHaveLength(2);
  });

  it("clones on an id collision even under a free name, and numbers repeated imports", () => {
    const current = blob({ projects: [{ id: "p1", name: "old name" }] });
    const incoming = blob({ projects: [{ id: "p1", name: "other" }] });
    const first = mergeBlobs(current, incoming);
    expect(first.fresh).toBe(1);
    expect(first.blob.projects.map((p) => p.name).sort()).toEqual(["old name", "other1"]);
    // re-importing the same backup into the result: the id and the base name are taken
    const second = mergeBlobs(first.blob, incoming);
    expect(second.blob.projects.map((p) => p.name).sort()).toEqual(["old name", "other1", "other2"]);
  });

  it("keeps the foreign-user email remap (unique-email rollback protection)", () => {
    const current = blob({ users: [{ id: "u1", email: "me@b.de" }] });
    const incoming = blob({
      users: [{ id: "u9", email: "me@b.de" }],
      projects: [{ id: "p9", owner: "u9", name: "imported" }],
      members: [{ project_id: "p9", user_id: "u9" }],
    });
    const { blob: merged } = mergeBlobs(current, incoming);
    expect(merged.users).toHaveLength(1);
    expect(merged.projects[0].owner).toBe("u1");
    expect(merged.members[0].user_id).toBe("u1");
  });
});

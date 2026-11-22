import type { StoreBlob } from "$lib/client/blob";

/**
 * The import merge used by DatabaseControls: rows union by id (incoming wins) —
 * EXCEPT projects, which are never overwritten: a project whose id or name is
 * already taken lands as a brand-new project named `<name>1`, `<name>2`, … with
 * every child row (documents, catalog, members, PDF bytes, room states) re-keyed
 * to the clone, so re-importing a backup of an existing project cannot touch it.
 */
export function mergeBlobs(current: StoreBlob, incomingIn: StoreBlob): { blob: StoreBlob; fresh: number } {
  // A backup from another browser/profile carries its own UUID for the same local
  // user; merging both user rows violates UNIQUE(users.email) and the server rolls
  // the whole import back. Identity resolution: an incoming user whose email
  // matches an existing one adopts that id, and every reference to the old one
  // (project owners, members) is rewritten before merging.
  let incoming = incomingIn;
  const idByEmail = new Map<string, string>();
  for (const u of current.users) if (u.email) idByEmail.set(u.email, u.id);
  const remap = new Map<string, string>();
  for (const u of incoming.users) {
    const existing = u.email ? idByEmail.get(u.email) : undefined;
    if (existing && existing !== u.id) remap.set(u.id, existing);
  }
  if (remap.size > 0) {
    const uid = (id: string) => remap.get(id) ?? id;
    incoming = {
      ...incoming,
      users: incoming.users.map((u) => ({ ...u, id: uid(u.id) })),
      projects: incoming.projects.map((p) => (p.owner === undefined ? p : { ...p, owner: uid(p.owner) })),
      members: incoming.members.map((m) => ({ ...m, user_id: uid(m.user_id) })),
    };
  }

  // projects whose id or name is already taken become fresh clones; their whole
  // subtree (documents + everything keyed by document/project id) follows them.
  const names = new Set(current.projects.map((p) => p.name));
  const ids = new Set(current.projects.map((p) => p.id));
  const projMap = new Map<string, string>(); // old id -> clone id
  const projects = incoming.projects.map((p) => {
    if (!ids.has(p.id) && !names.has(p.name)) {
      ids.add(p.id);
      names.add(p.name);
      return p;
    }
    const nid = crypto.randomUUID();
    projMap.set(p.id, nid);
    let name = `${p.name}1`;
    let n = 2;
    while (names.has(name)) {
      name = `${p.name}${n}`;
      n++;
    }
    ids.add(nid);
    names.add(name);
    return { ...p, id: nid, name };
  });
  // a cloned project's documents must get fresh ids too: their stored ids are the
  // local originals' — merging by id would MOVE them out of the untouched original
  const docMap = new Map<string, string>();
  const documents = incoming.documents.map((d) => {
    const pid = projMap.get(d.project_id);
    if (pid === undefined) return d;
    const nid = crypto.randomUUID();
    docMap.set(d.id, nid);
    return { ...d, id: nid, project_id: pid };
  });

  const byId = <T extends { id?: string; project_id?: string; doc_id?: string; key?: string }>(
    a: T[],
    b: T[],
    key: (x: T) => string,
  ): T[] => {
    const map = new Map<string, T>();
    for (const x of a) map.set(key(x), x);
    for (const x of b) map.set(key(x), x);
    return [...map.values()];
  };
  const merged: StoreBlob = {
    version: 1,
    users: byId(current.users, incoming.users, (x) => x.id),
    projects: byId(current.projects, projects, (x) => x.id),
    members: byId(
      current.members,
      incoming.members.map((m) => (projMap.has(m.project_id) ? { ...m, project_id: projMap.get(m.project_id)! } : m)),
      (x) => `${x.project_id}/${x.user_id ?? ""}`,
    ),
    documents: byId(current.documents, documents, (x) => x.id),
    catalogs: byId(
      current.catalogs,
      incoming.catalogs.map((c) => (projMap.has(c.project_id) ? { ...c, project_id: projMap.get(c.project_id)! } : c)),
      (x) => x.project_id,
    ),
    pdfs: byId(
      current.pdfs,
      incoming.pdfs.map((p) => (docMap.has(p.doc_id) ? { ...p, doc_id: docMap.get(p.doc_id)! } : p)),
      (x) => x.doc_id,
    ),
    states: byId(
      current.states,
      incoming.states.map((s) => (docMap.has(s.doc_id) ? { ...s, doc_id: docMap.get(s.doc_id)! } : s)),
      (x) => x.doc_id,
    ),
    meta: byId(current.meta, incoming.meta, (x) => x.key),
  };
  // a document sitting in a subfolder implies that subfolder: older backups carry the
  // folder path only on the documents (moves never registered the path), and the tree
  // expands registered subs — without this the restored documents would stay hidden.
  for (const p of merged.projects) {
    const paths = new Set<string>();
    try {
      for (const s of JSON.parse(p.subs ?? "[]") as unknown[]) if (typeof s === "string") paths.add(s);
    } catch {
      /* unparseable subs column: rebuild it from the documents */
    }
    for (const d of merged.documents) if (d.project_id === p.id && d.folder) paths.add(d.folder);
    p.subs = JSON.stringify([...paths].sort());
  }
  return { blob: merged, fresh: projMap.size };
}

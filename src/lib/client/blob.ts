/** the worker server's export blob shape (server/src/app.ts is the source) */
export interface StoreBlob {
  version: number;
  users: { id: string; email?: string | null; name?: string; created?: number }[];
  projects: { id: string; owner?: string; name: string; subs?: string; created?: number }[];
  members: { project_id: string; user_id: string }[];
  documents: {
    id: string;
    project_id: string;
    name: string;
    folder?: string;
    kind?: string;
    text?: string;
    codes?: string;
    versions?: string;
    updated?: number;
  }[];
  catalogs: { project_id: string; data: string }[];
  pdfs: { doc_id: string }[];
  states: { doc_id: string }[];
  meta: { key: string }[];
}

/** narrow a whole-store blob to one project (users/meta ride along: a valid import) */
export function scopeToProject(dump: StoreBlob, name: string): StoreBlob {
  const pids = new Set(dump.projects.filter((p) => p.name === name).map((p) => p.id));
  const docIds = new Set(dump.documents.filter((d) => pids.has(d.project_id)).map((d) => d.id));
  return {
    ...dump,
    projects: dump.projects.filter((p) => pids.has(p.id)),
    members: dump.members.filter((m) => pids.has(m.project_id)),
    documents: dump.documents.filter((d) => pids.has(d.project_id)),
    catalogs: dump.catalogs.filter((c) => pids.has(c.project_id)),
    pdfs: dump.pdfs.filter((p) => docIds.has(p.doc_id)),
    states: dump.states.filter((s) => docIds.has(s.doc_id)),
  };
}

<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import "material-symbols/rounded.css";
  import CatalogTree from "$lib/coding/CatalogTree.svelte";
  import type { CatalogView } from "$lib/coding/catalog-view";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import {
    addChildDevice,
    addBelowDevice,
    findDevice,
    moveDevice,
    removeDeviceById,
    type FrameDevice,
    type Instructions,
  } from "$lib/coding/instructions";
  import { parseCatalogFile } from "$lib/coding/import";
  import type { PaletteOptions } from "$lib/coding/palette";
  import { toQdc } from "$lib/coding/qdc";
  import { clearLocalCatalog, saveLocalCatalog } from "$lib/local/local-api";
  import { downloadText } from "$lib/client/download";

  /**
   * The coding page's codes sidebar: the catalog tree — one uniform level of
   * codes (a code may carry children) — with everything edited straight on the
   * stored catalog: inline rename (row menu), tag override, grip reorder from
   * the row's end, add / delete through the row menu. Plus the JSON/.qdc
   * export + import row and the remove-catalog control. The effective catalog
   * is computed by the page (`buildCatalogView(localCatalog, entryKeys)`).
   */
  let {
    folder,
    localCatalog = $bindable(null),
    catalog,
    entryKeys,
    armed,
    confirm,
    pal,
    options,
    onpick,
    onhover,
    styleFor,
    onsave = saveLocalCatalog,
    onclear = clearLocalCatalog,
  }: {
    folder: string;
    localCatalog?: Instructions | null;
    catalog: CatalogView[];
    entryKeys: string[];
    armed: string | null;
    confirm: ConfirmAsk;
    pal: number;
    options: PaletteOptions;
    onpick: (id: string) => void;
    onhover: (id: string | null) => void;
    styleFor: (node: CatalogView) => string;
    /** catalog persistence: the local store by default, the remote page passes the server API */
    onsave?: (folder: string, instr: Instructions) => Promise<void>;
    onclear?: (folder: string) => Promise<void>;
  } = $props();

  let catIoMsg = $state("");
  let catImport = $state<HTMLInputElement | undefined>(undefined);

  /** a fresh code for the tree: new UUID, editable placeholder name, kind inherited */
  function newDevice(kind?: FrameDevice["kind"]): FrameDevice {
    return {
      id: crypto.randomUUID(),
      name: "New device",
      kind: kind ?? "device",
      examples: [],
      children: [],
    };
  }
  /** write a mutated catalog copy back to the store (every row-menu edit goes through here) */
  function persist(copy: Instructions, note: string, failLabel: string): Promise<void> {
    return onsave(folder, copy)
      .then(() => {
        localCatalog = copy;
        catIoMsg = note;
      })
      .catch((e: unknown) => {
        catIoMsg = `${failLabel}: ${e instanceof Error ? e.message : String(e)}`;
      });
  }
  /** row menu Rename (inline commit): apply the name and/or tag straight to the stored catalog */
  function storeEdit(id: string, patch: { name?: string; tag?: string }): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    const d = findDevice(copy.devices, id);
    if (!d) return;
    if (patch.name !== undefined) d.name = patch.name;
    if (patch.tag !== undefined) {
      const t = patch.tag.trim();
      if (t === "") delete d.tag;
      else d.tag = t;
    }
    void persist(copy, `Device "${d.name}" updated`, "save failed");
  }
  /** grip drag: reorder/re-parent straight on the stored catalog */
  function storeMove(dragId: string, targetId: string): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    if (!moveDevice(copy.devices, dragId, targetId)) return;
    void persist(copy, "", "move failed");
  }
  /** header `New code`: under the armed code when one is armed, else top level
      (bootstrapping an empty catalog from nothing) */
  function addStoredTop(): void {
    if (localCatalog === null) {
      void persist({ version: 1, title: folder, devices: [newDevice()] }, "New code added", "save failed");
      return;
    }
    if (armed === null) {
      const copy = plainClone(localCatalog);
      addChildDevice(copy.devices, null, newDevice());
      void persist(copy, "New code added", "save failed");
      return;
    }
    addStoredChild(armed);
  }
  /** row menu: a child code straight into the stored local catalog */
  function addStoredChild(parentId: string): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    const parent = findDevice(copy.devices, parentId);
    if (!parent) return;
    addChildDevice(copy.devices, parentId, newDevice(parent.kind));
    void persist(copy, `New code added under "${parent.name}"`, "save failed");
  }
  /** row menu: a sibling code directly below `id` in the stored catalog */
  function addStoredBelow(id: string): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    const above = findDevice(copy.devices, id);
    if (!above) return;
    addBelowDevice(copy.devices, id, newDevice(above.kind));
    void persist(copy, `New code added below "${above.name}"`, "save failed");
  }
  /** remove a device straight from the stored local catalog (entries survive as orphan codes) */
  function removeDevice(id: string): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    const removed = removeDeviceById(copy.devices, id);
    if (!removed) return;
    void persist(copy, `Device "${removed.name}" deleted — its entries stay as orphaned codes`, "delete failed");
  }
  /** shared countdown confirmation for deletes (orphan rule: entries survive) */
  function confirmDelete(d: FrameDevice, perform: () => void): void {
    const used = entryKeys.filter((k) => k === d.id).length;
    confirm.ask(
      `Delete device "${d.name}"?`,
      used > 0
        ? `${used} code entr${used === 1 ? "y" : "ies"} use this device; they stay in the file as orphaned codes.`
        : "No code entries use this device.",
      perform,
    );
  }
  /** row menu delete: the countdown confirmation, applied to the stored catalog */
  function askRemoveDevice(id: string): void {
    if (localCatalog === null) return;
    const d = findDevice(localCatalog.devices, id);
    if (d) confirmDelete(d, () => removeDevice(id));
  }
  /** remove the whole local catalog (counts the same orphan rule: entries survive) */
  function askRemoveCatalog(): void {
    confirm.ask(
      `Remove the catalog of ${folder}?`,
      "The stored frame-device catalog is discarded; coded entries survive as orphaned codes.",
      () =>
        void onclear(folder)
          .then(() => {
            localCatalog = null;
            catIoMsg = "catalog removed";
          })
          .catch((e: unknown) => {
            catIoMsg = `remove failed: ${e instanceof Error ? e.message : String(e)}`;
          }),
    );
  }
  /** Proxy-safe deep clone: Svelte 5 props/$state are proxies and structuredClone rejects them. */
  function plainClone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }

  // ----- frame-device catalog export / import (local override only) -----

  function exportCatJson(): void {
    const instr = localCatalog;
    if (!instr) return;
    downloadText(`${folder}-devices.json`, JSON.stringify(instr, null, 2), "application/json");
  }
  function exportCatQdc(): void {
    const instr = localCatalog;
    if (!instr) return;
    downloadText(`${folder}.qdc`, toQdc(instr, { origin: folder, options }), "application/xml");
  }
  async function importCat(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const parsed = parseCatalogFile(file.name, await file.text());
      await onsave(folder, parsed);
      localCatalog = parsed;
      catIoMsg = `imported ${parsed.devices.length} top-level devices`;
    } catch (err) {
      catIoMsg = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
</script>

<aside class="catalog" data-pal={pal}>
  <ScrollArea.Root class="wsarea" type="hover">
    <ScrollArea.Viewport class="wsview catview">
      <div class="catbody">
        <div class="cathd">
          <div class="cathead">
            <button
              type="button"
              class="cattool addcode"
              title={armed === null ? "Add a new code (top level)" : "Add a new code under the armed device"}
              onclick={addStoredTop}
            >
              <span class="material-symbols-rounded" aria-hidden="true">add</span>New code
            </button>
            <button
              type="button"
              class="cattool"
              onclick={() => catImport?.click()}
              title="Import frame devices from .json or .qdc"
            >
              <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>Import
            </button>
            <input
              type="file"
              accept=".json,.qdc"
              class="catfile"
              bind:this={catImport}
              onchange={(e) => void importCat(e)}
            />
            {#if localCatalog !== null}
              <button type="button" class="cattool" onclick={exportCatJson} title="Export frame devices as JSON">
                <span class="material-symbols-rounded" aria-hidden="true">file_download</span>JSON
              </button>
              <button type="button" class="cattool" onclick={exportCatQdc} title="Export frame devices as .qdc (lossy)">
                <span class="material-symbols-rounded" aria-hidden="true">file_download</span>.qdc
              </button>
              <button type="button" class="cattool danger" onclick={askRemoveCatalog} title="Discard the local catalog">
                Remove catalog
              </button>
            {/if}
          </div>
        </div>
        {#if catIoMsg}<p class="catio">{catIoMsg}</p>{/if}
        <CatalogTree
          {catalog}
          selected={armed}
          {styleFor}
          {onpick}
          {onhover}
          onedit={storeEdit}
          onmove={storeMove}
          onadd={addStoredChild}
          onaddbelow={addStoredBelow}
          ondelete={askRemoveDevice}
        />
      </div>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar class="wsbar" orientation="vertical">
      <ScrollArea.Thumb class="wsthumb" />
    </ScrollArea.Scrollbar>
  </ScrollArea.Root>
</aside>

<style lang="scss">
  aside {
    min-height: 0;
  }
  /* frame-devices sidebar: fills the viewport, tree scrolls inside */
  aside.catalog {
    display: flex;
    flex-direction: column;
    height: 100%;

    .cathd {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--surface, white);
      padding: 0.2rem 0;
    }
  }
  .catbody {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1;
    min-height: 0;
  }

  /* tools row: New code + Import always; export + remove catalog when a catalog exists */
  .cathead {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.3rem;
  }

  .cattool {
    font: inherit;
    font-size: 0.72rem;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--outline, #888);
    background: var(--surface, white);
    color: var(--on-surface-variant, #666);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;

    .material-symbols-rounded {
      font-size: 0.9rem;
    }

    &:hover {
      filter: brightness(1.1);
    }

    &.danger:hover {
      color: #b3261e;
      border-color: #b3261e;
    }
  }
  .catfile {
    display: none;
  }
  .catio {
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    margin: 0.3rem 0 0;
  }

  @media (max-width: 50rem) {
    aside.catalog {
      height: auto;
      overflow: visible;
    }
  }
</style>

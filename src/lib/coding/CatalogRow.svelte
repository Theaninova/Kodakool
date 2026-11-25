<script lang="ts">
  import { createDraggable, createDroppable } from "@dnd-kit/svelte";
  import "material-symbols/rounded.css";
  import { boldSegments, codeId, type CatalogRowNode, type CatalogView } from "$lib/coding/catalog-view";
  import { openRowMenu } from "$lib/coding/context-menu";
  import { UUID_RE, type MovePlacement } from "$lib/coding/instructions";
  import RowMenu from "$lib/coding/RowMenu.svelte";

  /**
   * One row of the codes sidebar as a dnd-kit pair: the row div is the drag
   * source (activated only from the grip, which is the drag handle) and the
   * drop target whose pointer zone the parent turns into the drop placement.
   * Tree structure, folding and the drop bookkeeping stay in CatalogTree.
   */
  let {
    n,
    counts = null,
    selected = null,
    styleFor = () => "",
    movable = false,
    drop = null,
    regRow,
    /** inline-rename commit: writes the name and/or the tag override of one device */
    onedit,
    /** add a child device under this row's device */
    onadd,
    /** add a sibling device directly below this row's device */
    onaddbelow,
    /** request deletion of this row's device (parent confirms) */
    ondelete,
    onpick,
    onhover,
  }: {
    n: CatalogRowNode;
    /** per-node counts keyed by catalog id; null falls back to the server count on each node */
    counts?: Map<string, number> | null;
    /** catalog id of the currently selected (armed) device */
    selected?: string | null;
    /** css custom properties applied to the row (e.g. --marker, --fill) */
    styleFor?: (node: CatalogView) => string;
    /** the grip exists (and the row is draggable) only when the page can persist moves */
    movable?: boolean;
    /** the row a grip drag hovers + where on it the code would land */
    drop?: { id: string; mode: MovePlacement } | null;
    /** report this row's element to the tree so it can measure the drop zones */
    regRow?: (id: string, el: HTMLElement | null) => void;
    onedit?: (id: string, patch: { name?: string; tag?: string }) => void;
    onadd?: (id: string) => void;
    onaddbelow?: (id: string) => void;
    ondelete?: (id: string) => void;
    /** called with the device id when the row is clicked */
    onpick?: (id: string) => void;
    onhover?: (id: string | null) => void;
  } = $props();

  // getters, so the entity follows the (keyed, effectively stable) props
  const drag = createDraggable({
    get id() {
      return n.item.id;
    },
    get disabled() {
      return !movable;
    },
  });
  const zone = createDroppable({
    get id() {
      return n.item.id;
    },
  });
  /** the row div is both the drag source (when movable) and the drop target */
  function attachRow(el: HTMLElement): () => void {
    regRow?.(n.item.id, el);
    // an unmovable row never attaches its draggable: dnd-kit's Accessibility
    // plugin would stamp aria-disabled onto the row and eat its click semantics
    const dragOff = movable ? drag.attach(el) : undefined;
    const zoneOff = zone.attach(el);
    return () => {
      regRow?.(n.item.id, null);
      dragOff?.();
      zoneOff();
    };
  }

  /** the row whose rename inputs are open (local: only this row ever edits itself) */
  let renaming = $state(false);
  let renameTag = $state("");
  let renameName = $state("");

  function countOf(node: CatalogView): number {
    const own = counts === null ? node.count : (counts.get(node.id) ?? 0);
    return own + (node.children?.reduce((s, c) => s + countOf(c), 0) ?? 0);
  }

  /** the row menu's Rename: open the inline editor, pre-filled with the current tag + name */
  function startRename(): void {
    renaming = true;
    renameTag = n.item.tag ?? "";
    renameName = n.item.name;
  }
  /** Enter/blur: one commit for both inputs; an empty name keeps the old one */
  function commitRename(): void {
    if (!renaming) return;
    renaming = false;
    const patch: { name?: string; tag?: string } = {};
    const name = renameName.trim();
    if (name !== "" && name !== n.item.name) patch.name = name;
    const tag = renameTag.trim();
    if (tag !== (n.item.tag ?? "")) patch.tag = tag;
    if (Object.keys(patch).length > 0) onedit?.(n.item.id, patch);
  }

  function click(): void {
    // every catalog row is a code — parents included; folding is the caret's alone
    if (renaming) return;
    if (UUID_RE.test(n.item.id)) onpick?.(n.item.id);
  }
</script>

<RowMenu
  items={[
    ...(!UUID_RE.test(n.item.id)
      ? []
      : [{ label: "Code with this device", icon: "edit_note", onSelect: () => onpick?.(n.item.id) }]),
    ...(onadd ? [{ label: "New child code", icon: "tab_new_right", onSelect: () => onadd(n.item.id) }] : []),
    ...(onaddbelow ? [{ label: "New below", icon: "add_row_below", onSelect: () => onaddbelow(n.item.id) }] : []),
    ...(onedit && UUID_RE.test(n.item.id) ? [{ label: "Rename", icon: "edit", onSelect: startRename }] : []),
    ...(ondelete
      ? [{ label: "Delete", icon: "delete", danger: true, sep: true, onSelect: () => ondelete(n.item.id) }]
      : []),
  ]}
>
  {#snippet trigger({ props }: { props: Record<string, unknown> })}
    {@const { style: triggerStyle, ...rest } = props}
    <div
      {...n.attrs}
      class="tnode"
      class:renaming
      class:group={n.canExpand}
      class:unused={countOf(n.item) === 0}
      class:sel={selected === n.item.id}
      class:dinside={drop?.id === n.item.id && drop?.mode === "inside"}
      class:dbefore={drop?.id === n.item.id && drop?.mode === "before"}
      class:dafter={drop?.id === n.item.id && drop?.mode === "after"}
      class:dragging={drag.isDragSource}
      style={`${styleFor(n.item)};pointer-events:auto`}
      onmouseenter={() => onhover?.(n.item.id)}
      onmouseleave={() => onhover?.(null)}
      onclick={click}
      {...rest}
      {@attach attachRow}
    >
      <span
        class="caret material-symbols-rounded"
        class:hidden={!n.canExpand}
        class:open={n.expanded}
        aria-hidden="true"
        title={n.canExpand ? (n.expanded ? "Collapse" : "Expand") : undefined}
        onclick={(e) => {
          if (n.canExpand) {
            e.stopPropagation();
            n.toggleExpand();
          }
        }}>{n.canExpand ? "chevron_right" : ""}</span
      >
      {#if renaming}
        <input
          class="ttag"
          value={renameTag}
          placeholder={n.item.slug?.short ?? "tag"}
          maxlength={12}
          spellcheck="false"
          title={n.item.code}
          aria-label={`Tag ${n.item.name || n.item.code}`}
          oninput={(e) => (renameTag = e.currentTarget.value)}
          onkeydown={(e) => {
            // melt's tree eats letters as typeahead and preventDefaults Ctrl+letters
            // (Ctrl+A = select all nodes) — the rename inputs own their keys entirely
            e.stopPropagation();
            if (e.key === "Enter") {
              commitRename();
            } else if (e.key === "Escape") {
              renaming = false;
            }
          }}
          onblur={(e) => {
            // moving focus to the row's other input keeps the editor open
            if ((e.relatedTarget as HTMLElement | null)?.closest(".tnode") === e.currentTarget.parentElement) return;
            commitRename();
          }}
        />
        <input
          class="tedit"
          value={renameName}
          placeholder="Name"
          spellcheck="false"
          aria-label={`Name ${n.item.name || n.item.code}`}
          oninput={(e) => (renameName = e.currentTarget.value)}
          onkeydown={(e) => {
            // melt's tree eats letters as typeahead and preventDefaults Ctrl+letters
            // (Ctrl+A = select all nodes) — the rename inputs own their keys entirely
            e.stopPropagation();
            if (e.key === "Enter") {
              commitRename();
            } else if (e.key === "Escape") {
              renaming = false;
            }
          }}
          onblur={(e) => {
            if ((e.relatedTarget as HTMLElement | null)?.closest(".tnode") === e.currentTarget.parentElement) return;
            commitRename();
          }}
        />
      {:else}
        <span class="tnum" title={n.item.code}>{n.item.slug?.short ?? codeId(n.item.code)}</span>
        <span class="tname"
          >{#each boldSegments(n.item.name, n.item.slug) as seg, si (si)}{#if seg.b}<b>{seg.t}</b
              >{:else}{seg.t}{/if}{/each}</span
        >
      {/if}
      <span class="tcount">{countOf(n.item) || ""}</span>
      {#if movable}
        <span
          class="grip material-symbols-rounded"
          {@attach drag.attachHandle}
          title="Drag onto another row — its top or bottom edge reorders beside it, its middle nests the code inside"
          aria-hidden="true"
        >
          drag_indicator</span
        >
      {/if}
      <button
        type="button"
        class="menubtn"
        title="Code actions"
        aria-label={`Menu for ${n.item.name || n.item.code}`}
        onclick={(e) => openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget)}
      >
        <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
      </button>
    </div>
  {/snippet}
</RowMenu>

<style>
  .tnode {
    display: flex;
    align-items: baseline;

    border: 1px solid var(--surface);
    gap: 0.4rem;
    text-align: left;
    background: var(--fill, transparent);
    color: var(--on-surface);
    outline: none;
    cursor: pointer;
    transition:
      background-color 180ms ease,
      color 180ms ease;
  }
  .tnode.group {
    cursor: pointer;
  }
  :root[data-theme="dark"] .tnode {
    background: var(--fill-d, transparent);
  }
  .tnode:hover {
    background: var(--marker);
    color: var(--on-marker);
  }
  :root[data-theme="dark"] .tnode:hover {
    background: var(--marker-d);
    color: var(--on-marker-d);
  }
  .tnode.unused {
    opacity: 0.55;
  }
  .tnode.sel {
    background: var(--marker);
    color: var(--on-marker);
  }
  .tnode.sel .tnum {
    color: inherit;
  }
  :root[data-theme="dark"] .tnode.sel {
    background: var(--marker-d);
    color: var(--on-marker-d);
  }
  .caret {
    width: 0.9rem;
    flex: none;
    text-align: center;
    font-size: 1.1rem;
    color: var(--on-surface-variant, #888);
    /* every catalog row arms its code on click, so the caret is the fold control */
    cursor: pointer;
    /* one glyph (chevron_right) for every expandable row: the rotation IS the
       fold/unfold motion — points right when folded, down when open */
    transition: transform 0.18s ease;

    &.open {
      transform: rotate(90deg);
    }
  }
  .caret.hidden {
    visibility: hidden;
  }
  .tnum {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--marker);
    transition: color 180ms ease;
  }
  :root[data-theme="dark"] .tnum {
    color: var(--marker-d);
  }
  .tnode:hover .tnum {
    color: inherit;
  }
  .tname {
    flex: 1;
    font-size: 0.85rem;
  }
  .tcount {
    color: inherit;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  /* the row's keyboard way into its context menu (the shared .menubtn base lives
     in the layout's themeCss — rows render it inline at the right edge) */
  .tnode .menubtn {
    flex: none;
    opacity: 0.55;
  }
  .tnode:hover .menubtn {
    opacity: 1;
  }
  /* the drag handle rides the row's END, right after the count; dnd-kit's
     pointer sensor starts the drag only from here (the row itself is the
     drop target + ghost), and 4px of travel arms it so a plain click stays dead */
  .grip {
    width: 1rem;
    flex: none;
    text-align: center;
    font-size: 1rem;
    cursor: grab;
    color: var(--on-surface-variant, #888);
  }
  /* the drop placement read from the pointer's zone on the hovered row:
     edge lines land the code beside the row, the outline nests it inside */
  .tnode.dbefore {
    box-shadow: inset 0 2px 0 var(--primary, #6750a4);
  }
  .tnode.dafter {
    box-shadow: inset 0 -2px 0 var(--primary, #6750a4);
  }
  .tnode.dinside {
    outline: 2px dashed var(--primary, #6750a4);
    outline-offset: -2px;
  }
  /* the row being dragged reads as lifted (its DragOverlay copy follows the
     cursor); siblings slide into place on drop via animate:flip */
  .tnode.dragging {
    opacity: 0.4;
  }
  .tedit {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.15rem 0.2rem;
    background: transparent;
    color: inherit;
    border: none;
    border-bottom: 1px dashed var(--outline, #888);
    border-radius: 0;
  }
  .tedit:focus {
    outline: none;
    border-bottom: 1px solid var(--primary, #6750a4);
    background: color-mix(in srgb, var(--primary, #6750a4) 8%, transparent);
  }
  /* the tag input mirrors the display tag: bold, marker-colored, left of the name */
  .ttag {
    /* tags are valid up to 12 chars (instructions.ts), and a fixed 3.6rem box hid
       26px of a 12-char tag while editing — size the box to what is typed, clamped
       so a long tag never eats the name input's space */
    box-sizing: border-box;
    field-sizing: content;
    min-width: 3.6rem;
    max-width: 7rem;
    flex: none;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.15rem 0.2rem;
    background: transparent;
    color: var(--marker, inherit);
    border: none;
    border-bottom: 1px dashed color-mix(in srgb, var(--marker, #888) 55%, transparent);
    border-radius: 0;
    transition:
      color 180ms ease,
      background-color 180ms ease,
      border-bottom-color 180ms ease;
  }
  :root[data-theme="dark"] .ttag {
    color: var(--marker-d, inherit);
    border-bottom-color: color-mix(in srgb, var(--marker-d, #888) 55%, transparent);
  }
  .ttag:focus {
    outline: none;
    border-bottom: 1px solid var(--marker, #888);
    background: color-mix(in srgb, var(--marker, #888) 12%, transparent);
  }
  :root[data-theme="dark"] .ttag:focus {
    border-bottom-color: var(--marker-d, #888);
    background: color-mix(in srgb, var(--marker-d, #888) 12%, transparent);
  }
  .tedit::placeholder,
  .ttag::placeholder {
    color: inherit;
    opacity: 0.45;
  }
  /* renaming keeps the row's own fill — hover must not repaint it solid */
  .tnode.renaming:hover {
    background: var(--fill, transparent);
    color: var(--on-surface);
  }
  :root[data-theme="dark"] .tnode.renaming:hover {
    background: var(--fill-d, transparent);
    color: var(--on-surface);
  }
</style>

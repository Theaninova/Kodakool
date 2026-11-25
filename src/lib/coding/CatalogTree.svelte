<script lang="ts" module>
  import type { CatalogView } from "$lib/coding/catalog-view";
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import { DragDropProvider, DragOverlay, PointerSensor } from "@dnd-kit/svelte";
  import {
    PointerActivationConstraints,
    type DragEndEvent,
    type DragMoveEvent,
    type DragOverEvent,
    type DragStartEvent,
  } from "@dnd-kit/dom";
  import { Tree } from "melt/builders";
  import { flip } from "svelte/animate";
  import { slide } from "svelte/transition";
  import "material-symbols/rounded.css";
  import CatalogRow from "$lib/coding/CatalogRow.svelte";
  import { codeId, inSubtree } from "$lib/coding/catalog-view";
  import type { MovePlacement } from "$lib/coding/instructions";

  let {
    catalog,
    counts = null,
    selected = null,
    styleFor = () => "",
    onpick,
    onhover,
    /** inline-rename commit: writes the name and/or the tag override of one device */
    onedit,
    /**
     * grip drop: lands `dragId` beside `targetId` (placement read from the
     * pointer's zone on the target row — its top/bottom edge reorders, its
     * middle nests it as the target's last child)
     */
    onmove,
    /** add a child device under `id` */
    onadd,
    /** add a sibling device directly below `id` */
    onaddbelow,
    /** request deletion of the device `id` (parent confirms) */
    ondelete,
  }: {
    catalog: CatalogView[];
    /** per-node counts keyed by catalog id; null falls back to the server count on each node */
    counts?: Map<string, number> | null;
    /** catalog id of the currently selected (armed) device */
    selected?: string | null;
    /** css custom properties applied to each node row (e.g. --marker, --fill) */
    styleFor?: (node: CatalogView) => string;
    /** called with the device id when a row is clicked */
    onpick?: (id: string) => void;
    onhover?: (id: string | null) => void;
    onedit?: (id: string, patch: { name?: string; tag?: string }) => void;
    onmove?: (dragId: string, targetId: string, mode: MovePlacement) => void;
    onadd?: (id: string) => void;
    onaddbelow?: (id: string) => void;
    ondelete?: (id: string) => void;
  } = $props();

  /** the device currently dragged by its grip (null between drags) */
  let dragId = $state<string | null>(null);
  /** the row a drag hovers + where on it the code would land */
  let drop = $state<{ id: string; mode: MovePlacement } | null>(null);
  /** raw pointer Y — tracked by capture-phase window listeners while dragging */
  let pointerY = 0;
  /**
   * device id → row element, fed by each row's `{@attach}`; the drop zone is
   * measured from here because the Bits context-menu trigger overrides melt's
   * DOM id on the row, so `tree.getItemEl` can never find one.
   */
  const rowEls = new Map<string, HTMLElement>();
  /** a collapsed code opened by hovering over it mid-drag — one pending open at a time */
  let pendingExpand: { id: string; timer: number } | null = null;

  // 4px of grip travel arms the drag, so a plain click on the handle stays dead.
  // KeyboardSensor is off: melt's tree owns the rows' keyboard.
  const sensors = [
    PointerSensor.configure({
      activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
    }),
  ];

  /** the top / middle / bottom zone of the target row the pointer sits in */
  function zoneOf(id: string): MovePlacement | null {
    const el = rowEls.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = (pointerY - r.top) / Math.max(r.height, 1);
    return p < 0.2 ? "before" : p > 0.8 ? "after" : "inside";
  }

  /**
   * pointermove/pointerup on window, capture phase: the sensor stopPropagates
   * its pointermoves, but a capture listener still sees them (and pointerup
   * lands before dnd-kit ends the drag, so the release zone is the final one).
   */
  function trackPointer(e: PointerEvent): void {
    pointerY = e.clientY;
    if (dragId !== null && drop !== null) {
      const mode = zoneOf(drop.id);
      drop = mode === null ? null : { id: drop.id, mode };
    }
  }

  /** recompute the hovered row + placement from the current target and pointer Y */
  function computeDrop(targetId: string | undefined): void {
    if (onmove === undefined || dragId === null || targetId === undefined || targetId === dragId) {
      drop = null;
      return;
    }
    const dragged = tree.getItem(dragId);
    if (!dragged || inSubtree(dragged.children, targetId)) {
      drop = null;
      return;
    }
    const mode = zoneOf(targetId);
    drop = mode === null ? null : { id: targetId, mode };
    if (mode === "inside") autoExpand(targetId);
  }

  /** hovering the middle of a collapsed code keeps it open after 250ms of dwell */
  function autoExpand(id: string): void {
    if (!tree.getItem(id)?.children.length || tree.isExpanded(id) || pendingExpand?.id === id) return;
    if (pendingExpand) clearTimeout(pendingExpand.timer);
    pendingExpand = {
      id,
      timer: window.setTimeout(() => {
        if (dragId !== null) tree.expand(id);
        pendingExpand = null;
      }, 250),
    };
  }

  function onDragStart(event: DragStartEvent): void {
    dragId = event.operation.source ? String(event.operation.source.id) : null;
    pointerY = (event.nativeEvent as PointerEvent | undefined)?.clientY ?? pointerY;
    window.addEventListener("pointermove", trackPointer, true);
    window.addEventListener("pointerup", trackPointer, true);
  }
  // dragover fires only on target changes, dragmove on (coalesced) moves —
  // both re-read the zone so the indicator follows the pointer within a row too.
  function onDragOver(event: DragOverEvent): void {
    computeDrop(event.operation.target?.id.toString());
  }
  function onDragMove(event: DragMoveEvent): void {
    computeDrop(event.operation.target?.id.toString());
  }
  function onDragEnd(event: DragEndEvent): void {
    window.removeEventListener("pointermove", trackPointer, true);
    window.removeEventListener("pointerup", trackPointer, true);
    if (pendingExpand) clearTimeout(pendingExpand.timer);
    pendingExpand = null;
    const source = dragId;
    const d = drop;
    dragId = null;
    drop = null;
    if (!event.canceled && source !== null && d !== null) onmove?.(source, d.id, d.mode);
  }
  onDestroy(() => {
    window.removeEventListener("pointermove", trackPointer, true);
    window.removeEventListener("pointerup", trackPointer, true);
    if (pendingExpand) clearTimeout(pendingExpand.timer);
  });

  function expandableIds(ns: CatalogView[], acc: string[] = []): string[] {
    for (const n of ns) {
      if (n.children.length) {
        acc.push(n.id);
        expandableIds(n.children, acc);
      }
    }
    return acc;
  }

  const tree = $derived(
    new Tree({
      items: catalog,
      multiple: true,
      expanded: new Set(expandableIds(catalog)),
    }),
  );
  type TreeNode = (typeof tree.children)[number];
</script>

{#snippet nodes(children: TreeNode[])}
  {#each children as n (n.id)}
    <!-- keyed wrapper: animate:flip needs the animated element to be the each block's only child -->
    <div class="titem" animate:flip={{ duration: 180 }}>
      <CatalogRow
        {n}
        {counts}
        {selected}
        {styleFor}
        movable={onmove !== undefined}
        {drop}
        regRow={(id, el) => void (el === null ? rowEls.delete(id) : rowEls.set(id, el))}
        {onpick}
        {onhover}
        {onedit}
        {onadd}
        {onaddbelow}
        {ondelete}
      />
      {#if n.canExpand && n.expanded}
        <div {...tree.group} transition:slide={{ duration: 180 }}>
          {@render nodes(n.children ?? [])}
        </div>
      {/if}
    </div>
  {/each}
{/snippet}

<DragDropProvider {sensors} {onDragStart} {onDragOver} {onDragMove} {onDragEnd}>
  <div {...tree.root} class="tree">
    {@render nodes(tree.children)}
  </div>
  <DragOverlay>
    {#snippet children(source)}
      {@const node = tree.getItem(String(source.id))}
      {#if node}
        <div class="qdrag" style={styleFor(node)}>
          <span class="qtag">{node.slug?.short ?? codeId(node.code)}</span>
          <span class="qname">{node.name}</span>
        </div>
      {/if}
    {/snippet}
  </DragOverlay>
</DragDropProvider>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    outline: none;
  }
  /* keyed per-item wrapper (row + expanded subtree) — the animate:flip carrier;
     the Bits trigger renders no extra element: `.tnode` IS the context-menu trigger */
  .titem {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* sub-code groups keep their indent, no guide line — the marker colors of
     each level carry the hierarchy */
  div[role="group"] {
    display: flex;
    flex-direction: column;
    padding-left: 1rem;
    margin-left: 0.4rem;
  }
  /* the DragOverlay copy of the dragged row, following the cursor */
  .qdrag {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.15rem 0.3rem;
    background: var(--fill, white);
    color: var(--on-surface);
    border: 1px solid var(--outline, #888);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 25%);
    pointer-events: none;
  }
  :root[data-theme="dark"] .qdrag {
    background: var(--fill-d, white);
  }
  .qtag {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--marker);
  }
  :root[data-theme="dark"] .qtag {
    color: var(--marker-d);
  }
  .qname {
    font-size: 0.85rem;
  }
</style>

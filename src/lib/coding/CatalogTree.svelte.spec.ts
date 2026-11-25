import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import CatalogTree from "./CatalogTree.svelte";
import type { CatalogView } from "$lib/coding/catalog-view";

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const PLAIN_ID = "33333333-3333-4333-8333-333333333333";

function node(id: string, code: string, name: string, children: CatalogView[] = []): CatalogView {
  return { id, code, name, kind: children.length ? "element" : "device", count: 0, slug: null, children };
}

/** `1 Rahmen > 1.1 Zitat` plus a plain `2 Kommentar` leaf. */
function catalog(): CatalogView[] {
  return [node(GROUP_ID, "1", "Rahmen", [node(CHILD_ID, "1.1", "Zitat")]), node(PLAIN_ID, "2", "Kommentar")];
}

const items = () => page.getByRole("treeitem");
/** rows are addressed by their accessible name (`code name count`) */
const item = (name: string) => page.getByRole("treeitem", { name });

async function itemCount(): Promise<number> {
  return (await items().all()).length;
}

/** text of the `.tcount` span of the row containing `name` */
function countText(name: string): string | null {
  const row = [...document.querySelectorAll(".tnode")].find((r) => r.textContent?.includes(name));
  return row?.querySelector(".tcount")?.textContent ?? null;
}

/** open a row's context menu and click Rename (the menu anchors at the pointer, so the dispatch needs coordinates) */
async function openRename(name: string): Promise<void> {
  const row = [...document.querySelectorAll<HTMLElement>(".tnode")].find((r) => r.textContent?.includes(name))!;
  const r = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(r.left + 10),
      clientY: Math.round(r.top + r.height / 2),
    }),
  );
  await page.getByRole("menuitem", { name: "Rename" }).click();
}

/** the grip (dnd-kit drag handle) of the row containing `name` */
function grip(name: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>(".tnode")]
    .find((r) => r.textContent?.includes(name))!
    .querySelector(".grip") as HTMLElement;
}
/** dnd-kit's pointer sensor listens on the handle + the document — plain bubbling PointerEvents drive it */
function pev(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: Math.round(x),
      clientY: Math.round(y),
    }),
  );
}
/** pointer coordinates in `zone` (of the row height) on the row containing `name` */
function zonePoint(name: string, zone: "before" | "inside" | "after"): { x: number; y: number } {
  const r = [...document.querySelectorAll<HTMLElement>(".tnode")]
    .find((c) => c.textContent?.includes(name))!
    .getBoundingClientRect();
  return {
    x: r.left + r.width / 3,
    y: zone === "before" ? r.top + 2 : zone === "after" ? r.bottom - 2 : r.top + r.height / 2,
  };
}
/**
 * Drive a grip drag from the row `fromName` to a zone on the row `toName`,
 * ending (or parking, when `hold` is set) with the pointer over the target.
 */
async function gripDrag(
  fromName: string,
  toName: string,
  zone: "before" | "inside" | "after",
  hold = false,
): Promise<void> {
  await expect.poll(() => grip(fromName) !== null).toBe(true);
  const g = grip(fromName);
  const gb = g.getBoundingClientRect();
  const down = { x: gb.left + gb.width / 2, y: gb.top + gb.height / 2 };
  pev(g, "pointerdown", down.x, down.y);
  pev(g, "pointermove", down.x + 20, down.y + 12); // past the 4px activation distance
  await new Promise((r) => setTimeout(r, 30)); // the sensor coalesces its moves in rAF
  const p = zonePoint(toName, zone);
  pev(g, "pointermove", p.x, p.y);
  await new Promise((r) => setTimeout(r, 30));
  if (!hold) pev(g, "pointerup", p.x, p.y);
}

describe("CatalogTree.svelte", () => {
  it("renders every node with its derived code and name", async () => {
    render(CatalogTree, { catalog: catalog() });

    await expect.poll(itemCount).toBe(3);
    await expect.element(item("1.1")).toBeInTheDocument();
    await expect.element(page.getByText("Zitat")).toBeInTheDocument();
    await expect.element(page.getByText("Kommentar")).toBeInTheDocument();
  });

  it("sums the counts of a group and its children", async () => {
    render(CatalogTree, {
      catalog: catalog(),
      counts: new Map<string, number>([
        [CHILD_ID, 2],
        [PLAIN_ID, 1],
      ]),
    });

    await expect.poll(() => countText("Zitat")).toBe("2");
    await expect.poll(() => countText("Rahmen")).toBe("2");
  });

  it("falls back to the server count on each node when no counts map is given", async () => {
    const cat = catalog();
    cat[0].count = 5;
    cat[0].children[0].count = 3;
    render(CatalogTree, { catalog: cat });

    await expect.poll(() => countText("Rahmen")).toBe("8");
    await expect.poll(() => countText("Kommentar")).toBe("");
  });

  it("marks nodes without any entry as unused", async () => {
    render(CatalogTree, { catalog: catalog(), counts: new Map([[PLAIN_ID, 1]]) });

    await expect.element(item("Zitat")).toBeInTheDocument();
    await expect.element(item("Rahmen")).toHaveClass("unused");
    await expect.element(item("Kommentar")).not.toHaveClass("unused");
  });

  it("arms a leaf device on click and marks it selected", async () => {
    const onpick = vi.fn();
    const { rerender } = render(CatalogTree, { catalog: catalog(), onpick });

    await item("Zitat").click();
    expect(onpick).toHaveBeenCalledWith(CHILD_ID);

    await rerender({ selected: CHILD_ID });
    await expect.element(item("Zitat")).toHaveClass("sel");
    await expect.element(item("Kommentar")).not.toHaveClass("sel");
  });

  it("arms a group row on click; the caret alone folds the subtree", async () => {
    const onpick = vi.fn();
    render(CatalogTree, { catalog: catalog(), onpick });

    await expect.poll(itemCount).toBe(3);
    await item("Rahmen").click();
    expect(onpick).toHaveBeenCalledWith(GROUP_ID);
    await expect.poll(itemCount).toBe(3);

    const caret = () =>
      [...document.querySelectorAll(".tnode")]
        .find((r) => r.textContent?.includes("Rahmen"))
        ?.querySelector(".caret") as HTMLElement | null;
    await expect.poll(() => caret() !== null).toBe(true);
    caret()!.click();
    await expect.poll(itemCount).toBe(2);
    expect(onpick).toHaveBeenCalledTimes(1); // the caret folds without arming anything

    caret()!.click();
    await expect.poll(itemCount).toBe(3);
  });

  it("reports the hovered node id and clears it on leave", async () => {
    const onhover = vi.fn();
    render(CatalogTree, { catalog: catalog(), onhover });

    await item("Zitat").hover();
    expect(onhover).toHaveBeenCalledWith(CHILD_ID);

    onhover.mockClear();
    await item("Zitat").unhover();
    expect(onhover).toHaveBeenCalledWith(null);
  });

  it("renders the slug short label with its bold segments", async () => {
    const cat = [node(PLAIN_ID, "2", "Transaktive Berichterstattung")];
    cat[0].slug = {
      short: "TB",
      bold: [
        { start: 0, len: 1 },
        { start: 12, len: 1 },
      ],
    };
    render(CatalogTree, { catalog: cat });

    await expect.element(page.getByText("TB")).toBeInTheDocument();
    await expect.element(page.getByText("Transaktive Berichterstattung")).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".tname b").length).toBe(2);
    await expect.poll(() => [...document.querySelectorAll(".tname b")].map((b) => b.textContent)).toEqual(["T", "B"]);
  });

  it("does not pick a legacy node whose id is not a device uuid", async () => {
    const onpick = vi.fn();
    render(CatalogTree, { catalog: [node("1.2 legacy", "1.2", "Ohne Katalog")], onpick });

    await item("Ohne Katalog").click();
    expect(onpick).not.toHaveBeenCalled();
  });

  it("renames a row inline through its context menu and commits name + tag", async () => {
    const onedit = vi.fn();
    const onpick = vi.fn();
    render(CatalogTree, { catalog: catalog(), onedit, onpick });

    // the row's context menu carries Rename (right-click the row itself)
    await expect.poll(itemCount).toBe(3);
    await openRename("Zitat");

    // the open editor commits BOTH inputs on Enter; the row click armed nothing
    const name = page.getByRole("textbox", { name: "name Zitat" });
    await name.fill("Markierung");
    await page.getByRole("textbox", { name: "tag Zitat" }).fill("K2");
    await userEvent.keyboard("{Enter}");
    expect(onedit).toHaveBeenCalledWith(CHILD_ID, { name: "Markierung", tag: "K2" });
    expect(onpick).not.toHaveBeenCalled();
  });

  // issue #12: melt's tree eats keydowns that bubble from its rows — letters are swallowed
  // as typeahead and Ctrl+letters are preventDefaulted (Ctrl+A is "select all nodes"),
  // so the rename inputs could not be typed into, copied from or pasted into.
  it("types letters and Ctrl+A into the rename inputs", async () => {
    const onedit = vi.fn();
    render(CatalogTree, { catalog: catalog(), onedit });

    await expect.poll(itemCount).toBe(3);
    await openRename("Zitat");

    const tag = page.getByRole("textbox", { name: "tag Zitat" });
    await tag.click();
    await userEvent.keyboard("Zitat");
    await expect.element(tag).toHaveValue("Zitat");

    const name = page.getByRole("textbox", { name: "name Zitat" });
    await name.click();
    await userEvent.keyboard("{Control>}{a}{/Control}");
    await expect
      .poll(() => {
        const el = document.activeElement as HTMLInputElement | null;
        return el?.selectionStart === 0 && el?.selectionEnd === el?.value.length && (el?.value.length ?? 0) > 0;
      })
      .toBe(true);

    await userEvent.keyboard("Kommentar{Enter}");
    expect(onedit).toHaveBeenCalledWith(CHILD_ID, { name: "Kommentar", tag: "Zitat" });
  });

  it("keeps a plain row click as the pick gesture", async () => {
    const onedit = vi.fn();
    const onpick = vi.fn();
    render(CatalogTree, { catalog: catalog(), onedit, onpick });
    await item("Zitat").click();
    expect(onpick).toHaveBeenCalledWith(CHILD_ID);
    expect(onedit).not.toHaveBeenCalled();
  });

  it("grip-drops a code onto a row's middle as its child", async () => {
    const onmove = vi.fn();
    render(CatalogTree, { catalog: catalog(), onmove });
    await expect.poll(itemCount).toBe(3);

    await gripDrag("Kommentar", "Zitat", "inside");
    expect(onmove).toHaveBeenCalledWith(PLAIN_ID, CHILD_ID, "inside");
  });

  it("grip-drops a code on a sibling row's edge to reorder beside it", async () => {
    const onmove = vi.fn();
    render(CatalogTree, { catalog: catalog(), onmove });
    await expect.poll(itemCount).toBe(3);

    await gripDrag("Rahmen", "Kommentar", "before");
    expect(onmove).toHaveBeenCalledWith(GROUP_ID, PLAIN_ID, "before");
  });

  it("paints the drop placement while dragging and clears it on release", async () => {
    const onmove = vi.fn();
    render(CatalogTree, { catalog: catalog(), onmove });
    await expect.poll(itemCount).toBe(3);

    await gripDrag("Kommentar", "Zitat", "inside", true);
    await expect.poll(() => !!document.querySelector(".tnode.dinside")).toBe(true);

    const g = grip("Kommentar");
    const p = zonePoint("Zitat", "inside");
    pev(g, "pointerup", p.x, p.y);
    await expect.poll(() => document.querySelector(".tnode.dinside")).toBe(null);
    expect(onmove).toHaveBeenCalledWith(PLAIN_ID, CHILD_ID, "inside");
  });

  it("refuses to drop a code into its own subtree", async () => {
    const onmove = vi.fn();
    render(CatalogTree, { catalog: catalog(), onmove });
    await expect.poll(itemCount).toBe(3);

    await gripDrag("Rahmen", "Zitat", "inside");
    await new Promise((r) => setTimeout(r, 200)); // let a late dragend land
    expect(onmove).not.toHaveBeenCalled();
  });

  it("auto-expands a collapsed code when a drag dwells inside it", async () => {
    const onmove = vi.fn();
    render(CatalogTree, { catalog: catalog(), onmove });
    await expect.poll(itemCount).toBe(3);

    // fold Rahmen under its own caret
    const caret = [...document.querySelectorAll<HTMLElement>(".tnode")]
      .find((r) => r.textContent?.includes("Rahmen"))!
      .querySelector(".caret") as HTMLElement;
    caret.click();
    await expect.poll(itemCount).toBe(2);

    await gripDrag("Kommentar", "Rahmen", "inside", true);
    await expect.poll(itemCount).toBe(3); // the dwell opened the folded code

    const g = grip("Kommentar");
    const p = zonePoint("Rahmen", "inside");
    pev(g, "pointerup", p.x, p.y);
    expect(onmove).toHaveBeenCalledTimes(1); // and the drop still lands somewhere legal
  });
});

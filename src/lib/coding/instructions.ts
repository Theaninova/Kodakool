import { z } from "zod";

export const exampleSchema = z.object({
  text: z.string().min(1),
  source: z.string().nullable().optional().default(null),
});

export interface FrameDevice {
  id: string;
  name: string;
  kind: "device" | "element";
  note?: string | undefined;
  rule?: string | undefined;
  /** manual override for the auto-generated short tag shown on chips/sidebar */
  tag?: string | undefined;
  examples: { text: string; source: string | null }[];
  children: FrameDevice[];
}

export const frameDeviceSchema: z.ZodType<FrameDevice> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    name: z.string().min(1),
    kind: z.enum(["device", "element"]),
    note: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
    tag: z.string().min(1).max(12).optional(),
    examples: z.array(exampleSchema).default([]),
    children: z.array(frameDeviceSchema).default([]),
  }),
);

export const instructionsSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  devices: z.array(frameDeviceSchema).min(1),
});

export type Instructions = z.infer<typeof instructionsSchema>;

/** Circular-free validation: every device id must be unique across the whole tree. */
export function uniqueIds(instr: Instructions): boolean {
  const seen = new Set<string>();
  const walk = (d: FrameDevice): boolean => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return d.children.every(walk);
  };
  return instr.devices.every(walk);
}

/** Derived numeric code per device id, e.g. "1.2.3" (1-based position, recursive). */
export function codeIndex(instr: Instructions): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: FrameDevice, prefix: string): void => {
    out.set(d.id, prefix);
    d.children.forEach((c, i) => walk(c, `${prefix}.${i + 1}`));
  };
  instr.devices.forEach((d, i) => walk(d, `${i + 1}`));
  return out;
}

/** Device details per id: derived numeric code, name, and kind. */
export function deviceIndex(
  instr: Instructions,
): Map<string, { code: string; name: string; kind: "device" | "element" }> {
  const out = new Map<string, { code: string; name: string; kind: "device" | "element" }>();
  const walk = (d: FrameDevice, prefix: string): void => {
    out.set(d.id, { code: prefix, name: d.name, kind: d.kind });
    d.children.forEach((c, i) => walk(c, `${prefix}.${i + 1}`));
  };
  instr.devices.forEach((d, i) => walk(d, `${i + 1}`));
  return out;
}

/** Reverse lookup: numeric code -> device id. */
export function idByCode(instr: Instructions): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, code] of codeIndex(instr)) out.set(code, id);
  return out;
}

// ----- device-tree editing operations -----
// Shared by the catalog aside's draft editing and its direct edits of the
// stored local catalog: both mutate a FrameDevice[] tree the same way.

/** Stable catalog device ids are UUID v4s — the UI guards every id hand-off with it. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Depth-first lookup by stable id. */
export function findDevice(devices: FrameDevice[], id: string): FrameDevice | null {
  for (const n of devices) {
    if (n.id === id) return n;
    const f = findDevice(n.children, id);
    if (f) return f;
  }
  return null;
}

/** The sibling list that directly contains `id` (null when the id is unknown). */
export function siblingsOf(devices: FrameDevice[], id: string): FrameDevice[] | null {
  if (devices.some((d) => d.id === id)) return devices;
  for (const n of devices) {
    const f = siblingsOf(n.children, id);
    if (f) return f;
  }
  return null;
}

/** Add `dev` under `parentId` (null = top level). False when the parent is unknown. */
export function addChildDevice(devices: FrameDevice[], parentId: string | null, dev: FrameDevice): boolean {
  if (parentId === null) {
    devices.push(dev);
    return true;
  }
  const parent = findDevice(devices, parentId);
  if (!parent) return false;
  parent.children.push(dev);
  return true;
}

/** Insert `dev` directly after `id` in its sibling list. False when `id` is unknown. */
export function addBelowDevice(devices: FrameDevice[], id: string, dev: FrameDevice): boolean {
  const list = siblingsOf(devices, id);
  if (!list) return false;
  const at = list.findIndex((d) => d.id === id);
  if (at < 0) return false;
  list.splice(at + 1, 0, dev);
  return true;
}

/** Remove `id` from its sibling list (its children go with it). Null when unknown. */
export function removeDeviceById(devices: FrameDevice[], id: string): FrameDevice | null {
  const list = siblingsOf(devices, id);
  if (!list) return null;
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return null;
  return list.splice(i, 1)[0];
}

/** Where the dragged code lands on the target row: beside it as a sibling, or nested as its last child. */
export type MovePlacement = "before" | "after" | "inside";

/**
 * Drop `dragId` onto `targetId`. With an explicit `placement`, `before`/`after`
 * insert the dragged device next to the target in the target's sibling list;
 * `inside` appends it as the target's last child. Without one, the legacy
 * drop-on-a-row heuristic stays: on a sibling it reorders within that sibling
 * list (downward moves land after the target, upward moves before it); onto any
 * other device it nests the dragged device as the target's last child. False
 * when either id is unknown or the target lies inside the dragged subtree.
 */
export function moveDevice(
  devices: FrameDevice[],
  dragId: string,
  targetId: string,
  placement?: MovePlacement,
): boolean {
  if (dragId === targetId) return false;
  const list = siblingsOf(devices, dragId);
  if (!list) return false;
  const from = list.findIndex((d) => d.id === dragId);
  if (placement) {
    const target = findDevice(devices, targetId);
    if (!target || findDevice(list[from].children, targetId)) return false;
    const [dragged] = list.splice(from, 1);
    if (placement === "inside") {
      target.children.push(dragged);
      return true;
    }
    const targetList = siblingsOf(devices, targetId) ?? [];
    const at = targetList.findIndex((d) => d.id === targetId);
    if (at < 0) return false;
    targetList.splice(placement === "before" ? at : at + 1, 0, dragged);
    return true;
  }
  const to = list.findIndex((d) => d.id === targetId);
  if (to < 0) {
    const target = findDevice(devices, targetId);
    if (!target || findDevice(list[from].children, targetId)) return false;
    const [dragged] = list.splice(from, 1);
    target.children.push(dragged);
    return true;
  }
  const [moved] = list.splice(from, 1);
  const at = list.findIndex((d) => d.id === targetId);
  list.splice(from <= to ? at + 1 : at, 0, moved);
  return true;
}

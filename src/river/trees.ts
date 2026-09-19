import type { RiverSnapshot, RiverNode } from "./types.ts";
import type { ArcPath } from "./journey.ts";
import { arcPosition } from "./layout.ts";
export interface StoryTree {
  id: string;
  root: string;
  kind: "elaboration" | "period" | "branch" | "single";
  members: Array<{ id: string; parent: string | null; depth: number }>;
  hidden: string[];
  drifting: boolean;
}
/** ELABORATES from=new detail,to=existing story (GraphStorage.apply).
 * This is a bounded forest projection; neither cycle cutting nor grouping writes G.
 * Cross-placement relations stay in detail, never give drifting evidence a date. */
export function storyTrees(data: RiverSnapshot, maxDepth = 3): StoryTree[] {
  const nodes = new Map<string, (typeof data.nodes)[number]>(
    data.nodes.map((n) => [n.id, n]),
  );
  const parent = new Map<string, string>();
  const limit = Math.min(3, Math.max(1, maxDepth));
  for (const e of [...data.relations].sort((a, b) =>
    `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`),
  )) {
    if (
      e.kind !== "ELABORATES" ||
      e.from === e.to ||
      parent.has(e.from) ||
      !nodes.has(e.from) ||
      !nodes.has(e.to) ||
      nodes.get(e.from)!.placement !== nodes.get(e.to)!.placement
    )
      continue;
    let p: string | undefined = e.to;
    while (p && p !== e.from) p = parent.get(p);
    if (!p) parent.set(e.from, e.to);
  }
  const children = new Map<string, string[]>();
  for (const [child, p] of parent)
    children.set(p, [...(children.get(p) ?? []), child]);
  const trees: StoryTree[] = [];
  for (const n of data.nodes.filter((n) => !parent.has(n.id))) {
    const t: StoryTree = {
      id: n.id,
      root: n.id,
      kind: children.has(n.id) ? "elaboration" : "single",
      members: [],
      hidden: [],
      drifting: n.placement === "drifting",
    };
    const visit = (id: string, depth: number, p: string | null) => {
      if (depth <= limit && t.members.length < 8)
        t.members.push({ id, depth, parent: p });
      else t.hidden.push(id);
      for (const c of children.get(id) ?? []) visit(c, depth + 1, id);
    };
    visit(n.id, 0, null);
    trees.push(t);
  }
  // Memo membership is a group label only, never an invented ELABORATES edge.
  const group = (members: StoryTree[], kind: "branch" | "period") => {
    if (members.length < 2) return;
    const first = members[0]!;
    const rest = members.slice(1);
    first.kind = kind;
    for (const t of rest) {
      first.members.push(
        ...t.members.map((m) => ({ ...m, depth: 1, parent: null })),
      );
      trees.splice(trees.indexOf(t), 1);
    }
    if (first.members.length > 8)
      first.hidden.push(...first.members.splice(8).map((m) => m.id));
  };
  for (const g of data.storyGroups ?? []) {
    for (const drifting of [false, true])
      group(
        trees.filter(
          (t) =>
            t.kind === "single" &&
            t.drifting === drifting &&
            g.nodeIds.includes(t.root),
        ),
        "branch",
      );
  }
  const buckets = new Map<string, StoryTree[]>();
  for (const t of trees.filter((t) => t.kind === "single")) {
    const n = nodes.get(t.root)!;
    const key = t.drifting
      ? "drifting"
      : String(Math.floor(n.time.start! / 24));
    buckets.set(key, [...(buckets.get(key) ?? []), t]);
  }
  for (const ts of buckets.values()) if (ts.length >= 3) group(ts, "period");
  return trees;
}
export function treeGeometry(
  tree: StoryTree,
  path: ArcPath,
  root: RiverNode,
  min: number,
  max: number,
  width: number,
  preferred = 1,
) {
  const length = path.getTotalLength();
  const s =
    root.placement === "drifting"
      ? length / 2
      : arcPosition((root.time.start! + root.time.end!) / 2, min, max, length);
  const anchor = path.getPointAtLength(s);
  const a = path.getPointAtLength(Math.max(0, s - 2)),
    b = path.getPointAtLength(Math.min(length, s + 2));
  const norm = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const tangent = { x: (b.x - a.x) / norm, y: (b.y - a.y) / norm };
  const normal = { x: tangent.y, y: -tangent.x };
  const side =
    width < 520
      ? 1
      : (preferred < 0 && anchor.x > width * 0.38) ||
          width - anchor.x < width * 0.38
        ? -1
        : 1;
  const available = side > 0 ? width - anchor.x - 24 : anchor.x - 24;
  const depth = Math.max(1, ...tree.members.map((m) => m.depth));
  const spacing = Math.max(20, Math.min(92, available / (depth + 1.3)));
  const levels = new Map<number, typeof tree.members>();
  for (const m of tree.members)
    levels.set(m.depth, [...(levels.get(m.depth) ?? []), m]);
  const points = tree.members.map((m) => {
    const peers = levels.get(m.depth)!;
    const sibling = tree.members.indexOf(m) * 112;
    const distance = (m.depth + 0.65) * spacing * side;
    // Shrink tangential fan only if necessary, keeping the root time anchor fixed.
    const proposedX = anchor.x + normal.x * distance;
    const dx = tangent.x * sibling;
    const factor =
      dx === 0
        ? 1
        : Math.max(
            0,
            Math.min(
              1,
              (dx > 0 ? width - 22 - proposedX : proposedX - 22) / Math.abs(dx),
            ),
          );
    return {
      ...m,
      x: proposedX + dx * factor,
      y: anchor.y + normal.y * distance + tangent.y * sibling * factor,
    };
  });
  return { anchor, s, tangent, normal, side, spacing, points };
}
export function selectedCrossLinks(data: RiverSnapshot, id: string | null) {
  return id
    ? data.relations
        .filter(
          (e) =>
            ["CAUSES", "RELATES_TO"].includes(e.kind) &&
            (e.from === id || e.to === id),
        )
        .slice(0, 12)
    : [];
}

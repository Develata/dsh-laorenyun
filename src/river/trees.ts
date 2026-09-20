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
  for (const n of [...data.nodes]
    .filter((n) => !parent.has(n.id))
    .sort(
      (a, b) =>
        (a.time.start ?? 0) - (b.time.start ?? 0) || a.id.localeCompare(b.id),
    )) {
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
    first.members = first.members.map((m) => ({
      ...m,
      depth: 1,
      parent: null,
    }));
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
  for (const t of trees.filter((t) => t.kind === "single" && !t.drifting)) {
    const n = nodes.get(t.root)!;
    const key = String(Math.floor(n.time.start! / 24));
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
  const grouped = tree.kind === "period" || tree.kind === "branch";
  const rotate = (d: { x: number; y: number }, angle: number) => ({
    x: d.x * Math.cos(angle) - d.y * Math.sin(angle),
    y: d.x * Math.sin(angle) + d.y * Math.cos(angle),
  });
  const base = { x: normal.x * side, y: normal.y * side };
  const available = Math.max(
    90,
    side > 0 ? width - anchor.x - 72 : anchor.x - 72,
  );
  const maxDepth = Math.max(
    1,
    ...tree.members.map((m) => m.depth + (grouped ? 1 : 0)),
  );
  const scale = Math.min(1.25, available / (70 + maxDepth * 105));
  const spacing = 120 * scale;
  const junction = {
    x: anchor.x + base.x * 65 * scale,
    y: anchor.y + base.y * 65 * scale,
    direction: base,
  };
  type Point = StoryTree["members"][number] & {
    x: number;
    y: number;
    direction: { x: number; y: number };
  };
  const points: Point[] = [];
  const children = (id: string | null) =>
    tree.members
      .filter((m) => m.parent === id)
      .sort((a, b) => a.id.localeCompare(b.id));
  const visit = (
    members: StoryTree["members"],
    parent: typeof junction,
    depth: number,
  ) => {
    const halfFan =
      members.length < 2 ? 0 : Math.min(0.72, 0.58 * (members.length - 1));
    members.forEach((m, i) => {
      const angle =
        members.length === 1
          ? depth % 2
            ? 0.14
            : -0.23
          : ((2 * i) / (members.length - 1) - 1) * halfFan;
      const direction = rotate(parent.direction, angle);
      const length = Math.max(75, 130 - depth * 15) * scale;
      const point = {
        ...m,
        direction,
        x: parent.x + direction.x * length,
        y: parent.y + direction.y * length,
      };
      points.push(point);
      visit(children(m.id), point, depth + 1);
    });
  };
  if (grouped) visit(children(null), junction, 1);
  else {
    const m = tree.members[0]!;
    const rootPoint = { ...m, ...junction };
    points.push(rootPoint);
    visit(children(m.id), rootPoint, 1);
  }
  // A local collision pass spreads crowded sibling subtrees along the root tangent.
  // Moving all descendants together preserves the parent-relative subtree shape.
  for (const parentId of new Set(points.map((p) => p.parent))) {
    const peers = points.filter(
      (p) => p.parent === parentId && (grouped || p.parent !== null),
    );
    if (peers.length < 2) continue;
    const along = (p: Point) => p.x * tangent.x + p.y * tangent.y;
    peers.sort((a, b) => along(a) - along(b) || a.id.localeCompare(b.id));
    const shifts: number[] = [];
    let previous = -Infinity;
    for (const p of peers) {
      const target = Math.max(along(p), previous + 100);
      shifts.push(target - along(p));
      previous = target;
    }
    const mean = shifts.reduce((a, b) => a + b, 0) / shifts.length;
    peers.forEach((p, i) => {
      const delta = shifts[i]! - mean;
      const move = (id: string) => {
        const point = points.find((q) => q.id === id)!;
        point.x += tangent.x * delta;
        point.y += tangent.y * delta;
        for (const child of points.filter((q) => q.parent === id))
          move(child.id);
      };
      move(p.id);
    });
  }
  // Keep the entire fan inside the bank. Only the display subtree moves; s/anchor never change.
  // On narrow viewports use a taller fan so touch areas remain distinct.
  if (width < 520) {
    const ordered = [...points].sort(
      (a, b) => a.y - b.y || a.id.localeCompare(b.id),
    );
    for (let i = 1; i < ordered.length; i++) {
      const p = ordered[i]!,
        previous = ordered[i - 1]!;
      if (p.y - previous.y < 100) p.y = previous.y + 100;
    }
  }
  const low = Math.min(...points.map((p) => p.y));
  if (low < 80) for (const p of points) p.y += 80 - low;
  for (const p of points) p.x = Math.max(64, Math.min(width - 64, p.x));
  return {
    anchor,
    s,
    tangent,
    normal,
    side,
    spacing,
    points,
    junction: grouped ? junction : null,
  };
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

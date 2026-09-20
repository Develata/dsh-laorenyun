import { test } from "node:test";
import assert from "node:assert/strict";
import {
  storyTrees,
  treeGeometry,
  selectedCrossLinks,
} from "../src/river/trees.ts";
import type { RiverSnapshot, RiverNode } from "../src/river/types.ts";
const node = (id: string, drifting = false): RiverNode => ({
  id: id as never,
  revision: 1,
  keySentence: id,
  time: {
    start: drifting ? null : 24000,
    end: drifting ? null : 24000,
    precision: drifting ? "unknown" : "month",
    certainty: "stated",
    originalText: "",
  },
  placement: drifting ? "drifting" : "anchored",
  status: "confirmed",
});
const snapshot = (relations: RiverSnapshot["relations"]): RiverSnapshot => ({
  graphRevision: 1,
  nodes: ["a", "b", "c", "d", "e"].map((x) => node(x)),
  relations,
  total: 5,
  offset: 0,
  truncated: false,
  periods: [],
});
test("ELABORATES orientation, depth cap and cycles are bounded without altering graph", () => {
  const s = snapshot([
    ...["b", "c", "d", "e"].map((x, i) => ({
      from: x,
      to: ["a", "b", "c", "d"][i]!,
      kind: "ELABORATES",
    })),
    { from: "a", to: "e", kind: "ELABORATES" },
  ]);
  const before = JSON.stringify(s);
  const trees = storyTrees(s);
  assert.equal(trees.length, 1);
  assert.equal(trees[0]!.members.length, 4);
  assert.equal(trees[0]!.hidden.length, 1);
  assert.equal(JSON.stringify(s), before);
  const chain = storyTrees(snapshot(s.relations.slice(0, 4)))[0]!;
  assert.equal(chain.root, "a");
  assert.equal(chain.members.find((m) => m.id === "c")!.depth, 2);
  assert.equal(chain.members.find((m) => m.id === "d")!.depth, 3);
});
test("chronology and selected cross-links never become semantic tree parents; dense clusters stay visual", () => {
  const s = snapshot([
    { from: "a", to: "b", kind: "PRECEDES" },
    { from: "b", to: "c", kind: "RELATES_TO" },
    { from: "c", to: "d", kind: "CAUSES" },
  ]);
  assert.ok(storyTrees(s).every((t) => t.kind === "period"));
  assert.ok(storyTrees(s)[0]!.members.every((m) => m.parent === null));
  assert.deepEqual(selectedCrossLinks(s, null), []);
  assert.equal(selectedCrossLinks(s, "c").length, 2);
  s.nodes[1] = node("b", true);
  s.relations.push({ from: "b", to: "a", kind: "ELABORATES" });
  assert.ok(
    storyTrees(s).find((t) => t.members.some((m) => m.id === "b"))!.drifting,
  );
});
test("normal depth and tangent siblings preserve time anchor and viewport bounds", () => {
  const s = snapshot([
    { from: "b", to: "a", kind: "ELABORATES" },
    { from: "c", to: "a", kind: "ELABORATES" },
    { from: "d", to: "b", kind: "ELABORATES" },
  ]);
  const t = storyTrees(s).find((t) => t.root === "a")!;
  for (const width of [280, 360, 768, 1100]) {
    const path = {
      getTotalLength: () => 1000,
      getPointAtLength: (s: number) => ({
        x: width < 520 ? 36 : width / 2,
        y: s + 100,
      }),
    };
    const g = treeGeometry(t, path, s.nodes[0]!, 23900, 24100, width);
    assert.equal(g.s, 500);
    assert.equal(g.anchor.y, 600);
    assert.ok(g.points.every((p) => p.x >= 0 && p.x <= width));
    const b = g.points.find((p) => p.id === "b")!,
      c = g.points.find((p) => p.id === "c")!,
      d = g.points.find((p) => p.id === "d")!;
    assert.equal(b.x, c.x);
    assert.notEqual(b.y, c.y);
    assert.ok(Math.abs(d.x - g.anchor.x) > Math.abs(b.x - g.anchor.x));
    assert.equal(s.nodes[0]!.time.start, 24000);
  }
});

test("BranchMemo groups are visual-only and large trees expose bounded continuation", () => {
  const s = snapshot([]);
  s.storyGroups = [{ nodeIds: ["a", "b"] }];
  const group = storyTrees(s).find((t) => t.kind === "branch")!;
  assert.deepEqual(
    group.members.map((m) => m.id),
    ["a", "b"],
  );
  assert.ok(group.members.every((m) => m.parent === null));
  assert.equal(s.relations.length, 0);
  s.nodes = Array.from({ length: 30 }, (_, i) => node(String(i)));
  s.relations = s.nodes
    .slice(1)
    .map((n) => ({ from: n.id, to: "0", kind: "ELABORATES" }));
  const tree = storyTrees(s)[0]!;
  assert.equal(tree.members.length, 8);
  assert.equal(tree.hidden.length, 22);
});

test("recursive fans center siblings, retain parent-relative lengths and bend single chains", () => {
  const s = snapshot([
    { from: "b", to: "a", kind: "ELABORATES" },
    { from: "c", to: "a", kind: "ELABORATES" },
    { from: "d", to: "b", kind: "ELABORATES" },
  ]);
  const tree = storyTrees(s).find((t) => t.root === "a")!;
  const path = {
    getTotalLength: () => 1000,
    getPointAtLength: (s: number) => ({ x: 600, y: s + 200 }),
  };
  const layout = treeGeometry(tree, path, s.nodes[0]!, 23900, 24100, 1200);
  const [a, b, c, d] = ["a", "b", "c", "d"].map(
    (id) => layout.points.find((p) => p.id === id)!,
  );
  assert.ok(Math.abs((b!.y + c!.y) / 2 - a!.y) < 0.001);
  assert.ok(
    Math.abs(
      Math.hypot(b!.x - a!.x, b!.y - a!.y) -
        Math.hypot(c!.x - a!.x, c!.y - a!.y),
    ) < 0.001,
  );
  assert.ok(Math.hypot(d!.x - b!.x, d!.y - b!.y) < 150);
  assert.notDeepEqual(d!.direction, b!.direction);
  assert.deepEqual(
    layout,
    treeGeometry(tree, path, s.nodes[0]!, 23900, 24100, 1200),
  );
  const reverse = {
    ...s,
    nodes: [...s.nodes].reverse(),
    relations: [...s.relations].reverse(),
  };
  assert.deepEqual(storyTrees(s), storyTrees(reverse));
  assert.equal(layout.anchor.x, 600);
  assert.equal(layout.anchor.y, 700);
});
test("visual junction has no node identity and drifting geometry stays bounded", () => {
  for (const count of [0, 1, 2, 3, 30]) {
    const data = {
      ...snapshot([]),
      nodes: Array.from({ length: count }, (_, i) => node(String(i), true)),
    };
    const before = JSON.stringify(data);
    for (const tree of storyTrees(data)) {
      const layout = treeGeometry(
        tree,
        {
          getTotalLength: () => 500,
          getPointAtLength: (s) => ({ x: 500, y: s }),
        },
        data.nodes.find((n) => n.id === tree.root)!,
        0,
        0,
        1000,
      );
      if (tree.kind === "period") {
        assert.ok(layout.junction);
        assert.equal("id" in layout.junction!, false);
        assert.ok(tree.members.every((m) => m.parent === null));
      }
      assert.ok(layout.points.every((p) => p.x >= 0 && p.x <= 1000));
      if (count <= 3)
        assert.ok(
          Math.max(...layout.points.map((p) => p.y)) -
            Math.min(...layout.points.map((p) => p.y)) <
            300,
        );
    }
    assert.equal(JSON.stringify(data), before);
  }
});

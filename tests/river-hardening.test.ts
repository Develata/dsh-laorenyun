import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { riverScale } from "./fixtures/river-scale.ts";
import { storyTrees } from "../src/river/trees.ts";
import { decadeSelection } from "../src/river/navigation.ts";
import { pollRiver, retainProjection } from "../src/client/river-refresh.ts";
test("separate dated/drifting pages cannot starve temporal spine", () => {
  for (const [anchored, drifting] of [
    [700, 0],
    [20, 600],
    [100, 600],
    [600, 100],
  ]) {
    const f = riverScale(anchored, drifting);
    try {
      const s = f.storage.river({});
      assert.equal(
        s.nodes.filter((n) => n.placement === "anchored").length,
        Math.min(400, anchored!),
      );
      assert.equal(s.drifting.total, drifting);
      assert.equal(s.dated.total, anchored);
      assert.ok(s.nodes.length <= 500);
      assert.equal(
        f.storage.river({ drifting: true }).nodes.length,
        Math.min(100, drifting!),
      );
    } finally {
      f.db.close();
    }
  }
});
test("bounded scale projection filters edges before limit; membership and presentation refresh without graph bump", () => {
  const f = riverScale();
  try {
    const t = performance.now(),
      before = f.storage.river({}),
      queryMs = performance.now() - t;
    const p = performance.now(),
      trees = storyTrees(before),
      projectionMs = performance.now() - p;
    const d = performance.now(),
      detail = f.storage.detail(f.id(1)),
      detailMs = performance.now() - d;
    assert.equal(before.nodes.length, 500);
    assert.equal(before.drifting.total, 300);
    assert.ok(
      before.relations.some(
        (e) =>
          e.from === f.id(1) && e.to === f.id(0) && e.kind === "ELABORATES",
      ),
    );
    assert.ok(
      trees.some((t) =>
        t.members.some((m) => m.id === f.id(2) && m.depth === 2),
      ),
    );
    assert.ok(
      before.relations.length <= 2000 && before.storyGroups!.length <= 100,
    );
    assert.ok(detail.sources.length <= 10 && detail.related!.length <= 12);
    const bytes = Buffer.byteLength(JSON.stringify(before));
    assert.ok(bytes < 500_000);
    f.memo(999, [f.id(120), f.id(125)]);
    const after = f.storage.river({});
    assert.equal(after.graphRevision, before.graphRevision);
    assert.deepEqual(after.nodes, before.nodes);
    assert.notEqual(after.projectionRevision, before.projectionRevision);
    assert.equal(retainProjection(before, after), after);
    assert.equal(retainProjection(after, f.storage.river({})), after);
    f.db
      .prepare("UPDATE conflicts SET status='resolved' WHERE id='conflict-0'")
      .run();
    const conflict = f.storage.river({});
    assert.notEqual(conflict.projectionRevision, after.projectionRevision);
    f.db.prepare("DELETE FROM source_refs WHERE node_id=?").run(f.id(0));
    assert.notEqual(
      f.storage.river({}).projectionRevision,
      conflict.projectionRevision,
    );
    console.log(
      JSON.stringify({
        fixture: "rc6",
        nodes: 1000,
        anchored: 700,
        drifting: 300,
        edges: Number(
          f.db.prepare("SELECT count(*) n FROM memory_edges").get()!.n,
        ),
        branchMemos: 50,
        visible: before.nodes.length,
        visibleRelations: before.relations.length,
        queryMs,
        projectionMs,
        detailMs,
        bytes,
      }),
    );
  } finally {
    f.db.close();
  }
});
test("decade selection changes filtered queries before scrolling", () => {
  assert.deepEqual(decadeSelection("all", 1960), {
    range: "all",
    scroll: true,
  });
  assert.deepEqual(decadeSelection(String(1960 * 12), 1980), {
    range: String(1980 * 12),
    scroll: false,
  });
  assert.equal(decadeSelection(String(1980 * 12), 1950).scroll, false);
  assert.equal(decadeSelection("drifting", 1950).range, String(1950 * 12));
});
test("mounted preview refresh, visibility pause and dispose cancel", async () => {
  const f = riverScale(3, 0);
  let reads = 0,
    receives = 0,
    visible = true,
    last = f.storage.river({});
  const stop = pollRiver(
    async () => {
      reads++;
      return f.storage.river({});
    },
    (s) => {
      last = retainProjection(last, s);
      receives++;
    },
    () => assert.fail("unexpected read failure"),
    () => visible,
    10,
  );
  try {
    await sleep(30);
    const revision = last.projectionRevision;
    f.memo(1, [f.id(0), f.id(1)]);
    await sleep(30);
    assert.notEqual(last.projectionRevision, revision);
    assert.ok(receives > 1);
    visible = false;
    const paused = reads;
    await sleep(30);
    assert.equal(reads, paused);
    stop();
    visible = true;
    await sleep(30);
    assert.equal(reads, paused);
  } finally {
    stop();
    f.db.close();
  }
});

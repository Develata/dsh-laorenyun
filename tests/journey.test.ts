import { test } from "node:test";
import assert from "node:assert/strict";
import { journeyPath, intervalPath } from "../src/river/journey.ts";
import { arcPosition } from "../src/river/layout.ts";
test("journey scales with life length, has monotonic y and uses measured arc distance", () => {
  const g = journeyPath(900, 80 * 12);
  assert.ok(g.height > 2800 && g.height < 4000);
  const coordinates = g.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const ys = coordinates.filter((_, i) => i % 2 === 1);
  assert.ok(ys.every((v, i) => i === 0 || v > ys[i - 1]!));
  const path = {
    getTotalLength: () => 1200,
    getPointAtLength: (s: number) => ({ x: 5, y: s }),
  };
  const segment = intervalPath(path, 12, 24, 0, 120);
  assert.ok(segment.startsWith("M 5 120"));
  assert.ok(segment.endsWith("L 5 240"));
  assert.equal(arcPosition(0, 0, 0, 1200), 600);
  assert.equal(
    arcPosition(24, 0, 120, 1200) - arcPosition(12, 0, 120, 1200),
    120,
  );
});

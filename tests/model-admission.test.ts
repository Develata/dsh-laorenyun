import { test } from "node:test";
import assert from "node:assert/strict";
import { InternalModel } from "../src/memory/model.ts";
test("shared archive model admission bounds concurrency and removes cancelled waiters", async () => {
  let active = 0,
    peak = 0;
  const releases: Array<() => void> = [];
  const model = new InternalModel({
    async *stream() {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => releases.push(r));
      active--;
      yield { type: "text-delta" as const, text: "{}" };
    },
  } as never);
  const signal = new AbortController();
  const run = (s: AbortSignal) =>
    model.json(
      { provider: "fixture", model: "fixture" },
      "synthetic",
      {},
      JSON.parse,
      s,
    );
  const first = run(signal.signal),
    second = run(signal.signal);
  await new Promise((r) => setImmediate(r));
  const cancelled = new AbortController();
  const third = run(cancelled.signal);
  cancelled.abort();
  await assert.rejects(third, /admission deadline/);
  const fourth = run(signal.signal);
  releases.shift()!();
  await first;
  await new Promise((r) => setImmediate(r));
  releases.shift()!();
  releases.shift()!();
  await Promise.all([second, fourth]);
  assert.equal(peak, 2);
});

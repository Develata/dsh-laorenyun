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

test("format repair gets a fresh attempt window while outer deadline stays authoritative", async () => {
  const route = { provider: "fixture", model: "fixture" };
  const signals: AbortSignal[] = [];
  let calls = 0;
  const model = new InternalModel(
    {
      async *stream(input: any) {
        signals.push(input.signal);
        const n = ++calls;
        await new Promise((r) => setTimeout(r, 70));
        yield { type: "text-delta", text: n % 2 ? "invalid" : "{}" };
      },
    } as never,
    110,
  );
  const result = await model.json(
    route,
    "test",
    {},
    JSON.parse,
    AbortSignal.timeout(1000),
  );
  assert.equal(result.evidence.repairs, 1);
  assert.notEqual(signals[0], signals[1]);
  assert.deepEqual(
    result.evidence.attempts!.map((a) => a.outcome),
    ["format", "success"],
  );
  assert.ok(result.evidence.latencyMs >= 140);
  await assert.rejects(
    model.json(route, "test", {}, JSON.parse, AbortSignal.timeout(100)),
    (e: any) => {
      assert.equal(e.evidence.timeoutStage, "outer");
      assert.equal(e.evidence.attempts[1].outcome, "timeout");
      return true;
    },
  );
});

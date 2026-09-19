import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainDatabase } from "../src/storage/database.ts";
const input = (sessionId: string) => ({
  sessionId,
  messageId: randomUUID(),
  requestId: randomUUID(),
  role: "user" as const,
  sourceKind: "user" as const,
  text: "1976年春天，我离开学校以后进了合肥的一家工厂工作。",
});
test("one worker isolates archive sources and graphs; sessions in same archive share memory; reopen preserves both", async () => {
  const root = await mkdtemp(join(tmpdir(), "laorenyun-archives-"));
  let owner = await DomainDatabase.open(root);
  try {
    const a = await owner.scope(join(root, "a")),
      b = await owner.scope(join(root, "b"));
    const t = (await a.call("acceptHuman", input("one"))).transcript!;
    const source = await a.call("getSource", t.sourceId);
    assert.equal(source!.mediaId, null);
    assert.equal(source!.rawAsr, "");
    assert.equal(await b.call("getSource", t.sourceId), null);
    const work = (await a.call("memoryClaim", null))!;
    await a.call("memoryProposal", {
      id: work.operation.id,
      result: {
        proposals: [
          {
            keySentence: t.text,
            basis: "stated",
            time: {
              start: 1976 * 12,
              end: 1976 * 12 + 11,
              precision: "year",
              certainty: "stated",
              originalText: "1976年春天",
            },
            evidence: [{ transcriptId: t.id, text: t.text, field: "claim" }],
            people: [],
            places: [],
            edges: [],
          },
        ],
        comparisons: [],
        resolutions: [],
      },
    });
    await a.call("memoryApply", { id: work.operation.id, expected: 0 });
    await a.call("acceptHuman", input("two"));
    assert.equal((await a.call("river", {})).nodes.length, 1);
    assert.equal((await b.call("river", {})).nodes.length, 0);
    await owner.close();
    owner = await DomainDatabase.open(root);
    const reopened = await owner.scope(join(root, "a"));
    assert.equal((await reopened.call("river", {})).graphRevision, 1);
    assert.equal((await reopened.call("getSource", t.sourceId))!.mediaId, null);
    assert.equal(
      (await (await owner.scope(join(root, "b"))).call("river", {})).nodes
        .length,
      0,
    );
  } finally {
    await owner.close();
  }
});

test("speech and typed testimony converge on the same durable extraction input", async () => {
  const { Foundation } = await import("../src/application.ts");
  const { sourceMarker } = await import("../src/domain/source-reference.ts");
  const app = await Foundation.open(
    await mkdtemp(join(tmpdir(), "laorenyun-parity-")),
  );
  try {
    const text = "我那个时候去了合肥六中";
    const source = await app.fakeDraft("speech", {
      role: "self",
      authority: "explicit-user",
    });
    const speech = (
      await app.db.call("acceptHuman", {
        ...input("speech"),
        text: sourceMarker(source.id) + text,
      })
    ).transcript!;
    const typed = (
      await app.db.call("acceptHuman", { ...input("typed"), text })
    ).transcript!;
    assert.equal(speech.text, typed.text);
    assert.equal(speech.speaker.role, typed.speaker.role);
    assert.ok(speech.rawAsr.length > 0);
    assert.equal(typed.rawAsr, "");
    for (const t of [speech, typed]) {
      const operation = await app.db.call("memoryOperation", `extract:${t.id}`);
      assert.equal(operation?.state, "pending");
    }
    assert.equal(
      (await app.db.call("getSource", typed.sourceId))!.mediaId,
      null,
    );
    assert.ok((await app.db.call("getSource", speech.sourceId))!.mediaId);
    assert.deepEqual(await app.db.call("graphIntegrity", null), []);
  } finally {
    await app.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DomainDatabase } from "../src/storage/database.ts";
import { migrate } from "../src/storage/migrations.ts";
import { GraphStorage } from "../src/memory/storage.ts";
import { parseExtraction, validateProposal } from "../src/memory/validate.ts";
import { partialMemo, parseMemo } from "../src/memory/branch.ts";
import { schedule } from "../src/memory/scheduler.ts";
import type {
  ExtractionResult,
  Proposal,
  GraphNode,
} from "../src/memory/types.ts";
import type { TranscriptSegment } from "../src/domain/types.ts";
const temp = () => mkdtemp(join(tmpdir(), "laorenyun-phase3-"));
async function human(db: DomainDatabase, text: string, sessionId = "main") {
  return (
    await db.call("acceptHuman", {
      sessionId,
      text,
      role: "user",
      sourceKind: "user",
      messageId: randomUUID(),
      requestId: randomUUID(),
    })
  ).transcript!;
}
function proposal(
  t: TranscriptSegment,
  time: Proposal["time"] = {
    start: null,
    end: null,
    precision: "unknown",
    certainty: "stated",
    originalText: "",
  },
): Proposal {
  return {
    keySentence: t.text,
    basis: "stated",
    time,
    evidence: [{ transcriptId: t.id, text: t.text, field: "claim" }],
    people: [],
    places: [],
    edges: [],
  };
}
async function apply(
  db: DomainDatabase,
  p: Proposal,
  extra: Partial<ExtractionResult> = {},
) {
  const input = (await db.call("memoryClaim", null))!;
  const result = { proposals: [p], comparisons: [], resolutions: [], ...extra };
  await db.call("memoryProposal", { id: input.operation.id, result });
  return db.call("memoryApply", {
    id: input.operation.id,
    expected: input.operation.graphRevision,
  });
}
const time = (year: number): Proposal["time"] => ({
  start: year * 12,
  end: year * 12 + 11,
  precision: "year",
  certainty: "stated",
  originalText: year + "年",
});
test("Phase 2 schema fixture migrates transactionally, preserves testimony and rejects future", async () => {
  const root = await temp(),
    sql = await readFile(
      new URL("./fixtures/phase2-schema.sql", import.meta.url),
      "utf8",
    );
  const db = new DatabaseSync(join(root, "laorenyun.db"));
  db.exec(sql);
  db.prepare("INSERT INTO sources VALUES(?,?,?,?,?)").run(
    "s",
    "old",
    null,
    "submitted",
    JSON.stringify({ id: "s" }),
  );
  db.exec(
    "INSERT INTO transcripts VALUES('t','s','old','m','r','{\"text\":\"保留\"}')",
  );
  migrate(db);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 4);
  assert.equal(db.prepare("SELECT count(*) n FROM transcripts").get()!.n, 1);
  migrate(db);
  db.exec("PRAGMA user_version=99");
  assert.throws(() => migrate(db), /SCHEMA_FUTURE/);
  db.close();
});
test("evidence, inference, drifting, anchor revision, replay, restart and CAS", async () => {
  const root = await temp();
  let db = await DomainDatabase.open(root);
  try {
    const t = await human(db, "小时候有一次我掉进河里，具体哪一年我记不得了。");
    const p = proposal(t);
    assert.throws(
      () =>
        validateProposal(
          { ...p, keySentence: "不存在的事实" },
          new Map([[t.id, t]]),
        ),
      /UNSUPPORTED_STATED/,
    );
    assert.throws(
      () =>
        validateProposal(
          {
            ...p,
            evidence: [
              { transcriptId: t.id, text: "伪造引文", field: "claim" },
            ],
          },
          new Map([[t.id, t]]),
        ),
      /UNSUPPORTED_EVIDENCE/,
    );
    const negative = { ...t, text: "我没有去合肥一中。" };
    assert.throws(
      () =>
        validateProposal(
          { ...proposal(negative), keySentence: "去合肥一中" },
          new Map([[t.id, negative]]),
        ),
      /UNSUPPORTED_STATED/,
    );
    const first = await apply(db, p),
      id = first.nodeIds[0]!;
    assert.equal((await db.call("getMemory", id))!.placement, "drifting");
    assert.equal(
      (await db.call("memoryApply", { id: "extract:" + t.id, expected: 0 }))
        .graphRevision,
      first.graphRevision,
    );
    const anchor = await human(db, "那次掉进河里是在1968年。");
    const q = { ...proposal(anchor, time(1968)), targetId: id };
    await apply(db, q, {
      comparisons: [
        {
          proposal: 0,
          nodeId: id,
          revision: 1,
          verdict: "duplicate",
          explanation: "明确补充同一掉河经历的时间",
        },
      ],
    });
    assert.equal((await db.call("getMemory", id))!.revision, 2);
    assert.equal(
      (await db.call("timeline", { method: "get_node", id, revision: 1 })).items
        .length,
      1,
    );
    const rel = await human(db, "高中毕业以后过了两年，我才参加工作。");
    const inferred = {
      ...proposal(rel),
      basis: "inferred" as const,
      time: { ...proposal(rel).time, certainty: "inferred" as const },
    };
    await apply(db, inferred);
    assert.equal(
      (
        (await db.call("timeline", { method: "get_unresolved" }))
          .items[0] as GraphNode
      ).status,
      "candidate",
    );
    const pending = await human(db, "1978年，我在合肥读书。");
    const claimed = (await db.call("memoryClaim", null))!;
    assert.equal(claimed.transcript.id, pending.id);
    await db.close();
    db = await DomainDatabase.open(root);
    await db.call("memoryRecover", null);
    const recovered = (await db.call("memoryClaim", null))!;
    assert.equal(recovered.operation.id, claimed.operation.id);
    await db.call("memoryProposal", {
      id: recovered.operation.id,
      result: {
        proposals: [proposal(pending, time(1978))],
        comparisons: [],
        resolutions: [],
      },
    });
    await assert.rejects(
      db.call("memoryApply", { id: recovered.operation.id, expected: 0 }),
      /REVISION_CONFLICT/,
    );
    await db.close();
    db = await DomainDatabase.open(root);
    const replay = (await db.call("memoryClaim", null))!;
    assert.equal(
      replay.operation.graphRevision,
      recovered.operation.graphRevision,
    );
    assert.equal(replay.operation.attempts, recovered.operation.attempts);
    await db.call("memoryApply", {
      id: replay.operation.id,
      expected: replay.operation.graphRevision,
    });
    assert.deepEqual(await db.call("graphIntegrity", null), []);
  } finally {
    await db.close();
  }
});
test("material historical conflict and explicit clarification preserve both revisions", async () => {
  const db = await DomainDatabase.open(await temp());
  try {
    const a = await human(db, "1977年，我进入合肥一中。"),
      p = proposal(a, time(1977));
    p.places = [{ name: "合肥一中", identity: "explicit" }];
    const left = (await apply(db, p)).nodeIds[0]!;
    const b = await human(db, "1977年，我进入合肥六中。"),
      q = proposal(b, time(1977));
    q.places = [{ name: "合肥六中", identity: "explicit" }];
    const right = (
      await apply(db, q, {
        comparisons: [
          {
            proposal: 0,
            nodeId: left,
            revision: 1,
            verdict: "material_conflict",
            explanation: "同年同一入学事件的学校不一致",
          },
        ],
      })
    ).nodeIds[0]!;
    const c = (await db.call("timeline", { method: "get_conflicts" }))
      .items[0] as { id: string };
    assert.ok(c.id);
    const clarification = await human(db, "确认是合肥六中，我刚才记错了。");
    const op = (await db.call("memoryClaim", null))!;
    await db.call("memoryProposal", {
      id: op.operation.id,
      result: {
        proposals: [{ ...proposal(clarification), targetId: right }],
        comparisons: [
          {
            proposal: 0,
            nodeId: left,
            revision: 1,
            verdict: "material_conflict",
            explanation: "模型重复引用已提供的冲突另一端",
          },
        ],
        resolutions: [
          {
            conflictId: c.id,
            selectedNodeId: right,
            evidence: {
              transcriptId: clarification.id,
              text: clarification.text,
              field: "claim",
            },
          },
        ],
      },
    });
    await db.call("memoryApply", {
      id: op.operation.id,
      expected: op.operation.graphRevision,
    });
    assert.equal(
      (await db.call("timeline", { method: "get_conflicts" })).items.length,
      0,
    );
    assert.equal((await db.call("getMemory", left))!.revision, 2);
    assert.equal(
      ((await db.call("getMemory", left)) as GraphNode).status,
      "superseded",
    );
    assert.equal(
      ((await db.call("getMemory", right)) as GraphNode).status,
      "confirmed",
    );
    assert.equal(
      (await db.call("timeline", { method: "get_node", id: left, revision: 1 }))
        .items.length,
      1,
    );
    assert.equal((await db.call("listTranscripts", "main")).length, 3);
    assert.deepEqual(await db.call("graphIntegrity", null), []);
  } finally {
    await db.close();
  }
});
test("conservative entity identity, edge cycle/causality/symmetry, bounded pages", async () => {
  const root = await temp(),
    db = await DomainDatabase.open(root);
  const ids: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const t = await human(db, `王老师教过我第${i}课。`),
        p = proposal(t);
      p.people = [{ name: "王老师", identity: "ambiguous" }];
      ids.push((await apply(db, p)).nodeIds[0]!);
    }
    const first = await db.call("timeline", { method: "search", limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.truncated, true);
    assert.equal(
      (
        await db.call("timeline", {
          method: "search",
          limit: 2,
          cursor: first.cursor,
        })
      ).items.length,
      1,
    );
    const a = (await db.call("getMemory", ids[0]!)) as GraphNode,
      b = (await db.call("getMemory", ids[1]!)) as GraphNode;
    assert.notEqual(a.people[0], b.people[0]);
    await db.close();
    const raw = new DatabaseSync(join(root, "laorenyun.db"));
    raw.exec("PRAGMA foreign_keys=ON");
    const graph = new GraphStorage(raw);
    assert.throws(
      () => graph.edge(ids[0]!, ids[0]!, "PRECEDES", [], new Map()),
      /INVALID_EDGE/,
    );
    graph.edge(ids[0]!, ids[1]!, "PRECEDES", [], new Map());
    graph.edge(ids[1]!, ids[2]!, "PRECEDES", [], new Map());
    assert.throws(
      () => graph.edge(ids[2]!, ids[0]!, "PRECEDES", [], new Map()),
      /PRECEDES_CYCLE/,
    );
    assert.throws(
      () => graph.edge(ids[0]!, ids[2]!, "CAUSES", [], new Map()),
      /UNSUPPORTED_CAUSE/,
    );
    graph.edge(ids[0]!, ids[2]!, "RELATES_TO", [], new Map());
    graph.edge(ids[2]!, ids[0]!, "RELATES_TO", [], new Map());
    assert.equal(
      raw
        .prepare("SELECT count(*) n FROM memory_edges WHERE kind='RELATES_TO'")
        .get()!.n,
      1,
    );
    graph.write({ ...a, revision: 2, placement: "anchored", time: time(2000) });
    assert.throws(
      () =>
        graph.write({
          ...b,
          revision: 2,
          placement: "anchored",
          time: time(1990),
        }),
      /INVALID_EDGE/,
    );
    assert.equal(graph.node(b.id)!.revision, 1);
    assert.deepEqual(graph.integrity(), []);
    raw.close();
  } finally {
    await db.close();
  }
});
test("real branch states: proposal != consent, five human answers enter closing; partial memo cold recovery", async () => {
  const root = await temp();
  let db = await DomainDatabase.open(root);
  try {
    const source = await human(db, "王老师对我后来的一生影响很大。");
    let b = await db.call("branchProposal", {
      parentSessionId: "main",
      topic: "王老师",
      returnAnchor: "1977年上学",
      transcriptId: source.id,
    });
    assert.equal(b.state, "proposed");
    await assert.rejects(
      db.call("branchConsent", {
        parentSessionId: "main",
        transcriptId: source.id,
      }),
      /CONSENT_REQUIRED/,
    );
    const consent = await human(db, "好的，我愿意讲讲。");
    b = await db.call("branchConsent", {
      parentSessionId: "main",
      transcriptId: consent.id,
    });
    assert.equal(b.state, "provisioning");
    await db.call("activateBranch", b.sessionId);
    for (let i = 0; i < 3; i++) await human(db, "回答" + i, b.sessionId);
    await db.close();
    db = await DomainDatabase.open(root);
    for (let i = 3; i < 5; i++) await human(db, "回答" + i, b.sessionId);
    b = (await db.call("getBranch", b.sessionId))!;
    assert.equal(b.state, "closing");
    assert.equal(b.answerCount, 5);
    const blocked = await db.call("acceptHuman", {
      sessionId: b.sessionId,
      messageId: randomUUID(),
      requestId: randomUUID(),
      sourceKind: "user",
      role: "user",
      text: "不应接纳第六答",
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.transcript, null);
    const answers = await db.call("listTranscripts", b.sessionId),
      input = {
        topic: b.topic!,
        sourceTurns: answers.map((t) => t.id),
        relatedNodes: [],
        inputRevision: 5,
      };
    assert.throws(() => parseMemo("{}", input), /INVALID_MEMO/);
    await db.call("branchMemo", {
      sessionId: b.sessionId,
      memo: partialMemo(input),
    });
    assert.equal(
      (await db.call("getBranch", b.sessionId))!.memo!.status,
      "partial",
    );
  } finally {
    await db.close();
  }
});
test("coverage softmax is seeded, sparse-aware, bounded and subordinate to refusal/topic boundary", () => {
  const regions = [5, 0, 1, 8].map((n, i) => ({
    id: String(i),
    start: (1950 + i * 10) * 12,
    end: (1960 + i * 10) * 12 - 1,
    n,
    unresolved: 0,
    gap: n ? 0 : 60,
  }));
  const input = {
    graphRevision: 5,
    regions,
    currentMonth: 1960 * 12,
    deferred: [],
    seed: 123,
    boundary: true,
    userChoseTopic: false,
  };
  const a = schedule(input);
  assert.deepEqual(a, schedule(input));
  assert.ok(a.candidates[1]!.probability > a.candidates[0]!.probability);
  assert.equal(
    schedule({ ...input, deferred: ["1"] }).candidates.some(
      (c) => c.id === "1",
    ),
    false,
  );
  assert.equal(schedule({ ...input, boundary: false }).selected, null);
  assert.equal(schedule({ ...input, userChoseTopic: true }).selected, null);
  assert.ok(
    schedule({ ...input, regions: [{ ...regions[0]!, unresolved: 999 }] })
      .candidates[0]!.U <= 1,
  );
});
test("proposal strict schema rejects extra fields and malformed evidence", () => {
  assert.throws(
    () =>
      parseExtraction(
        '{"proposals":[],"comparisons":[],"resolutions":[],"sql":"DROP"}',
      ),
    /INVALID_PROPOSAL/,
  );
});

test("ASR correction is one testimony; compatible granularity cannot create conflict even if classifier says so", async () => {
  const db = await DomainDatabase.open(await temp());
  try {
    const t = await human(db, "1978年，我在合肥读书。"),
      left = (await apply(db, proposal(t, time(1978)))).nodeIds[0]!;
    const u = await human(db, "1978年9月，我在合肥读书。");
    const q = proposal(u, {
      start: 1978 * 12 + 8,
      end: 1978 * 12 + 8,
      precision: "month",
      certainty: "stated",
      originalText: "1978年9月",
    });
    await apply(db, q, {
      comparisons: [
        {
          proposal: 0,
          nodeId: left,
          revision: 1,
          verdict: "material_conflict",
          explanation: "模型误判日期颗粒度",
        },
      ],
    });
    assert.equal(
      (await db.call("timeline", { method: "get_conflicts" })).items.length,
      0,
    );
  } finally {
    await db.close();
  }
});
test("obvious explicit entity may reuse bounded identity; same spelling alone does not prove identity", async () => {
  const raw = new DatabaseSync(":memory:");
  migrate(raw);
  const graph = new GraphStorage(raw);
  const first = graph.entity(
    "places",
    { name: "合肥", identity: "explicit" },
    new Set(),
  );
  assert.equal(
    graph.entity(
      "places",
      { name: "合肥", identity: "explicit", reuseId: first },
      new Set([first]),
    ),
    first,
  );
  assert.notEqual(
    graph.entity("places", { name: "合肥", identity: "explicit" }, new Set()),
    first,
  );
  assert.throws(
    () =>
      graph.entity(
        "places",
        { name: "合肥", identity: "ambiguous", reuseId: first },
        new Set([first]),
      ),
    /IDENTITY_UNCERTAIN/,
  );
  raw.close();
});
test("refusal is captured at testimony acceptance and suppresses exploration without a tool reminder", async () => {
  const db = await DomainDatabase.open(await temp());
  try {
    const a = await human(db, "1950年，我出生在合肥。");
    await apply(db, proposal(a, time(1950)));
    const t = await human(db, "这个先跳过，我不想谈。");
    const result = await db.call("schedule", {
      sessionId: "main",
      boundary: true,
      userChoseTopic: false,
      currentMonth: 1950 * 12,
      transcriptId: t.id,
    });
    assert.equal(result.selected, null);
    assert.equal(result.candidates.length, 0);
  } finally {
    await db.close();
  }
});
test("structured model permits one repair, rejects oversized output, and obeys external cancellation", async () => {
  const { InternalModel } = await import("../src/memory/model.ts");
  let calls = 0;
  const model = new InternalModel({
    stream: async function* () {
      calls++;
      yield {
        type: "text-delta" as const,
        index: 0,
        text:
          calls === 1
            ? "not json"
            : '{"proposals":[],"comparisons":[],"resolutions":[]}',
      };
    },
  });
  const result = await model.json(
    { provider: "fixture", model: "fixture" },
    "test",
    {},
    parseExtraction,
    AbortSignal.timeout(500),
  );
  assert.equal(result.evidence.repairs, 1);
  assert.equal(calls, 2);
  const oversized = new InternalModel({
    stream: async function* () {
      yield { type: "text-delta" as const, index: 0, text: "x".repeat(48001) };
    },
  });
  await assert.rejects(
    oversized.json(
      { provider: "fixture", model: "fixture" },
      "test",
      {},
      parseExtraction,
      AbortSignal.timeout(500),
    ),
    /MODEL_SIZE/,
  );
  const never = new InternalModel({
    stream: async function* () {
      await new Promise((r) => setTimeout(r, 100));
      yield { type: "text-delta" as const, index: 0, text: "{}" };
    },
  });
  await assert.rejects(
    never.json(
      { provider: "fixture", model: "fixture" },
      "test",
      {},
      parseExtraction,
      AbortSignal.timeout(5),
    ),
    /MODEL_TIMEOUT/,
  );
});

test("native retention compacts only older balanced turn range through the published service", async () => {
  const { installRetention } = await import("../src/memory/retention.ts");
  let listener: Function | undefined;
  let bounds: unknown[] = [];
  const context = {
    on: (_name: string, fn: Function) => {
      listener = fn;
    },
    get: () => ({
      compactRegion: async (...args: unknown[]) => {
        bounds = args.slice(0, 2);
      },
    }),
  };
  installRetention(context as unknown as import("@deepseek-ai/cordis").Context);
  const events = [
    { type: "system/message", data: {} },
    ...Array.from({ length: 10 }, () => [
      {
        type: "user/message",
        data: { source: { kind: "user", rpcId: "human" } },
      },
      { type: "assistant/message", data: {} },
    ]).flat(),
  ];
  const agent = {
    session: {
      surface: { nodes: events.map((_, i) => i) },
      eventAt: (i: number) => events[i],
    },
  };
  let next = 0;
  await listener!(
    {
      agent,
      messages: [{ source: { kind: "user", rpcId: "new" } }],
      signal: AbortSignal.timeout(500),
    },
    async () => {
      next++;
      return { kind: "enter" };
    },
  );
  assert.deepEqual(bounds, [1, 4]);
  assert.equal(next, 1);
  assert.equal(events.length, 21);
});

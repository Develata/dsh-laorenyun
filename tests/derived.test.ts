import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainDatabase } from "../src/storage/database.ts";
import { sourceMarker } from "../src/domain/source-reference.ts";
import type { TranscriptSegment } from "../src/domain/types.ts";
import type { Proposal } from "../src/memory/types.ts";
import { arcPosition, anchors } from "../src/river/layout.ts";
import {
  parsePersona,
  parsePlan,
  parseSection,
  eligible,
} from "../src/derived/validate.ts";
import {
  nodeRef,
  type Biography,
  type Generation,
  type Persona,
} from "../src/derived/types.ts";
import {
  exportDocuments,
  publishExport,
  readExport,
} from "../src/derived/export.ts";
import { DerivedService } from "../src/derived/service.ts";
import type { InternalModel } from "../src/memory/model.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "laorenyun-phase4-"));
  const db = await DomainDatabase.open(root);
  return { root, db };
}
async function human(db: DomainDatabase, text: string) {
  return (
    await db.call("acceptHuman", {
      sessionId: "main",
      messageId: randomUUID(),
      requestId: randomUUID(),
      role: "user",
      sourceKind: "user",
      text,
    })
  ).transcript!;
}
async function extract(
  db: DomainDatabase,
  t: TranscriptSegment,
  year: number | null,
  targetId?: string,
) {
  const input = (await db.call("memoryClaim", null))!;
  assert.equal(input.transcript.id, t.id);
  const p: Proposal = {
    keySentence: t.text,
    basis: "stated",
    time: {
      start: year === null ? null : year * 12,
      end: year === null ? null : year * 12 + 11,
      precision: year === null ? "unknown" : "year",
      certainty: "stated",
      originalText: year === null ? "" : year + "年",
    },
    evidence: [{ transcriptId: t.id, text: t.text, field: "claim" }],
    people: [],
    places: [],
    edges: [],
    ...(targetId ? { targetId } : {}),
  };
  await db.call("memoryProposal", {
    id: input.operation.id,
    result: { proposals: [p], comparisons: [], resolutions: [] },
  });
  return db.call("memoryApply", {
    id: input.operation.id,
    expected: input.operation.graphRevision,
  });
}
const route = { provider: "synthetic", model: "fixture" };
const begin = (
  db: DomainDatabase,
  kind: "persona" | "biography" | "export",
  extra = {},
) =>
  db.call("derivedBegin", {
    id: randomUUID(),
    sessionId: "main",
    kind,
    route,
    ...extra,
  });
async function publish(db: DomainDatabase, g: Generation) {
  await db.call("derivedClaim", null);
  g.state = "published";
  return db.call("derivedUpdate", g);
}
test("river arc semantics: actual-length units, same date, collision lanes, uncertainty and drifting", () => {
  assert.equal(arcPosition(20, 0, 100, 600), 120);
  assert.equal(arcPosition(40, 0, 100, 600), 240);
  assert.equal(arcPosition(3, 3, 3, 600), 300);
  const make = (
    id: string,
    precision: "month" | "year" | "decade" | "approximate" | "unknown",
    start: number | null,
    end: number | null,
  ) =>
    ({
      id,
      revision: 1,
      keySentence: "记忆",
      time: { start, end, precision, certainty: "stated", originalText: "" },
      placement: start === null ? "drifting" : "anchored",
      status: "confirmed",
    }) as Parameters<typeof anchors>[0][number];
  const nodes = [
    make("a", "month", 10, 10),
    make("b", "month", 10, 10),
    make("c", "year", 0, 11),
    make("d", "decade", 0, 119),
    make("e", "approximate", 0, 20),
    make("f", "unknown", null, null),
  ];
  const layout = anchors(nodes);
  assert.equal(layout.length, 5);
  assert.equal(
    layout.find((x) => x.node.id === "a")!.month,
    layout.find((x) => x.node.id === "b")!.month,
  );
  assert.notEqual(
    layout.find((x) => x.node.id === "a")!.lane,
    layout.find((x) => x.node.id === "b")!.lane,
  );
  for (const id of ["c", "d", "e"])
    assert.equal(layout.find((x) => x.node.id === id)!.interval, true);
});
test("selected correction uses native source, cancelled draft no graph change, same node new revision with resolution audit", async () => {
  const { db } = await fixture();
  try {
    const t = await human(db, "1977年，我进入合肥一中。"),
      a = await extract(db, t, 1977);
    const id = a.nodeIds[0]!;
    const s = await db.call("correctionCreate", {
      sessionId: "main",
      nodeId: id,
      revision: 1,
      text: "1977年，我进入合肥六中。",
    });
    await db.call("cancelSource", s.id);
    assert.equal((await db.call("getMemory", id))!.revision, 1);
    const corrected = await db.call("correctionCreate", {
      sessionId: "main",
      nodeId: id,
      revision: 1,
      text: "1977年，我进入合肥六中。",
    });
    const next = await human(db, sourceMarker(corrected.id) + corrected.draft);
    assert.equal(next.rawAsr, "");
    await extract(db, next, 1977, id);
    const n = (await db.call("getMemory", id))!;
    assert.equal(n.revision, 2);
    assert.equal(n.keySentence, next.text);
    const detail = await db.call("memoryDetail", { id, revision: 1 });
    assert.equal(detail.node.keySentence, t.text);
    const snapshot = await begin(db, "biography");
    assert.equal(snapshot.manifest.conflicts[0]!.status, "resolved");
    await db.call("derivedCancel", snapshot.id);
    assert.deepEqual(await db.call("graphIntegrity", null), []);
    await assert.rejects(
      db.call("correctionCreate", {
        sessionId: "main",
        nodeId: id,
        revision: 1,
        text: "更正",
      }),
      /REVISION_CONFLICT/,
    );
    assert.equal(await db.call("getDraft", "main"), null);
  } finally {
    await db.close();
  }
});
test("immutable persona, self only, quote validation, unknowns and no psychological claims", async () => {
  const { db } = await fixture();
  try {
    const t = await human(db, "那时候啊，我常在家门口坐着。");
    await db.call("setSessionSpeaker", {
      sessionId: "main",
      speaker: { role: "child", authority: "explicit-user" },
    });
    await human(db, "父亲不这样说话。");
    const g = await begin(db, "persona");
    assert.equal(g.manifest.transcripts.length, 1);
    assert.equal(g.manifest.transcripts[0]!.id, t.id);
    const data = {
      observations: [
        {
          category: "lexical",
          observation: "使用那时候啊引出讲述",
          examples: [{ transcriptId: t.id, quote: "那时候啊" }],
        },
      ],
      unknown: ["rhythm", "ordering", "address", "emotion"],
    };
    const p = parsePersona(JSON.stringify(data), g.manifest, g.id, g.inputHash);
    assert.equal(p.observations.length, 1);
    assert.throws(
      () =>
        parsePersona(
          JSON.stringify({
            ...data,
            observations: [
              { ...data.observations[0], observation: "性格内向" },
            ],
          }),
          g.manifest,
          g.id,
          g.inputHash,
        ),
      /scope/,
    );
    assert.throws(
      () =>
        parsePersona(
          JSON.stringify({
            ...data,
            observations: [
              {
                ...data.observations[0],
                examples: [{ transcriptId: t.id, quote: "从不说过" }],
              },
            ],
          }),
          g.manifest,
          g.id,
          g.inputHash,
        ),
      /quote/,
    );
    g.result = p;
    await publish(db, g);
    const v2 = await begin(db, "persona");
    assert.notEqual(v2.id, g.id);
    await db.call("derivedCancel", v2.id);
    assert.equal((await db.call("derivedActive", "persona"))!.id, g.id);
    assert.deepEqual((await db.call("derivedGet", g.id)).result, p);
  } finally {
    await db.close();
  }
});
test("fixed biography manifest, WHAT/HOW, uncertainty, family attribution, planner invalid IDs and open conflict omission", async () => {
  const { db } = await fixture();
  try {
    const self = await human(db, "那时候啊，1978年我在合肥读书。");
    await extract(db, self, 1978);
    await db.call("setSessionSpeaker", {
      sessionId: "main",
      speaker: { role: "child", authority: "explicit-user" },
    });
    const family = await human(db, "父亲小时候帮家里做饭。");
    await extract(db, family, null);
    const g = await begin(db, "biography"),
      m = g.manifest,
      refs = eligible(m).map(nodeRef);
    const plan = parsePlan(
      JSON.stringify({ chapters: [{ title: "留下的故事", nodeRefs: refs }] }),
      m,
    );
    const raw = JSON.stringify({
      paragraphs: m.nodes.map((n) => ({
        nodeRef: nodeRef(n),
        text: n.keySentence,
        lead: "",
      })),
    });
    const section = parseSection(raw, m, plan[0]!);
    assert.match(section.text, /据家人或亲友回忆/);
    assert.match(section.text, /1978年/);
    assert.throws(
      () =>
        parsePlan('{"chapters":[{"title":"test","nodeRefs":["invented"]}]}', m),
      /reference/,
    );
    assert.throws(
      () => parseSection(raw.replace("1978年", "1978年9月"), m, plan[0]!),
      /preserve/,
    );
    const persona: Persona = {
      id: randomUUID(),
      inputHash: "test",
      transcriptIds: [self.id],
      observations: [
        {
          category: "lexical",
          observation: "时间转场",
          examples: [{ transcriptId: self.id, quote: "那时候啊" }],
        },
      ],
      unknown: ["rhythm", "ordering", "address", "emotion"],
    };
    const styled = parseSection(
      JSON.stringify({
        paragraphs: m.nodes.map((n) => ({
          nodeRef: nodeRef(n),
          text: n.keySentence,
          lead: "那时候啊，",
        })),
      }),
      { ...m, persona },
      plan[0]!,
    );
    assert.deepEqual(styled.nodeRefs, section.nodeRefs);
    assert.deepEqual(styled.sourceRefs, section.sourceRefs);
    assert.equal(
      styled.text.replaceAll("那时候啊，", ""),
      section.text.replaceAll("那时候啊，", ""),
    );
    const conflicted = {
      ...m,
      conflicts: [
        {
          id: "c",
          left: { id: m.nodes[0]!.id, revision: 1 },
          right: { id: m.nodes[1]!.id, revision: 1 },
          status: "open" as const,
          explanation: "合成",
        },
      ],
    };
    assert.equal(eligible(conflicted).length, 0);
  } finally {
    await db.close();
  }
});
test("export staging, offline escaped HTML, stable JSON, provenance paths, restart and last-good publication", async () => {
  const { db, root } = await fixture();
  try {
    const t = await human(db, "我记得家门口写着 <script>alert(1)</script>。");
    await extract(db, t, null);
    const g = await begin(db, "biography"),
      m = g.manifest;
    const chapters = parsePlan(
      JSON.stringify({
        chapters: [{ title: "家门口", nodeRefs: m.nodes.map(nodeRef) }],
      }),
      m,
    );
    const section = parseSection(
      JSON.stringify({
        paragraphs: m.nodes.map((n) => ({
          nodeRef: nodeRef(n),
          text: n.keySentence,
          lead: "",
        })),
      }),
      m,
      chapters[0]!,
    );
    g.result = {
      id: g.id,
      chapters,
      sections: [section],
      omittedConflicts: [],
      personaId: null,
    } satisfies Biography;
    await publish(db, g);
    const exp = await begin(db, "export", { biographyId: g.id }),
      docs = exportDocuments(exp);
    assert.equal(docs["index.html"].includes("<script>"), false);
    assert.match(docs["index.html"], /&lt;script&gt;/);
    assert.equal(
      /https?:\/\/|<script src=|@import/.test(docs["index.html"]),
      false,
    );
    assert.deepEqual(exportDocuments(exp), docs);
    const json = JSON.parse(docs["memories.json"]);
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.transcriptRevisions[0].id, t.id);
    assert.equal(json.includedMedia, false);
    assert.equal(json.biographyManifest.generation.model, route.model);
    exp.result = await publishExport(root, exp, AbortSignal.timeout(10000));
    await publish(db, exp);
    assert.equal(
      Buffer.from(await readExport(root, exp, "index.html")).toString(),
      docs["index.html"],
    );
    await assert.rejects(readExport(root, exp, "../secret"), /NOT_FOUND/);
    const failed = await begin(db, "biography");
    await db.call("derivedClaim", null);
    await db.call("derivedRecover", null);
    assert.equal((await db.call("derivedGet", failed.id)).state, "failed");
    assert.equal((await db.call("derivedActive", "biography"))!.id, g.id);
    assert.equal((await db.call("derivedActive", "export"))!.id, exp.id);
  } finally {
    await db.close();
  }
});
test("bounded derived service uses existing model contract, stores sections, no automatic generation", async () => {
  const { db, root } = await fixture();
  let calls = 0;
  try {
    const t = await human(db, "1978年，我在合肥读书。");
    await extract(db, t, 1978);
    const model = {
      json: async (
        _route: unknown,
        _prompt: string,
        input: Record<string, any>,
        parse: (s: string) => unknown,
      ) => {
        calls++;
        const raw = input.chapter
          ? {
              paragraphs: input.nodes.map((n: any) => ({
                nodeRef: n.ref,
                text: n.keySentence,
                lead: "",
              })),
            }
          : {
              chapters: [
                { title: "读书", nodeRefs: input.nodes.map((n: any) => n.ref) },
              ],
            };
        return {
          value: parse(JSON.stringify(raw)),
          evidence: { model: "fixture", latencyMs: 1, repairs: 0 },
        };
      },
    } as unknown as InternalModel;
    const service = new DerivedService(db, model, root);
    await service.start();
    assert.equal(calls, 0);
    const g = await begin(db, "biography");
    service.tick();
    const deadline = Date.now() + 5000;
    while (
      (await db.call("derivedGet", g.id)).state !== "published" &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 10));
    const done = await db.call("derivedGet", g.id);
    assert.equal(done.state, "published");
    assert.equal(done.candidates.length, 1);
    assert.equal(calls, 2);
    await service.close();
  } finally {
    await db.close();
  }
});

test("river bounded 500, aggregate periods, paged access, revision refresh and re-anchor keep ID", async () => {
  const { db } = await fixture();
  try {
    const t = await human(db, "合成规模验收。");
    let first = "";
    for (let i = 0; i < 501; i++) {
      const id = randomUUID();
      if (!i) first = id;
      await db.call("putMemory", {
        expectedRevision: 0,
        node: {
          id: id as import("../src/domain/types.ts").NodeId,
          revision: 1,
          keySentence: t.text,
          time: {
            start: i === 0 ? null : 24000 + i,
            end: i === 0 ? null : 24000 + i,
            precision: i === 0 ? "unknown" : "month",
            certainty: "stated",
          },
          placement: i === 0 ? "drifting" : "anchored",
          transcriptId: t.id,
          basis: "stated",
        },
      });
    }
    const one = await db.call("river", {});
    assert.equal(one.nodes.length, 500);
    assert.equal(one.total, 501);
    assert.equal(one.truncated, true);
    assert.ok(one.periods.length > 1);
    const two = await db.call("river", { offset: 500 });
    assert.equal(two.nodes.length, 1);
    assert.equal(
      new Set([...one.nodes, ...two.nodes].map((n) => n.id)).size,
      501,
    );
    const n = (await db.call("getMemory", first))!;
    await db.call("putMemory", {
      expectedRevision: 1,
      node: {
        ...n,
        revision: 2,
        time: {
          start: 23900,
          end: 23900,
          precision: "month",
          certainty: "stated",
        },
        placement: "anchored",
      },
    });
    const snapshot = await db.call("river", {});
    assert.ok(snapshot.graphRevision > one.graphRevision);
    assert.equal(
      snapshot.nodes.find((n) => n.id === first)!.placement,
      "anchored",
    );
    await assert.rejects(begin(db, "biography"), /GENERATION_LIMIT/);
  } finally {
    await db.close();
  }
});

test("insufficient style is unknown; chapter title cannot add unsupported facts; no invented forgetting", async () => {
  const { db } = await fixture();
  try {
    const t = await human(db, "在门口，我坐着。");
    await extract(db, t, null);
    const g = await begin(db, "persona");
    const p = parsePersona(
      JSON.stringify({
        observations: [
          {
            category: "emotion",
            observation: "缺乏足够情感表达证据",
            examples: [{ transcriptId: t.id, quote: "我坐着" }],
          },
        ],
        unknown: ["lexical", "rhythm", "ordering", "address"],
      }),
      g.manifest,
      g.id,
      g.inputHash,
    );
    assert.equal(p.observations.length, 0);
    assert.ok(p.unknown.includes("emotion"));
    await db.call("derivedCancel", g.id);
    const b = await begin(db, "biography");
    const refs = b.manifest.nodes.map(nodeRef);
    assert.throws(
      () =>
        parsePlan(
          JSON.stringify({
            chapters: [{ title: "1980年大学毕业", nodeRefs: refs }],
          }),
          b.manifest,
        ),
      /title/,
    );
    const chapter = parsePlan(
      JSON.stringify({
        chapters: [{ title: "时间待确认的故事", nodeRefs: refs }],
      }),
      b.manifest,
    )[0]!;
    const section = parseSection(
      JSON.stringify({
        paragraphs: [{ nodeRef: refs[0], text: t.text, lead: "" }],
      }),
      b.manifest,
      chapter,
    );
    assert.equal(section.text.includes("我还记不清"), false);
    assert.match(section.text, /没有明确年份/);
  } finally {
    await db.close();
  }
});

test("river flags BOTH sides of an open Conflict without rewriting node status", async () => {
  const { db } = await fixture();
  try {
    const first = await human(db, "1977年，我进入合肥一中。");
    const left = (await extract(db, first, 1977)).nodeIds[0]!;
    const t = await human(db, "1977年，我进入合肥六中。");
    const input = (await db.call("memoryClaim", null))!;
    await db.call("memoryProposal", {
      id: input.operation.id,
      result: {
        proposals: [
          {
            keySentence: t.text,
            basis: "stated",
            time: {
              start: 1977 * 12,
              end: 1977 * 12 + 11,
              precision: "year",
              certainty: "stated",
              originalText: "1977年",
            },
            evidence: [{ transcriptId: t.id, text: t.text, field: "claim" }],
            people: [],
            places: [],
            edges: [],
          },
        ],
        comparisons: [
          {
            proposal: 0,
            nodeId: left,
            revision: 1,
            verdict: "material_conflict",
            explanation: "同一入学事件不同学校",
          },
        ],
        resolutions: [],
      },
    });
    await db.call("memoryApply", {
      id: input.operation.id,
      expected: input.operation.graphRevision,
    });
    const river = await db.call("river", {});
    assert.equal(river.nodes.filter((n) => n.hasOpenConflict).length, 2);
    assert.equal((await db.call("getMemory", left))!.revision, 1);
  } finally {
    await db.close();
  }
});

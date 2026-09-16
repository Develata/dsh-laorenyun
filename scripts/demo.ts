/** Explicit offline fixture CLI. Never imported by the Host/Client plugin. */
import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainDatabase } from "../src/storage/database.ts";
import { sourceMarker } from "../src/domain/source-reference.ts";
import { DerivedService } from "../src/derived/service.ts";
import { InternalModel } from "../src/memory/model.ts";
import { FileRecordingStore } from "../src/storage/recordings.ts";
import {
  type SourceId,
  type BranchId,
  operation,
} from "../src/domain/types.ts";
import { exportDocuments } from "../src/derived/export.ts";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] || ".");
if (
  process.env.LAORENYUN_DEMO !== "true" ||
  !process.argv.includes("--confirm-synthetic-demo")
)
  throw Error(
    "Explicit LAORENYUN_DEMO=true and --confirm-synthetic-demo required; use an EMPTY isolated volume",
  );
try {
  await access(join(root, "laorenyun.db"));
  throw Error("Refusing existing database; demo never merges into an archive");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const scale = process.argv.includes("--scale"),
  timings: Record<string, number> = {};
async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round((performance.now() - t) * 100) / 100;
  }
}
const db = await measure("databaseStartupMs", () => DomainDatabase.open(root));
const main = "synthetic-demo";
let first = "",
  latestTranscript = "",
  nodes = 0,
  revisions = 0,
  sources = 0;
async function human(
  text: string,
  role: "self" | "child" = "self",
  sourceId?: SourceId,
  sessionId = main,
) {
  await db.call("setSessionSpeaker", {
    sessionId,
    speaker: { role, authority: "explicit-user" },
  });
  const t = (
    await db.call("acceptHuman", {
      sessionId,
      role: "user",
      sourceKind: "user",
      messageId: randomUUID(),
      requestId: randomUUID(),
      text: (sourceId ? sourceMarker(sourceId) : "") + text,
    })
  ).transcript!;
  if (sessionId === main) latestTranscript = t.id;
  sources++;
  return t;
}
async function extract(
  t: Awaited<ReturnType<typeof human>>,
  year: number | null,
  targetId?: string,
  comparisons: any[] = [],
  edges: any[] = [],
) {
  const i = (await db.call("memoryClaim", null))!;
  assert.equal(i.transcript.id, t.id);
  await db.call("memoryProposal", {
    id: i.operation.id,
    result: {
      proposals: [
        {
          keySentence: t.text,
          basis: "stated",
          time: {
            start: year === null ? null : year * 12,
            end: year === null ? null : year * 12 + 11,
            precision: year === null ? "unknown" : "year",
            certainty: "stated",
            originalText: year === null ? "" : `${year}年`,
          },
          evidence: [{ transcriptId: t.id, text: t.text, field: "claim" }],
          people: [],
          places: [],
          edges,
          ...(targetId ? { targetId } : {}),
        },
      ],
      comparisons,
      resolutions: [],
    },
  });
  const n = (
    await db.call("memoryApply", {
      id: i.operation.id,
      expected: i.operation.graphRevision,
    })
  ).nodeIds[0]!;
  revisions++;
  if (!targetId) nodes++;
  return n;
}
const model = new InternalModel({
  async *stream(request: any) {
    const input = JSON.parse(request.messages[0].content[0].text);
    let value: any;
    if (input.transcripts) {
      const t = input.transcripts.find((t: any) => t.text.includes("那时候啊"));
      value = {
        observations: t
          ? [
              {
                category: "lexical",
                observation: "在这些合成讲述中使用那时候啊作为转场",
                examples: [{ transcriptId: t.id, quote: "那时候啊" }],
              },
            ]
          : [],
        unknown: t
          ? ["rhythm", "ordering", "address", "emotion"]
          : ["lexical", "rhythm", "ordering", "address", "emotion"],
      };
    } else if (input.chapter)
      value = {
        paragraphs: input.nodes.map((n: any) => ({
          nodeRef: n.ref,
          text: n.keySentence,
          lead: "",
        })),
      };
    else {
      value = { chapters: [] };
      for (let n = 0; n < input.nodes.length; n += 20)
        value.chapters.push({
          title: "留下的故事",
          nodeRefs: input.nodes.slice(n, n + 20).map((x: any) => x.ref),
        });
    }
    yield { type: "text-delta", text: JSON.stringify(value) };
  },
} as any);
const derived = new DerivedService(db, model, root);
async function generate(kind: "persona" | "biography" | "export", extra = {}) {
  const g = await db.call("derivedBegin", {
    id: randomUUID(),
    kind,
    sessionId: main,
    route: { provider: "explicit-demo-fixture", model: "synthetic-offline-v1" },
    ...extra,
  });
  derived.tick();
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const v = await db.call("derivedGet", g.id);
    if (v.state === "published") return v;
    if (v.state === "failed") throw Error(v.error);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("demo generation timeout");
}
try {
  await derived.start();
  const store = new FileRecordingStore(root, db);
  await store.initialize(operation());
  const wav = Buffer.alloc(32044);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(32000, 40);
  const media = await store.write(wav, "audio/wav", true, operation(), {
    durationMs: 1000,
  });
  const text = "那时候啊，1952年，我在村里出生。";
  const source = await db.call("createSource", {
    id: randomUUID() as any,
    sessionId: main,
    mediaId: media.id,
    rawAsr: text,
    draft: text,
    draftRevision: 0,
    speaker: { role: "self", authority: "explicit-user" },
    status: "draft",
    createdAt: Date.now(),
  });
  first = await extract(await human(text, "self", source.id), 1952);
  const left = await extract(await human("1977年，我进入合肥一中。"), 1977);
  await extract(await human("1977年，我进入合肥六中。"), 1977, undefined, [
    {
      proposal: 0,
      nodeId: left,
      revision: 1,
      verdict: "material_conflict",
      explanation: "合成案例的同一入学事件",
    },
  ]);
  const target = await extract(
    await human("那时候啊，1982年，我在村里工作。"),
    1982,
  );
  const correction = await db.call("correctionCreate", {
    sessionId: main,
    nodeId: target,
    revision: 1,
    text: "那时候啊，1983年，我在村里工作。",
  });
  await extract(
    await human(correction.draft, "self", correction.id),
    1983,
    target,
  );
  await extract(
    await human("小时候有一次我掉进河里，具体哪一年记不得了。"),
    null,
  );
  await extract(await human("父亲在1962年帮家里干活。", "child"), 1962);
  const related = await human("那时候啊，1992年，我在家门口种花。");
  await extract(
    related,
    1992,
    undefined,
    [],
    [
      {
        to: target,
        kind: "RELATES_TO",
        evidence: [
          { transcriptId: related.id, text: related.text, field: "claim" },
        ],
      },
    ],
  );
  const child = "synthetic-branch",
    bid = randomUUID() as BranchId;
  await db.call("reserveBranch", {
    id: bid,
    parentSessionId: main,
    sessionId: child,
    state: "provisioning",
    answerCount: 0,
    memo: null,
    topic: "老师的故事（合成演示）",
    returnAnchor: "求学",
  });
  await db.call("activateBranch", child);
  const bt = await human(
    "王老师常说，先把字写端正。",
    "self",
    undefined,
    child,
  );
  await extract(bt, null);
  await db.call("branchClosing", child);
  await db.call("branchMemo", {
    sessionId: child,
    memo: {
      title: "老师的故事（合成演示）",
      key_sentence: bt.text,
      summary: bt.text,
      source_turns: [bt.id],
      related_memory_nodes: [],
      new_memory_candidates: [],
      people: [],
      places: [],
      time: null,
      unresolved_questions: [],
      suggested_return_bridge: "我们接着聊求学的经历。",
      status: "complete",
      input_revision: 1,
    },
  });
  await db.call("branchReturned", child);
  const persona = await measure("personaManifestAndFixtureMs", () =>
    generate("persona"),
  );
  const biography = await measure("biographyManifestAndFixtureMs", () =>
    generate("biography", { personaId: persona.id }),
  );
  const exported = await measure("exportPublishMs", () =>
    generate("export", { biographyId: biography.id }),
  );
  const docs = await measure("exportRenderMs", async () =>
    exportDocuments(exported),
  );
  if (scale) {
    await measure("scaleSeedMs", async () => {
      while (nodes < 500) {
        const y = 1950 + (nodes % 70);
        await extract(
          await human(`${y}年，我记录了第${nodes}次合成生活片段。`),
          y,
        );
      }
      const all = (await db.call("river", {})).nodes;
      for (let k = 0; k < 550; k++) {
        const chosen = all[k % all.length]!.id;
        const n = (await db.call("getMemory", chosen))!;
        const text = `1952年，我补充第${k}条合成出生讲述。`;
        const s = await db.call("correctionCreate", {
          sessionId: main,
          nodeId: chosen,
          revision: n.revision,
          text,
        });
        await extract(await human(text, "self", s.id), 1952, chosen);
      }
    });
  }
  const river = await measure("riverInitialMs", () => db.call("river", {}));
  assert.equal(river.nodes.length, Math.min(nodes, 500));
  await measure("riverPeriodMs", () =>
    db.call("river", { start: 1970 * 12, end: 1980 * 12 - 1 }),
  );
  await measure("riverPageMs", () => db.call("river", { offset: 450 }));
  await measure("sourceDeepReadMs", () =>
    db.call("memoryDetail", { id: target }),
  );
  await measure("timelineSearchMs", () =>
    db.call("timeline", { method: "search", text: "村里", limit: 50 }),
  );
  await measure("schedulerMs", () =>
    db.call("schedule", {
      sessionId: main,
      boundary: true,
      userChoseTopic: false,
      currentMonth: 1980 * 12,
      transcriptId: latestTranscript,
    }),
  );
  const p = await measure("personaManifestMs", () =>
    db.call("derivedBegin", {
      id: randomUUID(),
      kind: "persona",
      sessionId: main,
      route: {
        provider: "explicit-demo-fixture",
        model: "synthetic-offline-v1",
      },
    }),
  );
  await db.call("derivedCancel", p.id);
  if (scale)
    await measure("largeBiographyRejectMs", () =>
      assert.rejects(
        db.call("derivedBegin", {
          id: randomUUID(),
          kind: "biography",
          sessionId: main,
          route: {
            provider: "explicit-demo-fixture",
            model: "synthetic-offline-v1",
          },
        }),
        /GENERATION_LIMIT/,
      ),
    );
  assert.deepEqual(await db.call("graphIntegrity", null), []);
  const evidence = {
    synthetic: true,
    scale,
    nodes,
    revisions,
    sources,
    graphRevision: river.graphRevision,
    timings,
    peakRssKiB: process.resourceUsage().maxRSS,
    exportBytes: Object.fromEntries(
      Object.entries(docs).map(([k, v]) => [k, Buffer.byteLength(v)]),
    ),
    exportGeneration: exported.id,
  };
  await writeFile(
    join(root, "DEMO.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(evidence));
} finally {
  await derived.close();
  await db.close();
}

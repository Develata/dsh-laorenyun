/** Synthetic RC2 corpus. Seed via the same accepted-testimony/proposal operations as tests. */
import { randomUUID } from "node:crypto";
import type { DomainDatabase } from "../../src/storage/database.ts";
import { sourceMarker } from "../../src/domain/source-reference.ts";
import type { SourceId, TranscriptSegment } from "../../src/domain/types.ts";
import type { Proposal } from "../../src/memory/types.ts";
import type { Persona } from "../../src/derived/types.ts";
export async function seedSparse(db: DomainDatabase) {
  const sessionId = "synthetic-rc2";
  async function human(
    text: string,
    role: "self" | "child" = "self",
    sourceId?: SourceId,
  ) {
    await db.call("setSessionSpeaker", {
      sessionId,
      speaker: { role, authority: "explicit-user" },
    });
    return (
      await db.call("acceptHuman", {
        sessionId,
        messageId: randomUUID(),
        requestId: randomUUID(),
        role: "user",
        sourceKind: "user",
        text: (sourceId ? sourceMarker(sourceId) : "") + text,
      })
    ).transcript!;
  }
  async function apply(
    t: TranscriptSegment,
    year: number | null,
    extra: { targetId?: string; comparison?: string; inferred?: boolean } = {},
  ) {
    const input = (await db.call("memoryClaim", null))!;
    if (input.transcript.id !== t.id) throw Error("fixture operation mismatch");
    const p: Proposal = {
      keySentence: t.text,
      basis: extra.inferred ? "inferred" : "stated",
      time: {
        start: year === null ? null : year * 12,
        end: year === null ? null : year * 12 + 11,
        precision: year === null ? "unknown" : "year",
        certainty: extra.inferred ? "inferred" : "stated",
        originalText: year === null ? "" : `${year}年`,
      },
      evidence: [{ transcriptId: t.id, text: t.text, field: "claim" }],
      people: [],
      places: [],
      edges: [],
      ...(extra.targetId ? { targetId: extra.targetId } : {}),
    };
    await db.call("memoryProposal", {
      id: input.operation.id,
      result: {
        proposals: [p],
        comparisons: extra.comparison
          ? [
              {
                proposal: 0,
                nodeId: extra.comparison,
                revision: 1,
                verdict: "material_conflict",
                explanation: "合成同一入学事件",
              },
            ]
          : [],
        resolutions: [],
      },
    });
    return (
      await db.call("memoryApply", {
        id: input.operation.id,
        expected: input.operation.graphRevision,
      })
    ).nodeIds[0]!;
  }
  const examples = [
    ["我1952年出生在安徽一个村子。", 1952],
    ["小时候我常到村边的河里摸小鱼。", null],
    ["那时候啊，家里有四个孩子，我排行第二。", null],
    ["那时候啊，邻居们彼此熟悉，吃过饭就在门口聊天。", null],
    ["家里过去用煤油灯照明。", null, "child"],
    ["1962年父亲帮家里干活。", 1962, "child"],
  ] as const;
  const ids: string[] = [];
  for (const [text, year, role] of examples)
    ids.push(await apply(await human(text, role), year));
  const left = await apply(await human("1977年我进入合肥一中。"), 1977);
  await apply(await human("1977年我进入合肥六中。"), 1977, {
    comparison: left,
  });
  const old = await apply(await human("1982年我在村里开了修理铺。"), 1982);
  const correction = await db.call("correctionCreate", {
    sessionId,
    nodeId: old,
    revision: 1,
    text: "1983年我在村里开了修理铺。",
  });
  await apply(await human(correction.draft, "self", correction.id), 1983, {
    targetId: old,
  });
  await apply(await human("学会修自行车，大概是在开修理铺以前。"), null, {
    inferred: true,
  });
  const persona = await db.call("derivedBegin", {
    id: randomUUID(),
    sessionId,
    kind: "persona",
    route: { provider: "synthetic-seed", model: "explicit-fixture" },
  });
  await db.call("derivedClaim", null);
  const ts = persona.manifest.transcripts.filter((t) =>
    t.text.includes("那时候啊"),
  );
  persona.result = {
    id: persona.id,
    inputHash: persona.inputHash,
    transcriptIds: persona.manifest.transcripts.map((t) => t.id),
    observations: [
      {
        category: "lexical",
        observation: "用那时候啊作话题转场",
        examples: ts.map((t) => ({ transcriptId: t.id, quote: "那时候啊" })),
      },
    ],
    unknown: ["rhythm", "ordering", "address", "emotion"],
  } satisfies Persona;
  persona.state = "published";
  await db.call("derivedUpdate", persona);
  if ((await db.call("graphIntegrity", null)).length)
    throw Error("fixture integrity");
  return { sessionId, personaId: persona.id, ids };
}

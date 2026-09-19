import { test } from "node:test";
import assert from "node:assert/strict";
import {
  factManifest,
  parseNarrativePlan,
  parseWriting,
  parseReview,
  reviewPassed,
  publishChapter,
  styleSlot,
  type FactAtom,
} from "../src/derived/narrative.ts";
import type { Manifest, Persona } from "../src/derived/types.ts";
const facts: FactAtom[] = [
  {
    id: "F001",
    claim: "我小时候在河边玩。",
    nodeRef: "one@1",
    certainty: "stated",
    time: null,
    sourceRefs: ["t1"],
    testimony: [{ text: "我小时候在河边玩。", speaker: "self" }],
  },
  {
    id: "F002",
    claim: "邻居的孩子也在。",
    nodeRef: "two@1",
    certainty: "stated",
    time: null,
    sourceRefs: ["t2"],
    testimony: [{ text: "邻居的孩子也在。", speaker: "self" }],
  },
];
test("narrative supports natural titles, multiple facts per paragraph and unknown dates without metadata", () => {
  const plan = parseNarrativePlan(
    JSON.stringify({
      chapters: [
        {
          title: "河边的童年",
          paragraphs: [{ brief: "孩子一起玩", factRefs: ["F001", "F002"] }],
        },
      ],
      omissions: [],
    }),
    facts,
  );
  const ps = parseWriting(
    JSON.stringify({
      paragraphs: [
        {
          text: "小时候，我常在河边玩，邻居家的孩子也在那里。",
          factRefs: ["F001", "F002"],
        },
      ],
    }),
    plan[0]!,
  );
  const s = publishChapter(plan[0]!, ps, facts);
  assert.equal(s.paragraphs!.length, 1);
  assert.equal(s.nodeRefs.length, 2);
  assert.deepEqual(s.sourceRefs, ["t1", "t2"]);
  assert.doesNotMatch(s.text, /年份|待确认|F001|one@/);
});
test("references alone never pass independent review; unsupported facts and partial coverage reject", () => {
  const r = parseReview(
    JSON.stringify({
      complete: true,
      claims: [{ claim: "天气晴朗", supportedBy: [], status: "unsupported" }],
      problems: [],
    }),
    ["F001"],
  );
  assert.equal(reviewPassed(r), false);
  assert.equal(
    reviewPassed(
      parseReview('{"complete":false,"claims":[],"problems":[]}', []),
    ),
    false,
  );
  assert.throws(() =>
    parseReview(
      '{"complete":true,"claims":[{"claim":"工作","supportedBy":["invented"],"status":"supported"}],"problems":[]}',
      [],
    ),
  );
});
test("planner cannot lose testimony, invent IDs, or consolidate separate events", () => {
  assert.throws(() =>
    parseNarrativePlan('{"chapters":[],"omissions":[]}', facts),
  );
  assert.throws(() =>
    parseNarrativePlan(
      JSON.stringify({
        chapters: [
          {
            title: "童年",
            paragraphs: [{ brief: "玩耍", factRefs: ["F001"] }],
          },
        ],
        omissions: [{ factRef: "F002", duplicateOf: "F001" }],
      }),
      facts,
    ),
  );
});
test("WHAT manifest is independent of Persona HOW and requires verifiable source evidence", () => {
  const m = {
    nodes: [
      {
        id: "n",
        revision: 1,
        keySentence: "我小时候在河边玩。",
        status: "confirmed",
        basis: "stated",
        placement: "drifting",
        time: {
          start: null,
          end: null,
          precision: "unknown",
          certainty: "stated",
          originalText: "",
        },
        evidence: [
          { transcriptId: "t", text: "我小时候在河边玩。", field: "claim" },
        ],
      },
    ],
    transcripts: [
      { id: "t", text: "我小时候在河边玩。", speaker: { role: "self" } },
    ],
    conflicts: [],
    persona: null,
  } as unknown as Manifest;
  const before = factManifest(m);
  const persona = {
    observations: [{ category: "rhythm", observation: "短句", examples: [] }],
  } as unknown as Persona;
  m.persona = persona;
  assert.deepEqual(factManifest(m), before);
  assert.equal(styleSlot(persona).length, 1);
  assert.equal(before[0]!.time, null);
  m.transcripts.push({
    id: "clarify",
    text: "说的是小时候，不是工作以后。",
    speaker: { role: "self" },
  } as never);
  m.conflicts.push({
    id: "c",
    status: "resolved",
    left: { id: "n", revision: 1 },
    right: { id: "old", revision: 1 },
    explanation: "时间",
    resolution: {
      transcriptId: "clarify",
      text: "说的是小时候，不是工作以后。",
      selectedNodeId: "n",
      at: 1,
    },
  });
  assert.deepEqual(factManifest(m)[0]!.clarifications, [
    { transcriptId: "clarify", text: "说的是小时候，不是工作以后。" },
  ]);
  assert.ok(factManifest(m)[0]!.sourceRefs.includes("clarify"));
  m.transcripts[0]!.text = "另一句话";
  assert.throws(() => factManifest(m));
});

test("non-self testimony needs natural attribution even when model review says supported", async () => {
  const { attributionProblems } = await import("../src/derived/narrative.ts");
  const facts = [
    {
      id: "F001",
      testimony: [{ speaker: "child", text: "1962年父亲帮家里干活。" }],
    },
  ] as import("../src/derived/narrative.ts").FactAtom[];
  assert.equal(
    attributionProblems(
      [{ text: "1962年，父亲帮家里干活。", factRefs: ["F001"] }],
      facts,
    ).length,
    1,
  );
  assert.deepEqual(
    attributionProblems(
      [{ text: "家人后来提起，1962年我曾帮家里干活。", factRefs: ["F001"] }],
      facts,
    ),
    [],
  );
  assert.equal(
    attributionProblems(
      [{ text: "我记得家里人不少。", factRefs: ["F001"] }],
      facts,
    ).length,
    1,
  );
});

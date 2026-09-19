import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainDatabase } from "../src/storage/database.ts";
import { seedSparse } from "./fixtures/sparse-biography.ts";
import {
  factManifest,
  parseNarrativePlan,
  parseParagraph,
  parseReview as parseSentenceReview,
  sentenceUnits,
  reviewPassed,
  paragraphProblems,
  publishChapter,
  styleSlot,
  omissionAllowed,
  type FactAtom,
} from "../src/derived/narrative.ts";
// Adapt the historical adversarial corpus to the new wire contract. Impossible
// old spans deliberately become unknown IDs, never approximate text matches.
function parseReview(raw: string, allowed: string[], prose: string) {
  const legacy = JSON.parse(raw);
  const wire = {
    ...legacy,
    claims: legacy.claims.map(({ span, ...c }: any) => ({
      ...c,
      sentenceId:
        sentenceUnits(prose).find((s) => s.text.includes(span))?.id ??
        "INVALID",
    })),
  };
  parseSentenceReview(JSON.stringify(wire), allowed, prose);
  // These RC2 persisted-review regression cases keep their historical span
  // representation. New wire/guard/repair tests below exercise sentence IDs.
  return legacy as import("../src/derived/narrative.ts").ClaimReview;
}

const f = (id: string, claim: string): FactAtom => ({
  id,
  claim,
  nodeRef: id + "@1",
  certainty: "stated",
  time: null,
  sourceRefs: [id],
  testimony: [{ speaker: "self", text: claim }],
  sourceMode: "self",
  narrativePolicy: "required",
  attribution: { required: false, speakerRoles: [] },
  temporalPolicy: {
    explicitCalendarAllowed: false,
    uncertaintyMustRemain: false,
  },
  conflictPolicy: "none",
  conflictIds: [],
});
const facts = [
  f("F001", "小时候我在河边玩。"),
  f("F002", "小时候邻居的孩子也在那里。"),
];
const planJSON = (ids: string[]) => ({
  chapters: [
    {
      title: "河边的童年",
      titleMode: "thematic",
      titleFactRefs: [ids[0]],
      paragraphs: [{ brief: "合并童年玩耍", factRefs: ids }],
    },
  ],
  omissions: [],
});
test("natural multi-fact paragraph with no unknown-time metadata and complete atomic coverage", () => {
  const plan = parseNarrativePlan(
    JSON.stringify(planJSON(["F001", "F002"])),
    facts,
  );
  const p = parseParagraph(
    JSON.stringify({
      text: "说起小时候，我在河边玩，邻居的孩子也在那里。",
      factRefs: ["F001", "F002"],
      attributions: [],
    }),
    plan.chapters[0]!.paragraphs[0]!,
  );
  const r = parseReview(
    JSON.stringify({
      complete: true,
      claims: [
        {
          span: "说起小时候",
          claim: "",
          kind: "narrative_glue",
          status: "nonfactual",
          supportedBy: [],
        },
        {
          span: "我在河边玩",
          claim: "童年玩耍",
          kind: "factual",
          status: "compatible_paraphrase",
          supportedBy: ["F001"],
        },
        {
          span: "邻居的孩子也在那里",
          claim: "伙伴",
          kind: "factual",
          status: "supported",
          supportedBy: ["F002"],
        },
      ],
      problems: [],
    }),
    p.factRefs,
    p.text,
  );
  assert.ok(reviewPassed(r));
  assert.deepEqual(paragraphProblems(p, facts, r), []);
  const s = publishChapter(plan.chapters[0]!, [p], facts);
  assert.equal(s.nodeRefs.length, 2);
  assert.doesNotMatch(s.text, /年份不详|待确认/);
  r.claims.pop();
  assert.ok(paragraphProblems(p, facts, r).includes("FACT_COVERAGE_MISSING"));
});
test("atomic schema rejects cross-paragraph refs, fabricated spans, factual nonfactual labels", () => {
  const base = {
    complete: true,
    claims: [
      {
        span: "河边",
        claim: "河边",
        kind: "factual",
        status: "supported",
        supportedBy: ["F002"],
      },
    ],
    problems: [],
  };
  assert.throws(() => parseReview(JSON.stringify(base), ["F001"], "河边"));
  base.claims[0]!.supportedBy = ["F001"];
  assert.throws(() => parseReview(JSON.stringify(base), ["F001"], "工厂"));
  base.claims[0]!.status = "nonfactual";
  assert.throws(() => parseReview(JSON.stringify(base), ["F001"], "河边"));
});
test("deterministic calendar/age and attribution guards defeat even a permissive model review", () => {
  for (const text of [
    "1976年我在河边玩。",
    "三月我在河边玩。",
    "我十岁时在河边玩。",
    "年份不详，我在河边玩。",
  ]) {
    assert.ok(
      paragraphProblems({ text, factRefs: ["F001"] }, [facts[0]!]).length,
    );
  }
  const family = {
    ...f("F003", "家里用煤油灯。"),
    sourceMode: "nonself" as const,
    narrativePolicy: "requires_attribution" as const,
    attribution: { required: true, speakerRoles: ["child"] },
  };
  assert.ok(
    paragraphProblems({ text: "我记得家里用煤油灯。", factRefs: [family.id] }, [
      family,
    ]).includes("MISSING_ATTRIBUTION"),
  );
  const p = {
    text: "家人提起，家里用煤油灯。",
    factRefs: [family.id],
    attributions: [{ factRef: family.id, surface: "家人提起" }],
  };
  assert.deepEqual(paragraphProblems(p, [family]), []);
  p.attributions[0]!.surface = "子女说";
  assert.ok(paragraphProblems(p, [family]).length);
});
test("unsupported atomic person/motivation/weather/causality/identity claims are not publishable", () => {
  for (const [kind, span] of [
    ["identity", "李老师教我"],
    ["mental_state", "我想改变命运"],
    ["factual", "那天下雨"],
    ["causal", "因此去了工厂"],
    ["attribution", "我亲历家人的记忆"],
  ]) {
    const r = parseReview(
      JSON.stringify({
        complete: true,
        claims: [
          { kind, span, claim: span, status: "unsupported", supportedBy: [] },
        ],
        problems: [],
      }),
      ["F001"],
      span!,
    );
    assert.equal(reviewPassed(r), false);
    assert.ok(
      paragraphProblems({ text: span!, factRefs: ["F001"] }, [facts[0]!], r)
        .length,
    );
  }
});
test("omissions cannot drop required unknown-date facts, disguise distinct events or use arbitrary reasons", () => {
  assert.throws(() =>
    parseNarrativePlan(JSON.stringify(planJSON(["F001"])), facts),
  );
  assert.equal(
    omissionAllowed(
      { factRef: "F002", reason: "duplicate", duplicateOf: "F001" },
      facts,
      new Set(["F001"]),
    ),
    false,
  );
  assert.equal(
    omissionAllowed(
      { factRef: "F001", reason: "insufficient_context" },
      facts,
      new Set(),
    ),
    false,
  );
  const optional = {
    ...f("F003", "父亲帮家里干活。"),
    narrativePolicy: "optional_ambiguous" as const,
  };
  assert.ok(
    omissionAllowed(
      { factRef: optional.id, reason: "ambiguous_attribution" },
      [optional],
      new Set(),
    ),
  );
  const raw = {
    ...planJSON(["F001", "F002"]),
    omissions: [{ factRef: optional.id, reason: "ambiguous_attribution" }],
  };
  assert.equal(
    parseNarrativePlan(JSON.stringify(raw), [...facts, optional]).omissions
      .length,
    1,
  );
});
test("sparse fixture A-I preserves graph revisions, corrected current fact and policy independent of Persona", async () => {
  const db = await DomainDatabase.open(await mkdtemp(join(tmpdir(), "rc2-")));
  try {
    const seed = await seedSparse(db);
    const g = await db.call("derivedBegin", {
      id: randomUUID(),
      kind: "biography",
      sessionId: seed.sessionId,
      route: { provider: "fixture", model: "fixture" },
      personaId: seed.personaId,
      narrativeVersion: 2,
    });
    const m = g.manifest;
    const fs = factManifest(m);
    assert.equal(fs.filter((f) => f.conflictPolicy === "open").length, 2);
    assert.ok(fs.some((f) => f.narrativePolicy === "requires_attribution"));
    assert.ok(fs.some((f) => f.narrativePolicy === "optional_ambiguous"));
    assert.ok(fs.some((f) => f.certainty === "inferred"));
    assert.ok(
      fs.some((f) => f.time === null && f.narrativePolicy === "required"),
    );
    assert.ok(
      fs.some(
        (f) => f.claim.includes("1983年") && f.conflictPolicy === "resolved",
      ),
    );
    assert.ok(!fs.some((f) => f.claim.includes("1982年")));
    assert.ok(m.revisions.some((n) => n.keySentence.includes("1982年")));
    assert.ok(styleSlot(m.persona).length);
    m.persona = null;
    assert.deepEqual(factManifest(m), fs);
    const copy = structuredClone(m);
    copy.transcripts[0]!.text = "证据被替换";
    assert.throws(() => factManifest(copy));
  } finally {
    await db.close();
  }
});

test("paragraph repair isolates failures; malformed title review falls back without discarding verified prose", async () => {
  const { generateNarrative } = await import("../src/derived/narrative-run.ts");
  const db = await DomainDatabase.open(
    await mkdtemp(join(tmpdir(), "rc2-isolation-")),
  );
  try {
    const seed = await seedSparse(db);
    const g = await db.call("derivedBegin", {
      id: randomUUID(),
      kind: "biography",
      sessionId: seed.sessionId,
      route: { provider: "fixture", model: "fixture" },
      narrativeVersion: 2,
    });
    const fs = factManifest(g.manifest);
    const required = fs.filter(
      (f) =>
        f.narrativePolicy !== "excluded" &&
        f.narrativePolicy !== "optional_ambiguous",
    );
    const optional = fs.find(
      (f) => f.narrativePolicy === "optional_ambiguous",
    )!;
    const writes: Record<string, number> = {};
    const model = {
      async json(
        _r: unknown,
        _p: string,
        input: any,
        parse: (r: string) => unknown,
      ) {
        let out: any;
        if (input.brief) {
          const ids = input.brief.factRefs;
          if (input.repair) {
            assert.equal(input.title, undefined);
            assert.equal(input.style, undefined);
          }
          const inputFacts = input.allowedFacts ?? input.facts;
          for (const id of ids) writes[id] = (writes[id] ?? 0) + 1;
          out = {
            text: inputFacts
              .map((f: FactAtom) =>
                f.attribution.required ? "家人说，" + f.claim : f.claim,
              )
              .join(""),
            factRefs: ids,
            attributions: inputFacts
              .filter((f: FactAtom) => f.attribution.required)
              .map((f: FactAtom) => ({ factRef: f.id, surface: "家人说" })),
          };
          if (input.repair)
            out = {
              edits: [
                {
                  target: input.repair.targets[0].id,
                  replacement: input.repair.editableSpans[0],
                },
              ],
              append: "",
              attributions: out.attributions,
            };
        } else if (input.originalTitle) {
          out = { title: "家里的日子" };
        } else if (input.task) {
          if (input.task.startsWith("title:"))
            throw new SyntaxError(
              "synthetic malformed title review after format repair",
            );
          out = {
            complete: true,
            claims: input.facts.map((f: FactAtom) => ({
              sentenceId: input.sentences.find((s: any) =>
                s.text.includes(f.claim),
              )?.id,
              claim: f.claim,
              kind: "factual",
              status: f.id === optional.id ? "unsupported" : "supported",
              supportedBy: f.id === optional.id ? [] : [f.id],
            })),
            problems: [],
          };
        } else {
          out = {
            chapters: [
              {
                title: "家里的日子",
                titleMode: "thematic",
                titleFactRefs: [required[0]!.id],
                paragraphs: [
                  { brief: "合并", factRefs: required.map((f) => f.id) },
                ],
              },
              {
                title: "家人讲述",
                titleMode: "thematic",
                titleFactRefs: [optional.id],
                paragraphs: [{ brief: "身份未明", factRefs: [optional.id] }],
              },
            ],
            omissions: fs
              .filter((f) => f.narrativePolicy === "excluded")
              .map((f) => ({ factRef: f.id, reason: "open_conflict" })),
          };
        }
        return {
          value: parse(JSON.stringify(out)),
          evidence: { model: "fixture", latencyMs: 1, repairs: 0 },
        };
      },
    } as unknown as import("../src/memory/model.ts").InternalModel;
    const result = await generateNarrative(
      g,
      model,
      AbortSignal.timeout(10000),
      async () => {},
    );
    const { exportDocuments } = await import("../src/derived/export.ts");
    const docs = exportDocuments({
      ...g,
      kind: "export",
      manifest: { ...g.manifest, biography: result },
    });
    const archived = JSON.parse(docs["memories.json"]);
    const atoms = new Map<string, FactAtom>(
      archived.biographyManifest.facts.map((f: FactAtom) => [f.id, f]),
    );
    for (const section of result.sections)
      for (const paragraph of section.paragraphs!)
        for (const ref of paragraph.factRefs) {
          const atom = atoms.get(ref)!;
          assert.ok(atom);
          assert.ok(
            g.manifest.nodes.some(
              (n) => `${n.id}@${n.revision}` === atom.nodeRef,
            ),
          );
          assert.ok(
            atom.sourceRefs.every((id) =>
              g.manifest.transcripts.some((t) => t.id === id),
            ),
          );
        }
    assert.deepEqual(archived.biographyManifest.omissions, result.omissions);
    assert.doesNotMatch(docs["index.html"], /<script|https?:\/\/|@import/);
    assert.ok(docs["autobiography.md"].includes(result.sections[0]!.text));
    assert.equal(result.chapters.length, 1);
    assert.ok(
      g.diagnostics?.some((d) => d.reasonCode === "TITLE_FORMAT_FAILURE"),
    );
    assert.ok(
      g.diagnostics?.some((d) => d.reasonCode === "VALIDATED_HEADING_FALLBACK"),
    );
    assert.equal(writes[optional.id], 2);
    assert.ok(required.every((f) => writes[f.id] === 1));
    assert.ok(
      result.omissions!.some(
        (o) => o.factRef === optional.id && o.reason === "insufficient_context",
      ),
    );
    assert.ok(
      !g.atomicReviews!.some(
        (r) => r.chapterId === "chapter-2" && r.paragraphIndex === -1,
      ),
    );
  } finally {
    await db.close();
  }
});

test("pure thematic title may have no factual refs; factual title still requires explicit support", () => {
  const p = planJSON(["F001", "F002"]);
  p.chapters[0]!.titleFactRefs = [];
  assert.equal(
    parseNarrativePlan(JSON.stringify(p), facts).chapters[0]!.titleMode,
    "thematic",
  );
  p.chapters[0]!.titleMode = "factual";
  assert.throws(() => parseNarrativePlan(JSON.stringify(p), facts));
});

test("a year supported elsewhere in the paragraph cannot date an unknown-time atomic claim", () => {
  const dated = {
    ...f("F003", "1976年我进厂。"),
    time: {
      start: 23712,
      end: 23723,
      precision: "year" as const,
      certainty: "stated" as const,
      originalText: "1976年",
    },
    temporalPolicy: {
      explicitCalendarAllowed: true,
      uncertaintyMustRemain: false,
    },
  };
  const p = {
    text: "1976年我在河边玩，然后我进厂。",
    factRefs: ["F001", "F003"],
  };
  const r = parseReview(
    JSON.stringify({
      complete: true,
      claims: [
        {
          span: "1976年我在河边玩",
          claim: "河边玩",
          kind: "temporal",
          supportedBy: ["F001"],
          status: "supported",
        },
        {
          span: "我进厂",
          claim: "进厂",
          kind: "factual",
          supportedBy: ["F003"],
          status: "supported",
        },
      ],
      problems: [],
    }),
    p.factRefs,
    p.text,
  );
  assert.ok(
    paragraphProblems(p, [facts[0]!, dated], r).includes(
      "UNSUPPORTED_TEMPORAL_CLAIM",
    ),
  );
});

test("six-fact narrative regression permits two natural multi-fact paragraphs without Persona changing policy", () => {
  const six = [
    f("F001", "我在村里出生。"),
    f("F002", "家里有四个孩子。"),
    f("F003", "我排行第二。"),
    f("F004", "我到县城读书。"),
    f("F005", "王老师教语文。"),
    f("F006", "王老师叫我们先把字写端正。"),
  ];
  const plan = parseNarrativePlan(
    JSON.stringify({
      chapters: [
        {
          title: "家里和学校",
          titleMode: "thematic",
          titleFactRefs: [],
          paragraphs: [
            { brief: "家庭", factRefs: ["F001", "F002", "F003"] },
            { brief: "学校", factRefs: ["F004", "F005", "F006"] },
          ],
        },
      ],
      omissions: [],
    }),
    six,
  );
  const paragraphs = [
    "我在村里出生，家里有四个孩子，我排行第二。",
    "我到县城读书，教语文的王老师叫我们先把字写端正。",
  ].map((text, i) =>
    parseParagraph(
      JSON.stringify({
        text,
        factRefs: plan.chapters[0]!.paragraphs[i]!.factRefs,
        attributions: [],
      }),
      plan.chapters[0]!.paragraphs[i]!,
    ),
  );
  const section = publishChapter(plan.chapters[0]!, paragraphs, six);
  assert.equal(section.nodeRefs.length, 6);
  assert.equal(section.paragraphs!.length, 2);
  assert.ok(section.paragraphs!.every((p) => p.factRefs.length === 3));
  assert.doesNotMatch(section.text, /年份不详|待确认/);
});

test("targeted repair cannot move supported family attribution while removing a rejected flourish", async () => {
  const { repairContract, parseParagraphRepair } = await import(
    "../src/derived/narrative-repair.ts"
  );
  const p = {
    text: "据孩子说，家里用煤油灯照明。邻居们在门口聊天，交往带着自然的亲近。",
    factRefs: ["F001", "F002"],
    attributions: [{ factRef: "F001", surface: "据孩子说" }],
  };
  const claims = [
    {
      span: "据孩子说",
      claim: "子女讲述",
      kind: "attribution",
      status: "supported",
      supportedBy: ["F001"],
    },
    {
      span: "家里用煤油灯照明",
      claim: "灯",
      kind: "factual",
      status: "supported",
      supportedBy: ["F001"],
    },
    {
      span: "邻居们在门口聊天",
      claim: "聊天",
      kind: "factual",
      status: "supported",
      supportedBy: ["F002"],
    },
    {
      span: "交往带着自然的亲近",
      claim: "亲近",
      kind: "mental_state",
      status: "unsupported",
      supportedBy: [],
    },
  ];
  const review = parseReview(
    JSON.stringify({ complete: true, claims, problems: [] }),
    p.factRefs,
    p.text,
  );
  const contract = repairContract(p, review, facts, [
    "UNSUPPORTED_MENTAL_STATE_CLAIM",
  ]);
  const repaired = parseParagraphRepair(
    JSON.stringify({
      edits: [
        {
          target: contract.targets.find(
            (t) => t.span === "，交往带着自然的亲近",
          )!.id,
          replacement: "",
        },
      ],
      append: "",
      attributions: p.attributions,
    }),
    { brief: "生活", factRefs: p.factRefs },
    contract,
  );
  assert.equal(repaired.text, "据孩子说，家里用煤油灯照明。邻居们在门口聊天。");
  assert.throws(() =>
    parseParagraphRepair(
      JSON.stringify({
        edits: [
          {
            target: "not-an-editable-target",
            replacement: "家里用煤油灯照明。据孩子说，邻居们在门口聊天。",
          },
        ],
        append: "",
        attributions: p.attributions,
      }),
      { brief: "生活", factRefs: p.factRefs },
      contract,
    ),
  );
});

test("birthplace and childhood visits cannot become a growth/residence claim even if model approves", () => {
  const allowed = [
    f("F001", "我出生在安徽一个村子。"),
    f("F002", "小时候我常到村边的河里摸小鱼。"),
  ];
  const p = { text: "我是在村子里长大的", factRefs: ["F001", "F002"] };
  assert.ok(
    paragraphProblems(p, allowed).includes("UNSUPPORTED_CHILDHOOD_RESIDENCE"),
  );
  assert.deepEqual(
    paragraphProblems({ text: "村边的童年往事", factRefs: [] }, allowed),
    [],
  );
  assert.deepEqual(paragraphProblems(p, [f("F001", "我在村子里长大。")]), []);
});

test("temporal glue repair can split clauses without moving or rewriting their supported content", async () => {
  const { repairContract, parseParagraphRepair } = await import(
    "../src/derived/narrative-repair.ts"
  );
  const a = "小时候我常到村边的河里摸小鱼",
    b = "邻居们彼此熟悉";
  const p = {
    text: a + "，" + b + "，吃过饭就在门口聊天。",
    factRefs: ["F001", "F002"],
  };
  const facts = [f("F001", a), f("F002", b + "，吃过饭就在门口聊天")];
  const review = parseReview(
    JSON.stringify({
      complete: true,
      problems: [],
      claims: [
        {
          span: a,
          claim: a,
          kind: "factual",
          status: "supported",
          supportedBy: ["F001"],
        },
        {
          span: b,
          claim: b,
          kind: "factual",
          status: "supported",
          supportedBy: ["F002"],
        },
        {
          span: "吃过饭就在门口聊天",
          claim: "聊天",
          kind: "factual",
          status: "supported",
          supportedBy: ["F002"],
        },
        {
          span: "小时候",
          claim: "聊天发生于童年",
          kind: "temporal",
          status: "unsupported",
          supportedBy: [],
        },
      ],
    }),
    p.factRefs,
    p.text,
  );
  const contract = repairContract(p, review, facts, [
    "UNSUPPORTED_TEMPORAL_CLAIM",
  ]);
  const span = contract.transitionSpans.find((s) => s.includes("小鱼，邻居"))!;
  assert.ok(span);
  const next = parseParagraphRepair(
    JSON.stringify({
      edits: [
        {
          target: contract.targets.find((t) => t.span === span)!.id,
          replacement: span.replace("小鱼，邻居", "小鱼。邻居"),
        },
      ],
      append: "",
      attributions: [],
    }),
    { brief: "不同话题", factRefs: p.factRefs },
    contract,
  );
  assert.equal(next.text, p.text.replace("小鱼，邻居", "小鱼。邻居"));
  assert.ok(next.text.includes(a));
  assert.throws(() =>
    parseParagraphRepair(
      JSON.stringify({
        edits: [
          {
            target: contract.targets.find((t) => t.span === span)!.id,
            replacement: span.replace("小鱼，邻居", "大鱼。邻居"),
          },
        ],
        append: "",
        attributions: [],
      }),
      { brief: "不同话题", factRefs: p.factRefs },
      contract,
    ),
  );
});

test("atomic approval cannot hide a sentence-level childhood scope borrowed by an undated claim", () => {
  const fs = [f("F001", "小时候我在河边玩"), f("F002", "邻居们聊天")];
  const report = parseReview(
    JSON.stringify({
      complete: true,
      problems: [],
      claims: fs.map((f) => ({
        span: f.claim,
        claim: f.claim,
        kind: "factual",
        status: "supported",
        supportedBy: [f.id],
      })),
    }),
    fs.map((f) => f.id),
    "小时候我在河边玩，邻居们聊天。",
  );
  assert.ok(
    paragraphProblems(
      { text: "小时候我在河边玩，邻居们聊天。", factRefs: fs.map((f) => f.id) },
      fs,
      report,
    ).includes("UNSUPPORTED_TEMPORAL_SCOPE"),
  );
  assert.deepEqual(
    paragraphProblems(
      { text: "小时候我在河边玩。邻居们聊天。", factRefs: fs.map((f) => f.id) },
      fs,
      report,
    ),
    [],
  );
});

test("child is offspring provenance, never the narrator's childhood or a spouse", () => {
  const fact = {
    ...f("F001", "家里用煤油灯照明"),
    sourceMode: "nonself" as const,
    attribution: { required: true, speakerRoles: ["child"] },
  };
  for (const surface of ["小时候的我说", "孩子时的我说", "配偶说"]) {
    assert.ok(
      paragraphProblems(
        {
          text: surface + "，家里用煤油灯照明。",
          factRefs: [fact.id],
          attributions: [{ factRef: fact.id, surface }],
        },
        [fact],
      ).includes("MISSING_ATTRIBUTION"),
    );
  }
  for (const surface of ["孩子说", "我的孩子说", "据子女回忆", "家人提起"]) {
    assert.deepEqual(
      paragraphProblems(
        {
          text: surface + "，家里用煤油灯照明。",
          factRefs: [fact.id],
          attributions: [{ factRef: fact.id, surface }],
        },
        [fact],
      ),
      [],
    );
  }
});

test("rejected temporal span may overlap a supported fact without locking the unsupported cue", async () => {
  const { repairContract, parseParagraphRepair } = await import(
    "../src/derived/narrative-repair.ts"
  );
  const fixed = "家里有四个孩子",
    bad = "那时候啊，邻居们彼此熟悉，吃过饭就在门口聊天";
  const p = {
    text: fixed + "。小时候我在河边玩。" + bad + "。",
    factRefs: ["F001", "F002", "F003"],
  };
  const fs = [
    f("F001", fixed),
    f("F002", "小时候我在河边玩"),
    f("F003", "邻居们彼此熟悉，吃过饭就在门口聊天"),
  ];
  const claims = [
    {
      span: fixed,
      claim: fixed,
      kind: "factual",
      status: "supported",
      supportedBy: ["F001"],
    },
    {
      span: "小时候我在河边玩",
      claim: "童年玩耍",
      kind: "factual",
      status: "supported",
      supportedBy: ["F002"],
    },
    {
      span: "那时候啊，邻居们彼此熟悉",
      claim: "邻居熟悉",
      kind: "factual",
      status: "supported",
      supportedBy: ["F003"],
    },
    {
      span: "吃过饭就在门口聊天",
      claim: "饭后聊天",
      kind: "factual",
      status: "supported",
      supportedBy: ["F003"],
    },
    {
      span: bad,
      claim: "聊天发生于童年",
      kind: "temporal",
      status: "unsupported",
      supportedBy: [],
    },
  ];
  const review = parseReview(
    JSON.stringify({ complete: true, claims, problems: [] }),
    p.factRefs,
    p.text,
  );
  const contract = repairContract(p, review, fs, [
    "UNSUPPORTED_TEMPORAL_CLAIM",
  ]);
  assert.ok(contract.protectedSpans.includes(fixed));
  assert.ok(!contract.protectedSpans.some((s) => s.includes("那时候")));
  const next = parseParagraphRepair(
    JSON.stringify({
      edits: [
        {
          target: contract.targets.find((t) => t.span === bad)!.id,
          replacement: bad.replace("那时候啊，", ""),
        },
      ],
      append: "",
      attributions: [],
    }),
    { brief: "邻里生活", factRefs: p.factRefs },
    contract,
  );
  assert.equal(next.text, p.text.replace("那时候啊，", ""));
});

test("RC3 correction support excludes superseded testimony while archive history is complete", async () => {
  const db = await DomainDatabase.open(await mkdtemp(join(tmpdir(), "rc3-")));
  try {
    const seed = await seedSparse(db);
    const g = await db.call("derivedBegin", {
      id: randomUUID(),
      kind: "biography",
      sessionId: seed.sessionId,
      route: { provider: "fixture", model: "fixture" },
      narrativeVersion: 2,
    });
    const m = g.manifest,
      fs = factManifest(m);
    const current = fs.find((f) => f.claim.includes("1983年"))!;
    const old = m.transcripts.find((t) => t.text.includes("1982年"))!;
    const corrected = m.transcripts.find((t) => t.text.includes("1983年"))!;
    assert.deepEqual(current.sourceRefs, [corrected.id]);
    assert.deepEqual(
      new Set(current.historyRefs),
      new Set([old.id, corrected.id]),
    );
    assert.ok(current.testimony.every((t) => !t.text.includes("1982")));
    const chapter = {
      id: "chapter-1",
      title: "修理铺",
      titleMode: "thematic" as const,
      titleFactRefs: [current.id],
      paragraphs: [{ brief: "开店", factRefs: [current.id] }],
    };
    const section = publishChapter(
      chapter,
      [{ text: current.claim, factRefs: [current.id] }],
      fs,
    );
    assert.deepEqual(section.sourceRefs, [corrected.id]);
    const { exportDocuments } = await import("../src/derived/export.ts");
    const docs = exportDocuments({
      ...g,
      kind: "export",
      manifest: {
        ...m,
        biography: {
          id: g.id,
          chapters: [],
          sections: [section],
          facts: fs,
          personaId: null,
          omittedConflicts: [],
          narrativeVersion: 2,
        },
      },
    });
    for (const name of ["autobiography.md", "index.html"] as const) {
      assert.ok(docs[name].includes("1983年"));
      assert.ok(!docs[name].includes("1982年"));
      assert.ok(!docs[name].includes("煤油灯"));
    }
    const definitions = [
      ...docs["autobiography.md"].matchAll(/^\[\^(source-\d+)\]:/gm),
    ];
    assert.equal(definitions.length, 1);
    const archive = JSON.parse(docs["memories.json"]);
    assert.ok(archive.transcriptRevisions.some((t: any) => t.id === old.id));
    assert.ok(
      archive.transcriptRevisions.some((t: any) => t.id === corrected.id),
    );
    assert.ok(
      archive.memoryRevisions.some((n: any) =>
        n.keySentence.includes("1982年"),
      ),
    );
    assert.ok(archive.conflicts.some((c: any) => c.status === "resolved"));
    const broken = structuredClone(m);
    broken.revisions = broken.revisions.filter(
      (n) => !n.keySentence.includes("1982年"),
    );
    assert.throws(() => factManifest(broken), /correction history unavailable/);
  } finally {
    await db.close();
  }
});

test("sentence IDs preserve exact text, repeated sentences and reject absent IDs or incomplete coverage", () => {
  const prose = "我在河边玩。\n我在河边玩！还有伙伴？";
  const units = sentenceUnits(prose);
  assert.equal(units.map((s) => s.text).join(""), prose);
  const report = {
    complete: true,
    problems: [],
    claims: units
      .filter((s) => s.text.trim())
      .map((s) => ({
        sentenceId: s.id,
        claim: "转述允许不同标点",
        kind: "factual",
        status: "supported",
        supportedBy: ["F001"],
      })),
  };
  const parsed = parseSentenceReview(JSON.stringify(report), ["F001"], prose);
  assert.ok(reviewPassed(parsed));
  assert.equal(parsed.claims[1]!.span, "我在河边玩！");
  report.claims.pop();
  assert.equal(
    parseSentenceReview(JSON.stringify(report), ["F001"], prose).complete,
    false,
  );
  report.claims[0]!.sentenceId = "S999";
  assert.throws(
    () => parseSentenceReview(JSON.stringify(report), ["F001"], prose),
    /sentence ID/,
  );
});

test("sentence review guards prevent date borrowing and repair preserves other sentences", async () => {
  const { repairContract, parseParagraphRepair } = await import(
    "../src/derived/narrative-repair.ts"
  );
  const fs = [f("F1", "小时候我在河边玩。"), f("F2", "邻居聊天。")];
  const p = {
    text: "小时候我在河边玩。小时候邻居聊天。",
    factRefs: ["F1", "F2"],
  };
  const r = parseSentenceReview(
    JSON.stringify({
      complete: true,
      problems: [],
      claims: [
        {
          sentenceId: "S1",
          claim: "童年玩耍",
          kind: "factual",
          status: "supported",
          supportedBy: ["F1"],
        },
        {
          sentenceId: "S2",
          claim: "童年邻居聊天",
          kind: "factual",
          status: "supported",
          supportedBy: ["F2"],
        },
      ],
    }),
    p.factRefs,
    p.text,
  );
  const issues = paragraphProblems(p, fs, r);
  assert.ok(issues.includes("UNSUPPORTED_TEMPORAL_SCOPE"));
  const contract = repairContract(p, r, fs, issues);
  assert.ok(contract.protectedSpans.includes("小时候我在河边玩。"));
  const target = contract.targets.find((t) => t.span === "小时候邻居聊天。")!;
  const corrected = parseParagraphRepair(
    JSON.stringify({
      edits: [{ target: target.id, replacement: "邻居聊天。" }],
      append: "",
      attributions: [],
    }),
    { brief: "两个故事", factRefs: p.factRefs },
    contract,
  );
  assert.equal(corrected.text, "小时候我在河边玩。邻居聊天。");
  const next = parseSentenceReview(
    JSON.stringify({
      complete: true,
      problems: [],
      claims: r.claims.map(({ span, ...c }) => c),
    }),
    p.factRefs,
    corrected.text,
  );
  assert.deepEqual(paragraphProblems(corrected, fs, next), []);
});

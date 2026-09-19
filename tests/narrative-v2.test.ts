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
  parseReview,
  reviewPassed,
  paragraphProblems,
  publishChapter,
  styleSlot,
  omissionAllowed,
  type FactAtom,
} from "../src/derived/narrative.ts";
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
  f("F002", "邻居的孩子也在那里。"),
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

test("paragraph repair leaves successful paragraphs intact; optional-only failure is omitted and empty chapter dropped", async () => {
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
          for (const id of ids) writes[id] = (writes[id] ?? 0) + 1;
          out = {
            text: input.facts
              .map((f: FactAtom) =>
                f.attribution.required ? "家人说，" + f.claim : f.claim,
              )
              .join(""),
            factRefs: ids,
            attributions: input.facts
              .filter((f: FactAtom) => f.attribution.required)
              .map((f: FactAtom) => ({ factRef: f.id, surface: "家人说" })),
          };
        } else if (input.task) {
          out = {
            complete: true,
            claims: input.facts.map((f: FactAtom) => ({
              span: input.text,
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
    assert.equal(result.chapters.length, 1);
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

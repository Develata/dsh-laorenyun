import {
  repairContract,
  parseParagraphRepair,
  TARGETED_REPAIR_PROMPT,
} from "./narrative-repair.ts";
import type { InternalModel } from "../memory/model.ts";
import type { Generation, Biography } from "./types.ts";
import { DomainError } from "../domain/types.ts";
import {
  factManifest,
  parseNarrativePlan,
  parseParagraph,
  parseReview,
  reviewPassed,
  paragraphProblems,
  publishChapter,
  styleSlot,
  obj,
  text,
  NARRATIVE_PLAN_PROMPT,
  NARRATIVE_WRITE_PROMPT,
  NARRATIVE_REVIEW_PROMPT,
  TITLE_REPAIR_PROMPT,
  type NarrativeParagraph,
  type FactAtom,
  type Omission,
} from "./narrative.ts";
/** Existing generation deadline and InternalModel admission apply to every call.
 * Sequential paragraph tasks avoid expanding concurrency or rewriting accepted prose. */
export async function generateNarrative(
  g: Generation,
  model: InternalModel,
  signal: AbortSignal,
  save: (progress: string) => Promise<void>,
): Promise<Biography> {
  const facts = factManifest(g.manifest);
  // Retain old testimony in the fixed manifest/provenance, not as active competing
  // facts in Writer/Verifier context after an explicit source-backed resolution.
  const material = (selected: FactAtom[]) =>
    selected.map((f) =>
      f.conflictPolicy === "resolved"
        ? { ...f, testimony: [], clarifications: undefined }
        : f,
    );
  const call = async <T>(
    prompt: string,
    input: unknown,
    parse: (raw: string) => T,
  ) => {
    signal.throwIfAborted();
    const r = await model.json(
      g.route,
      prompt,
      input,
      (raw) => {
        try {
          return parse(raw);
        } catch (error) {
          g.validationReason =
            error instanceof DomainError
              ? error.code + ":" + error.message
              : "NARRATIVE_FORMAT";
          try {
            const rejected = JSON.parse(raw);
            g.rejectedStructure = {
              keys: Object.keys(rejected).slice(0, 12),
              chapters: Array.isArray(rejected.chapters)
                ? rejected.chapters.slice(0, 20).map((c: any) => ({
                    keys: Object.keys(c),
                    titleFactRefs: c.titleFactRefs,
                    paragraphs: c.paragraphs?.map((p: any) => ({
                      keys: Object.keys(p),
                      factRefs: p.factRefs,
                    })),
                  }))
                : undefined,
              omissions: rejected.omissions,
            };
          } catch {
            /* No free text/hidden reasoning retained. */
          }
          throw error;
        }
      },
      signal,
    );
    g.evidence.push(r.evidence);
    return r.value;
  };
  await save("planning");
  const plan = await call(
    NARRATIVE_PLAN_PROMPT,
    { facts: material(facts) },
    (raw) => parseNarrativePlan(raw, facts),
  );
  g.narrativePlan = plan;
  const omissions: Omission[] = [...plan.omissions];
  g.narrativeOmissions = omissions;
  const review = async (prose: string, allowed: FactAtom[], task: string) =>
    call(
      NARRATIVE_REVIEW_PROMPT,
      { task, text: prose, facts: material(allowed) },
      (raw) =>
        parseReview(
          raw,
          allowed.map((f) => f.id),
          prose,
        ),
    );
  for (const chapter of plan.chapters) {
    let title = chapter.title;
    const paragraphs: NarrativeParagraph[] = [];
    for (const [index, brief] of chapter.paragraphs.entries()) {
      const allowed = facts.filter((f) => brief.factRefs.includes(f.id));
      let repair: ReturnType<typeof repairContract> | null = null;
      let accepted = false;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await save(
            `chapter:${g.candidates.length + 1}/${plan.chapters.length}`,
          );
          const p = await call(
            attempt ? TARGETED_REPAIR_PROMPT : NARRATIVE_WRITE_PROMPT,
            {
              title,
              brief,
              facts: material(allowed),
              style: styleSlot(g.manifest.persona),
              ...(repair ? { repair, allowedFacts: material(allowed) } : {}),
            },
            (raw) =>
              repair
                ? parseParagraphRepair(raw, brief, repair)
                : parseParagraph(raw, brief),
          );
          const r = await review(p.text, allowed, "paragraph");
          const issues = paragraphProblems(p, allowed, r);
          (g.atomicReviews ??= []).push({
            chapterId: chapter.id,
            paragraphIndex: index,
            attempt,
            report: r,
          });
          for (const code of issues)
            (g.diagnostics ??= []).push({
              chapterId: chapter.id,
              paragraphIndex: index,
              attempt,
              claimKind: code.includes("TEMPORAL")
                ? "temporal"
                : code.includes("ATTRIBUTION")
                  ? "attribution"
                  : "factual",
              status: "unsupported",
              factRefs: p.factRefs,
              reasonCode: code,
            });
          await save("reviewing");
          if (reviewPassed(r) && !issues.length) {
            paragraphs.push(p);
            accepted = true;
            break;
          }
          repair = repairContract(p, r, allowed, issues);
        }
      } catch (error) {
        // InternalModel already exhausted its single format repair. Only legally
        // optional material may fail locally; deadlines/transport failures propagate.
        if (
          !allowed.every((f) => f.narrativePolicy === "optional_ambiguous") ||
          !(
            error instanceof SyntaxError ||
            (error instanceof DomainError &&
              error.code === "NARRATIVE_VALIDATION")
          )
        )
          throw error;
        (g.diagnostics ??= []).push({
          chapterId: chapter.id,
          paragraphIndex: index,
          attempt: 1,
          claimKind: "format",
          status: "unsupported",
          factRefs: brief.factRefs,
          reasonCode: "OPTIONAL_FORMAT_FAILURE",
        });
      }
      if (!accepted) {
        if (allowed.every((f) => f.narrativePolicy === "optional_ambiguous"))
          omissions.push(
            ...allowed.map((f) => ({
              factRef: f.id,
              reason: "insufficient_context" as const,
            })),
          );
        else
          throw new DomainError(
            "NARRATIVE_UNSUPPORTED",
            "required paragraph failed atomic review",
          );
      }
    }
    if (!paragraphs.length) continue;
    const titleFacts = facts.filter(
      (f) =>
        (!chapter.titleFactRefs.length ||
          chapter.titleFactRefs.includes(f.id)) &&
        paragraphs.some((p) => p.factRefs.includes(f.id)),
    );
    let titleOK = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await review(title, titleFacts, `title:${chapter.titleMode}`);
      (g.atomicReviews ??= []).push({
        chapterId: chapter.id,
        paragraphIndex: -1,
        attempt,
        report: r,
      });
      const issues = paragraphProblems(
        { text: title, factRefs: [] },
        titleFacts.filter((f) => !f.attribution.required),
      );
      if (reviewPassed(r) && !issues.length) {
        titleOK = true;
        break;
      }
      (g.diagnostics ??= []).push({
        chapterId: chapter.id,
        paragraphIndex: -1,
        attempt,
        claimKind: "title",
        status: "unsupported",
        factRefs: chapter.titleFactRefs,
        reasonCode: "UNSUPPORTED_TITLE",
      });
      await save("reviewing");
      if (!attempt)
        title = await call(
          TITLE_REPAIR_PROMPT,
          {
            originalTitle: title,
            facts: material(titleFacts),
            issues: r,
          },
          (raw) => text(obj(JSON.parse(raw), ["title"]).title, 60),
        );
    }
    if (!titleOK) {
      // A failed title must not discard independently validated prose. Reuse a
      // short, self-supported atomic span already reviewed in this chapter;
      // never borrow an unverified planner brief or synthesize a new assertion.
      const heading = g.atomicReviews
        ?.filter((r) => r.chapterId === chapter.id && r.paragraphIndex >= 0)
        .flatMap((r) => r.report.claims)
        .find(
          (c) =>
            c.kind === "factual" &&
            ["supported", "compatible_paraphrase"].includes(c.status) &&
            c.span.length <= 40 &&
            c.supportedBy.length > 0 &&
            c.supportedBy.every((id) =>
              facts.some(
                (f) =>
                  f.id === id &&
                  f.sourceMode === "self" &&
                  f.certainty === "stated" &&
                  f.conflictPolicy !== "open",
              ),
            ) &&
            paragraphs.some((p) => p.text.includes(c.span)),
        );
      title = heading?.span ?? `第${g.candidates.length + 1}章`;
      (g.diagnostics ??= []).push({
        chapterId: chapter.id,
        paragraphIndex: -1,
        attempt: 1,
        claimKind: "title",
        status: "supported",
        factRefs: heading?.supportedBy ?? [],
        reasonCode: "VALIDATED_HEADING_FALLBACK",
      });
    }
    if (paragraphs.length)
      g.candidates.push(
        publishChapter({ ...chapter, title }, paragraphs, facts),
      );
    await save("validating");
  }
  if (!g.candidates.length)
    throw new DomainError("NARRATIVE_UNSUPPORTED", "no validated content");
  const used = new Set(
    g.candidates.flatMap((s) => s.paragraphs!.flatMap((p) => p.factRefs)),
  );
  if (
    facts.some(
      (f) => !used.has(f.id) && !omissions.some((o) => o.factRef === f.id),
    )
  )
    throw new DomainError(
      "NARRATIVE_UNSUPPORTED",
      "unaccounted published facts",
    );
  return {
    id: g.id,
    narrativeVersion: 2,
    facts,
    sections: g.candidates,
    chapters: g.candidates.map((s) => ({
      id: s.chapterId,
      title: s.title,
      nodeRefs: s.nodeRefs,
    })),
    personaId: g.manifest.persona?.id ?? null,
    omittedConflicts: g.manifest.conflicts
      .filter((c) => c.status === "open")
      .map((c) => c.id),
    omissions,
  };
}

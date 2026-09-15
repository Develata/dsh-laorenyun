import { DomainError, type TranscriptSegment } from "../domain/types.ts";
import type { Evidence, ExtractionResult, Proposal } from "./types.ts";
function invalid(): never {
  throw new DomainError("INVALID_PROPOSAL", "memory schema or evidence");
}
function obj(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    invalid();
}
function str(v: unknown, max = 1000): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > max) invalid();
}
function arr(v: unknown, max: number): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length > max) invalid();
}
export function validateEvidence(value: unknown): asserts value is Evidence {
  obj(value, ["transcriptId", "text", "field"]);
  str(value.transcriptId, 128);
  str(value.text, 2000);
  if (
    ![
      "claim",
      "time",
      "people",
      "places",
      "cause",
      "process",
      "result",
    ].includes(String(value.field))
  )
    invalid();
}
export function verifyEvidence(
  e: Evidence,
  transcripts: Map<string, TranscriptSegment>,
): void {
  const t = transcripts.get(e.transcriptId);
  if (!t || !t.text.includes(e.text))
    throw new DomainError(
      "UNSUPPORTED_EVIDENCE",
      "exact accepted testimony required",
    );
}
export function parseExtraction(text: string): ExtractionResult {
  if (text.length > 48000) invalid();
  const v: unknown = JSON.parse(text);
  obj(v, ["proposals", "comparisons", "resolutions"]);
  arr(v.proposals, 6);
  arr(v.comparisons, 24);
  arr(v.resolutions, 5);
  for (const p of v.proposals) {
    obj(p, [
      "keySentence",
      "basis",
      "time",
      "evidence",
      "people",
      "places",
      "cause",
      "process",
      "result",
      "targetId",
      "edges",
    ]);
    str(p.keySentence, 120);
    if (!["stated", "inferred"].includes(String(p.basis))) invalid();
    obj(p.time, ["start", "end", "precision", "certainty", "originalText"]);
    if (
      typeof p.time.originalText !== "string" ||
      p.time.originalText.length > 200
    )
      invalid();
    if (
      !["month", "year", "decade", "approximate", "unknown"].includes(
        String(p.time.precision),
      ) ||
      !["stated", "inferred"].includes(String(p.time.certainty))
    )
      invalid();
    for (const k of ["start", "end"])
      if (
        p.time[k] !== null &&
        (!Number.isInteger(p.time[k]) ||
          Number(p.time[k]) < 0 ||
          Number(p.time[k]) > 120000)
      )
        invalid();
    if (
      (p.time.start === null) !== (p.time.end === null) ||
      (p.time.start !== null && Number(p.time.start) > Number(p.time.end))
    )
      invalid();
    if ((p.time.precision === "unknown") !== (p.time.start === null)) invalid();
    arr(p.evidence, 12);
    if (!p.evidence.length) invalid();
    p.evidence.forEach(validateEvidence);
    for (const k of ["people", "places"]) {
      arr(p[k], 10);
      for (const e of p[k]) {
        obj(e, ["name", "identity", "reuseId"]);
        str(e.name, 80);
        if (["我", "你", "他", "她", "他们", "我们"].includes(e.name))
          invalid();
        if (!["explicit", "ambiguous"].includes(String(e.identity))) invalid();
        if (e.reuseId !== undefined) str(e.reuseId, 128);
      }
    }
    for (const k of ["cause", "process", "result"])
      if (p[k] !== undefined) str(p[k], 1000);
    if (p.targetId !== undefined) str(p.targetId, 128);
    arr(p.edges, 8);
    for (const e of p.edges) {
      obj(e, ["to", "kind", "evidence"]);
      str(e.to, 128);
      if (
        !["PRECEDES", "CAUSES", "ELABORATES", "RELATES_TO"].includes(
          String(e.kind),
        )
      )
        invalid();
      arr(e.evidence, 6);
      e.evidence.forEach(validateEvidence);
    }
  }
  for (const c of v.comparisons) {
    obj(c, ["proposal", "nodeId", "revision", "verdict", "explanation"]);
    if (
      !Number.isInteger(c.proposal) ||
      Number(c.proposal) < 0 ||
      Number(c.proposal) >= v.proposals.length ||
      !Number.isInteger(c.revision) ||
      Number(c.revision) < 1
    )
      invalid();
    str(c.nodeId, 128);
    str(c.explanation, 300);
    if (
      ![
        "not_conflict",
        "possible_conflict",
        "material_conflict",
        "duplicate",
      ].includes(String(c.verdict))
    )
      invalid();
  }
  for (const r of v.resolutions) {
    obj(r, ["conflictId", "selectedNodeId", "evidence"]);
    str(r.conflictId, 128);
    str(r.selectedNodeId, 128);
    validateEvidence(r.evidence);
  }
  return v as unknown as ExtractionResult;
}
/** Conservative automatic promotion: no paraphrase or nonliteral field becomes stated merely from model confidence. */
export function validateProposal(
  p: Proposal,
  transcripts: Map<string, TranscriptSegment>,
): "confirmed" | "candidate" {
  p.evidence.forEach((e) => verifyEvidence(e, transcripts));
  for (const edge of p.edges)
    edge.evidence.forEach((e) => verifyEvidence(e, transcripts));
  if (!p.evidence.some((e) => e.field === "claim")) invalid();
  if (
    p.basis === "stated" &&
    !p.evidence.some(
      (e) => e.field === "claim" && e.text.includes(p.keySentence),
    )
  )
    throw new DomainError(
      "UNSUPPORTED_STATED",
      "stated key sentence must be extractive",
    );
  if (p.basis === "stated") {
    const trim = (text: string) => text.replace(/[。！？!?\s]+$/u, "").trim();
    const complete = p.evidence.some(
      (e) =>
        e.field === "claim" &&
        transcripts
          .get(e.transcriptId)!
          .text.split(/[。！？!?\n]/u)
          .some((sentence) => trim(sentence) === trim(p.keySentence)),
    );
    if (!complete)
      throw new DomainError(
        "UNSUPPORTED_STATED",
        "preserve complete sentence qualifiers; fragments remain inferred candidates",
      );
  }
  for (const field of ["cause", "process", "result"] as const)
    if (
      p[field] &&
      !p.evidence.some((e) => e.field === field && e.text.includes(p[field]!))
    )
      throw new DomainError(
        "UNSUPPORTED_FIELD",
        "literal narrative evidence required",
      );
  for (const field of ["people", "places"] as const)
    for (const entity of p[field])
      if (!p.evidence.some((e) => e.text.includes(entity.name)))
        throw new DomainError(
          "UNSUPPORTED_ENTITY",
          "literal entity evidence required",
        );
  if (
    p.time.originalText &&
    !p.evidence.some((e) => e.text.includes(p.time.originalText))
  )
    throw new DomainError(
      "UNSUPPORTED_TIME",
      "time language must occur in testimony",
    );
  if (p.time.start !== null && p.time.certainty === "stated") {
    // Relative dates stay inferred. Only literal numeric calendar anchors are auto-confirmed.
    const m = /(\d{4})年(?:(\d{1,2})月)?/.exec(p.time.originalText);
    if (!m)
      throw new DomainError(
        "UNSUPPORTED_TIME",
        "explicit calendar required for stated anchor",
      );
    const y = Number(m[1]),
      month = m[2] ? Number(m[2]) : null;
    const start = y * 12 + (month ? month - 1 : 0),
      end = month ? start : y * 12 + 11;
    if (month !== null && (month < 1 || month > 12)) invalid();
    if (
      p.time.start !== start ||
      p.time.end !== end ||
      p.time.precision !== (month ? "month" : "year")
    )
      throw new DomainError(
        "UNSUPPORTED_TIME",
        "calendar range mismatch; keep nonliteral dates inferred",
      );
  }
  return p.basis === "stated" &&
    p.time.certainty === "stated" &&
    !p.people.some((e) => e.identity === "ambiguous") &&
    !p.places.some((e) => e.identity === "ambiguous")
    ? "confirmed"
    : "candidate";
}

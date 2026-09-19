import { generateNarrative } from "./narrative-run.ts";
import type { DomainDatabase } from "../storage/database.ts";
import type { InternalModel } from "../memory/model.ts";
import { DomainError } from "../domain/types.ts";
import {
  nodeRef,
  type Generation,
  type Biography,
  type Persona,
} from "./types.ts";
import {
  eligible,
  parsePersona,
  parsePlan,
  parseSection,
  PERSONA_PROMPT,
  PLANNER_PROMPT,
  RENDER_PROMPT,
} from "./validate.ts";
import { publishExport } from "./export.ts";
export class DerivedService {
  private db: DomainDatabase;
  private model: InternalModel;
  private root: string;
  private report: (code: string) => void;
  private stop = new AbortController();
  private current: { id: string; abort: AbortController } | null = null;
  private work: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    db: DomainDatabase,
    model: InternalModel,
    root: string,
    report: (code: string) => void = () => {},
  ) {
    this.db = db;
    this.model = model;
    this.root = root;
    this.report = report;
  }
  async start() {
    await this.db.call("derivedRecover", null);
    this.timer = setInterval(() => this.tick(), 1500);
    this.timer.unref();
  }
  tick() {
    if (this.work || this.stop.signal.aborted) return;
    this.work = this.drain().finally(() => {
      this.work = null;
    });
  }
  private async drain() {
    try {
      const g = await this.db.call("derivedClaim", null);
      if (!g) return;
      const abort = new AbortController();
      this.current = { id: g.id, abort };
      try {
        await this.generate(
          g,
          AbortSignal.any([
            this.stop.signal,
            abort.signal,
            AbortSignal.timeout(Math.max(1, g.deadline - Date.now())),
          ]),
        );
      } catch (e) {
        const saved = await this.db.call("derivedGet", g.id);
        if (saved.state === "running") {
          g.state = "failed";
          g.progress = "failed";
          g.error = e instanceof DomainError ? e.code : "GENERATION_FAILED";
          await this.db.call("derivedUpdate", g);
        }
      } finally {
        this.current = null;
      }
    } catch (e) {
      this.report(e instanceof DomainError ? e.code : "DERIVED_STORAGE_FAILED");
    }
  }
  async cancel(id: string) {
    if (this.current?.id === id) this.current.abort.abort();
    await this.db.call("derivedCancel", id);
  }
  private async generate(g: Generation, signal: AbortSignal) {
    const m = g.manifest;
    const save = async (progress: string) => {
      signal.throwIfAborted();
      g.progress = progress;
      await this.db.call("derivedUpdate", g);
    };
    if (g.kind === "persona") {
      await save("persona");
      const result = await this.model.json(
        g.route,
        PERSONA_PROMPT,
        {
          transcripts: m.transcripts.map((t) => ({
            id: t.id,
            text: t.text.slice(0, 1200),
          })),
        },
        (raw) => {
          try {
            return parsePersona(raw, m, g.id, g.inputHash);
          } catch (error) {
            // This validator emits fixed reason strings only, never source/model text.
            if (error instanceof DomainError) {
              g.validationReason = error.message;
              this.report(error.message);
            }
            throw error;
          }
        },
        signal,
      );
      g.evidence.push(result.evidence);
      g.result = result.value;
    } else if (g.kind === "biography" && g.promptVersion === "narrative-v2") {
      g.result = await generateNarrative(g, this.model, signal, save);
    } else if (g.kind === "biography") {
      await save("planning");
      const nodes = eligible(m);
      const plan = await this.model.json(
        g.route,
        PLANNER_PROMPT,
        {
          nodes: nodes.map((n) => ({
            ref: nodeRef(n),
            keySentence: n.keySentence,
            time: n.time,
            placement: n.placement,
          })),
        },
        (raw) => parsePlan(raw, m),
        signal,
      );
      g.evidence.push(plan.evidence);
      for (const chapter of plan.value) {
        await save(`chapter:${g.candidates.length + 1}/${plan.value.length}`);
        const result = await this.model.json(
          g.route,
          RENDER_PROMPT,
          {
            chapter,
            nodes: nodes
              .filter((n) => chapter.nodeRefs.includes(nodeRef(n)))
              .map((n) => ({ ref: nodeRef(n), keySentence: n.keySentence })),
            style: m.persona?.observations ?? [],
          },
          (raw) => parseSection(raw, m, chapter),
          signal,
        );
        g.candidates.push(result.value);
        g.evidence.push(result.evidence);
        await save("validating");
      }
      g.result = {
        id: g.id,
        chapters: plan.value,
        sections: g.candidates,
        personaId: m.persona?.id ?? null,
        omittedConflicts: m.conflicts
          .filter((c) => c.status === "open")
          .map((c) => c.id),
      } satisfies Biography;
    } else {
      await save("exporting");
      g.result = await publishExport(this.root, g, signal);
    }
    signal.throwIfAborted();
    g.state = "published";
    g.progress = "published";
    await this.db.call("derivedUpdate", g);
  }
  async close() {
    clearInterval(this.timer);
    this.stop.abort();
    await this.work;
  }
}

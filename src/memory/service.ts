import type { DomainDatabase } from "../storage/database.ts";
import { DomainError } from "../domain/types.ts";
import type { InternalModel, ModelRoute } from "./model.ts";
import type { ExtractionInput } from "./types.ts";
export class MemoryService {
  private controller = new AbortController();
  private task: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly db: DomainDatabase;
  readonly model: InternalModel;
  private route: (sessionId: string) => Promise<ModelRoute>;
  private report: (code: string) => void;
  constructor(
    db: DomainDatabase,
    model: InternalModel,
    route: (sessionId: string) => Promise<ModelRoute>,
    report: (code: string) => void,
  ) {
    this.db = db;
    this.model = model;
    this.route = route;
    this.report = report;
  }
  async start() {
    await this.db.call("memoryRecover", null);
    this.timer = setInterval(() => this.wake(), 1500);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.task || this.controller.signal.aborted) return;
    this.task = this.drain()
      .catch(() => this.report("MEMORY_QUEUE_FAILED"))
      .finally(() => {
        this.task = null;
      });
  }
  private async drain() {
    for (let n = 0; n < 8 && !this.controller.signal.aborted; n++) {
      const input = await this.db.call("memoryClaim", null);
      if (!input) return;
      try {
        await this.process(input);
      } catch (error) {
        await this.db.call("memoryFail", {
          id: input.operation.id,
          code: error instanceof DomainError ? error.code : "EXTRACTION_FAILED",
        });
        if (
          error instanceof DomainError &&
          error.code === "REVISION_CONFLICT" &&
          input.operation.attempts < 2
        )
          await this.db.call("memoryRetry", input.operation.id);
        this.report(
          error instanceof DomainError ? error.code : "EXTRACTION_FAILED",
        );
      }
    }
  }
  async process(input: ExtractionInput) {
    const { operation: op } = input;
    if (!op.result) {
      const generated = await this.model.extract(
        await this.route(input.transcript.sessionId),
        input,
        this.controller.signal,
      );
      await this.db.call("memoryProposal", {
        id: op.id,
        result: generated.value,
        evidence: generated.evidence,
      });
    }
    // A changed graph invalidates candidate comparisons: never blindly overwrite. A failed CAS is explicitly retryable by an operator.
    await this.db.call("memoryApply", {
      id: op.id,
      expected: op.graphRevision,
    });
  }
  async close() {
    clearInterval(this.timer);
    this.controller.abort();
    await this.task;
  }
}

import { Worker } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  checkOperation,
  DomainError,
  operation,
  type OperationContext,
} from "../domain/types.ts";
import type { Method, Operations, WorkerResponse } from "./protocol.ts";
/** A bounded mailbox. SQLite is imported exclusively by worker.ts. */
export class DomainDatabase {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      cleanup: () => void;
    }
  >();
  private stopped = false;
  private scopedRoot: string | undefined;
  private owner: DomainDatabase | undefined;
  private ready: Promise<void>;
  private constructor(path: string, workerUrl: URL) {
    this.worker = new Worker(workerUrl, { workerData: { path } });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DomainError("WORKER_START_TIMEOUT", "database startup"));
        void this.shutdownFailed().catch(() => {});
      }, 5000);
      const onError = (e: Error) => {
        clearTimeout(timer);
        reject(new DomainError("WORKER_START_FAILED", e.message));
      };
      this.worker.once("error", onError);
      this.worker.once("message", (m: { ready: boolean; message?: string }) => {
        clearTimeout(timer);
        this.worker.off("error", onError);
        m.ready
          ? resolve()
          : reject(
              new DomainError("MIGRATION_FAILED", m.message ?? "database"),
            );
      });
    });
    this.worker.on("error", (error) =>
      this.fail(new DomainError("WORKER_FAILED", error.message)),
    );
    this.worker.on("exit", () =>
      this.fail(new DomainError("WORKER_EXIT", "database worker stopped")),
    );
    this.worker.on("message", (m: WorkerResponse) => {
      if (!("id" in m)) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      p.cleanup();
      if (m.ok) p.resolve(m.value);
      else p.reject(new DomainError(m.code, m.message));
    });
  }
  static async open(root: string): Promise<DomainDatabase> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const url = new URL(
      suffix === ".ts" ? "./worker.ts" : "./storage/worker.js",
      import.meta.url,
    );
    const db = new DomainDatabase(join(root, "laorenyun.db"), url);
    try {
      await db.ready;
      return db;
    } catch (e) {
      await db.shutdownFailed();
      throw e;
    }
  }
  async scope(root: string): Promise<DomainDatabase> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const view = Object.create(DomainDatabase.prototype) as DomainDatabase;
    view.owner = this.owner ?? this;
    view.scopedRoot = join(root, "laorenyun.db");
    await view.call("health", null);
    return view;
  }
  async call<K extends Method>(
    method: K,
    input: Operations[K]["input"],
    op: OperationContext = operation(),
  ): Promise<Operations[K]["output"]> {
    if (this.owner)
      return this.owner.dispatch(method, input, op, this.scopedRoot);
    return this.dispatch(method, input, op);
  }
  private async dispatch<K extends Method>(
    method: K,
    input: Operations[K]["input"],
    op: OperationContext,
    archivePath?: string,
  ): Promise<Operations[K]["output"]> {
    checkOperation(op);
    await this.ready;
    checkOperation(op);
    if (this.stopped)
      throw new DomainError(
        "DATABASE_CLOSED",
        "database not accepting operations",
      );
    if (this.pending.size >= 64)
      throw new DomainError("DATABASE_BUSY", "64 requests already pending");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const expire = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        reject(
          new DomainError(
            "TIMEOUT",
            "database operation outcome may require reconciliation",
          ),
        );
        void this.shutdownFailed().catch(() => {});
      };
      const timer = setTimeout(expire, Math.max(1, op.deadline - Date.now()));
      const abort = () => expire();
      op.signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (v) => resolve(v as Operations[K]["output"]),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          op.signal.removeEventListener("abort", abort);
        },
      });
      try {
        this.worker.postMessage({
          id,
          method,
          input,
          deadline: op.deadline,
          archivePath,
        });
      } catch (e) {
        const p = this.pending.get(id);
        this.pending.delete(id);
        p?.cleanup();
        reject(e);
      }
    });
  }
  private fail(error: Error): void {
    this.stopped = true;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    this.pending.clear();
  }
  private async terminate(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.worker.terminate(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DomainError("WORKER_STOP_TIMEOUT", "database worker stop"),
              ),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async shutdownFailed(): Promise<void> {
    this.fail(
      new DomainError("DATABASE_UNAVAILABLE", "worker requires reopen"),
    );
    await this.terminate();
  }
  async close(): Promise<void> {
    if (this.owner) return; // worker lifetime belongs to the root owner
    if (this.stopped) return;
    try {
      await this.call("close", null, operation(3000));
    } finally {
      this.stopped = true;
      await this.terminate();
    }
  }
}

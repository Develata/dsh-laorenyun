import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-workspace";
import type { Workspace } from "@deepseek-ai/dsh-workspace";
import { mkdir, readFile, open, rename, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/types.ts";
import { SessionId } from "@deepseek-ai/dsh-session";
/** DSH alone owns membership. This index only assigns the legacy store to its default Workspace. */
export class Archives {
  private ctx: Context;
  private creating = false;
  readonly root: string;
  readonly defaultId: string;
  private constructor(ctx: Context, root: string, defaultId: string) {
    this.ctx = ctx;
    this.root = root;
    this.defaultId = defaultId;
  }
  static async open(ctx: Context, root: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const marker = join(root, "archive-default.json");
    let id: string;
    try {
      const record = JSON.parse(await readFile(marker, "utf8"));
      if (record.version !== 1 || typeof record.workspaceId !== "string")
        throw new Error("invalid migration marker");
      id = record.workspaceId;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const workspace = await ctx.workspaceRegistry.create(
        process.cwd(),
        "默认人物档案",
      );
      id = String(workspace.id);
      const file = await open(marker + ".pending", "w", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ version: 1, workspaceId: id }) + "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(marker + ".pending", marker);
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const archives = new Archives(ctx, root, id),
      workspace = archives.get(id);
    // Repeating attach is idempotent. Immutable headers keep unrelated directories out.
    const sessions = await ctx.sessionPersistence.list({
      signal: AbortSignal.timeout(10000),
    });
    if (sessions.length > 10000)
      throw new DomainError(
        "ARCHIVE_MIGRATION_LIMIT",
        "session header migration limit",
      );
    for (const snapshot of sessions) {
      const h = snapshot.header;
      if (!h.cwd) continue;
      let cwd: string;
      try {
        cwd = await realpath(h.cwd);
      } catch {
        continue;
      }
      if (cwd === workspace.path) await workspace.attachSession(h.id);
    }
    return archives;
  }
  get(id: string): Workspace {
    const w = this.ctx.workspaceRegistry
      .list()
      .find((w) => String(w.id) === id);
    if (
      !w ||
      !(
        id === this.defaultId ||
        dirname(w.path) === join(this.root, "archive-workspaces")
      )
    )
      throw new DomainError("ARCHIVE_NOT_FOUND", "person archive unavailable");
    return w;
  }
  list() {
    return this.ctx.workspaceRegistry
      .list()
      .filter(
        (w) =>
          String(w.id) === this.defaultId ||
          dirname(w.path) === join(this.root, "archive-workspaces"),
      )
      .map((w) => ({
        id: String(w.id),
        title: w.title,
        sessionIds: w.sessionIds.map(String),
      }));
  }
  dataRoot(id: string) {
    this.get(id);
    return id === this.defaultId ? this.root : join(this.root, "archives", id);
  }
  async create(title: string) {
    if (!title.trim() || title.length > 60)
      throw new DomainError("INVALID_INPUT", "archive title");
    if (this.list().length >= 32)
      throw new DomainError("ARCHIVE_LIMIT", "archive limit");
    if (this.creating)
      throw new DomainError("ARCHIVE_BUSY", "archive creation in progress");
    this.creating = true;
    try {
      const path = join(this.root, "archive-workspaces", randomUUID());
      await mkdir(path, { recursive: true, mode: 0o700 });
      const w = await this.ctx.workspaceRegistry.create(path, title.trim());
      return { id: String(w.id), title: w.title, sessionIds: [] };
    } finally {
      this.creating = false;
    }
  }

  async forSession(id: string, depth = 0): Promise<string> {
    if (depth > 1) throw new DomainError("BRANCH_DEPTH", "archive lineage");
    const direct = this.list().find((w) => w.sessionIds.includes(id));
    if (direct) return direct.id;
    // Continuable Branch identity is tied to parent lineage, not browser selection.
    const h = (
      await this.ctx.sessionPersistence.stat(SessionId(id), {
        signal: AbortSignal.timeout(5000),
      })
    )?.header;
    if (!h)
      throw new DomainError(
        "ARCHIVE_SESSION_REQUIRED",
        "session is not in an archive",
      );
    if (h.parentSession)
      return this.forSession(String(h.parentSession), depth + 1);
    // Only legacy default-cwd sessions may be attached automatically; never transfer between archives.
    if (h.cwd === this.get(this.defaultId).path) {
      await this.get(this.defaultId).attachSession(SessionId(id));
      return this.defaultId;
    }
    throw new DomainError(
      "ARCHIVE_SESSION_REQUIRED",
      "session membership missing",
    );
  }
}

import {
  mkdir,
  open,
  readFile,
  rename,
  opendir,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DomainError,
  checkOperation,
  type Media,
  type MediaId,
  type OperationContext,
  type RecordingStore,
} from "../domain/types.ts";
import type { DomainDatabase } from "./database.ts";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const validId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
/** Local writes publish a durable manifest before registering metadata in SQLite. */
export class FileRecordingStore implements RecordingStore {
  private root: string;
  private db: DomainDatabase;
  constructor(root: string, db: DomainDatabase) {
    this.root = root;
    this.db = db;
  }
  async initialize(op: OperationContext): Promise<void> {
    await mkdir(join(this.root, "audio"), { recursive: true, mode: 0o700 });
    for await (const entry of await opendir(join(this.root, "audio"))) {
      checkOperation(op);
      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".json") && !entry.name.endsWith(".json.partial"))
      )
        continue;
      const partial = entry.name.endsWith(".partial");
      const id = entry.name.slice(0, partial ? -13 : -5);
      if (partial) {
        try {
          await lstat(join(this.root, "audio", `${id}.bin`));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
      }
      if (!validId(id))
        throw new DomainError("CORRUPT_MEDIA", "invalid media manifest name");
      const media: Media = JSON.parse(
        await readFile(join(this.root, "audio", entry.name), "utf8"),
      );
      if (media.id !== id || media.relativePath !== `audio/${id}.bin`)
        throw new DomainError("CORRUPT_MEDIA", "manifest path mismatch");
      const registered = await this.db.call("getMedia", media.id, op);
      if (registered) {
        if (
          registered.sha256 !== media.sha256 ||
          registered.bytes !== media.bytes
        )
          throw new DomainError(
            "CORRUPT_MEDIA",
            "manifest disagrees with stored metadata",
          );
        if (partial)
          await rename(
            join(this.root, "audio", entry.name),
            join(this.root, "audio", `${id}.json`),
          );
        continue;
      }
      const bytes = await this.readBytes(media.id, op);
      if (bytes.length !== media.bytes || digest(bytes) !== media.sha256)
        throw new DomainError("CORRUPT_MEDIA", "media checksum mismatch");
      await this.db.call("putMedia", media, op);
      if (partial)
        await rename(
          join(this.root, "audio", entry.name),
          join(this.root, "audio", `${id}.json`),
        );
    }
  }
  async write(
    bytes: Uint8Array,
    mime: string,
    fixture: boolean,
    op: OperationContext,
  ): Promise<Media> {
    checkOperation(op);
    if (bytes.byteLength > 32 * 1024 * 1024)
      throw new DomainError("MEDIA_TOO_LARGE", "limit 32 MiB");
    const id = randomUUID() as MediaId;
    const media: Media = {
      id,
      mime,
      fixture,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
      relativePath: `audio/${id}.bin`,
      createdAt: Date.now(),
    };
    const dir = join(this.root, "audio");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const manifest = await open(join(dir, `${id}.json.partial`), "wx", 0o600);
    try {
      await manifest.writeFile(JSON.stringify(media));
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    const file = await open(join(dir, `${id}.partial`), "wx", 0o600);
    try {
      checkOperation(op);
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    checkOperation(op);
    await rename(join(dir, `${id}.partial`), join(dir, `${id}.bin`));
    await rename(join(dir, `${id}.json.partial`), join(dir, `${id}.json`));
    const directory = await open(dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    checkOperation(op);
    return this.db.call("putMedia", media, op);
  }
  private async readBytes(
    id: MediaId,
    op: OperationContext,
  ): Promise<Uint8Array> {
    checkOperation(op);
    if (!validId(id))
      throw new DomainError("INVALID_MEDIA", "opaque media ID required");
    const path = join(this.root, "audio", `${id}.bin`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw new DomainError("INVALID_MEDIA", "unsafe media file");
    return readFile(path, { signal: op.signal });
  }
  async read(id: MediaId, op: OperationContext): Promise<Uint8Array> {
    const media = await this.db.call("getMedia", id, op);
    if (!media) throw new DomainError("NOT_FOUND", "media");
    const bytes = await this.readBytes(id, op);
    if (digest(bytes) !== media.sha256)
      throw new DomainError("CORRUPT_MEDIA", "checksum mismatch");
    return bytes;
  }
}

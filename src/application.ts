import { randomUUID } from "node:crypto";
import { DomainDatabase } from "./storage/database.ts";
import { FileRecordingStore } from "./storage/recordings.ts";
import {
  DomainError,
  operation,
  speaker,
  type Source,
  type SourceId,
  type SpeakerIdentity,
} from "./domain/types.ts";
import { fakeSpeech } from "./probes/fake-speech.ts";
/** Small application owner; all SQLite requests go through one worker. */
export class Foundation {
  readonly db: DomainDatabase;
  readonly recordings: FileRecordingStore;
  private constructor(db: DomainDatabase, store: FileRecordingStore) {
    this.db = db;
    this.recordings = store;
  }
  static async open(
    root: string,
    shared?: DomainDatabase,
  ): Promise<Foundation> {
    const db = shared
      ? await shared.scope(root)
      : await DomainDatabase.open(root);
    const store = new FileRecordingStore(root, db);
    try {
      await store.initialize(operation(10000));
      return new Foundation(db, store);
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  async fakeDraft(
    sessionId: string,
    identity: SpeakerIdentity,
  ): Promise<Source> {
    if (!sessionId || sessionId.length > 128)
      throw new DomainError("INVALID_SESSION", "session identity required");
    speaker(identity);
    const previous = await this.db.call("getDraft", sessionId);
    if (previous) return previous;
    const op = operation();
    const media = await this.recordings.write(
      new TextEncoder().encode(
        "Laorenyun Phase 1 simulated recording. Not real speech.",
      ),
      "application/x-laorenyun-fixture",
      true,
      op,
    );
    const raw = await fakeSpeech.transcribe(media, op);
    return this.db.call(
      "createSource",
      {
        id: randomUUID() as SourceId,
        sessionId,
        mediaId: media.id,
        rawAsr: raw.text,
        draft: raw.text,
        draftRevision: 0,
        speaker: identity,
        status: "draft",
        createdAt: Date.now(),
      },
      op,
    );
  }
  close(): Promise<void> {
    return this.db.close();
  }
}

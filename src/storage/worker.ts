import type {
  SpeechAttempt,
  InterviewState,
  AssistantReply,
} from "../domain/speech.ts";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { migrate, SCHEMA_VERSION } from "./migrations.ts";
import {
  DomainError,
  speaker,
  type Branch,
  type Media,
  type MemoryNode,
  type Source,
  type SourceId,
  type TranscriptSegment,
} from "../domain/types.ts";
import { parseSourceReference } from "../domain/source-reference.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
const port = parentPort!;
let db: DatabaseSync;
try {
  db = new DatabaseSync(workerData.path, { timeout: 100 });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL",
  );
  migrate(db);
  port.postMessage({ ready: true, schema: SCHEMA_VERSION });
} catch (error) {
  port.postMessage({
    ready: false,
    message: error instanceof Error ? error.message : String(error),
  });
  port.close();
  throw error;
}
function read<T>(sql: string, ...params: string[]): T | null {
  const row = db.prepare(sql).get(...params);
  return row ? (JSON.parse(String(row.json)) as T) : null;
}
function source(id: string): Source {
  const v = read<Source>("SELECT json FROM sources WHERE id=?", id);
  if (!v) throw new DomainError("NOT_FOUND", "source");
  return v;
}
function saveSource(v: Source): Source {
  db.prepare("UPDATE sources SET status=?,json=? WHERE id=?").run(
    v.status,
    JSON.stringify(v),
    v.id,
  );
  return v;
}
function branch(sessionId: string): Branch | null {
  return read<Branch>(
    "SELECT json FROM branches WHERE session_id=?",
    sessionId,
  );
}
function saveBranch(v: Branch): Branch {
  db.prepare(
    "UPDATE branches SET state=?,answer_count=?,json=? WHERE id=?",
  ).run(v.state, v.answerCount, JSON.stringify(v), v.id);
  return v;
}
function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = fn();
    db.exec("COMMIT");
    return v;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function handle(r: WorkerRequest): unknown {
  if (Date.now() >= r.deadline)
    throw new DomainError("TIMEOUT", "queued database request expired");
  switch (r.method) {
    case "attachRecording": {
      const v = source(r.input.sourceId);
      if (v.status !== "draft" || (v.mediaId && v.mediaId !== r.input.mediaId))
        throw new DomainError("SOURCE_NOT_DRAFT", "recording association");
      const media = read<Media>(
        "SELECT json FROM media WHERE id=?",
        r.input.mediaId,
      );
      if (!media || media.sourceId !== v.id)
        throw new DomainError("INVALID_MEDIA", "source association");
      db.prepare("UPDATE sources SET media_id=? WHERE id=?").run(
        media.id,
        v.id,
      );
      return saveSource({ ...v, mediaId: media.id });
    }
    case "putAttempt": {
      const old = read<SpeechAttempt>(
        "SELECT json FROM speech_attempts WHERE id=?",
        r.input.id,
      );
      if (
        old &&
        (old.sourceId !== r.input.sourceId ||
          ["succeeded", "failed", "interrupted"].includes(old.state))
      )
        throw new DomainError("IMMUTABLE_ATTEMPT", "attempt finalized");
      db.prepare(
        "INSERT INTO speech_attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      ).run(r.input.id, r.input.sourceId, JSON.stringify(r.input));
      return r.input;
    }
    case "getAttempt":
      return read(
        "SELECT json FROM speech_attempts WHERE source_id=? ORDER BY rowid DESC LIMIT 1",
        r.input,
      );
    case "recoverSpeech": {
      // Journal recovery can register the original before source attachment committed.
      for (const row of db
        .prepare(
          "SELECT m.json FROM media m JOIN sources s ON json_extract(m.json,'$.sourceId')=s.id WHERE s.media_id IS NULL AND s.status='draft' AND json_extract(m.json,'$.originalMediaId') IS NULL",
        )
        .all()) {
        const media = JSON.parse(String(row.json)) as Media;
        if (!media.sourceId) continue;
        const v = source(media.sourceId);
        db.prepare("UPDATE sources SET media_id=? WHERE id=?").run(
          media.id,
          v.id,
        );
        saveSource({ ...v, mediaId: media.id });
      }
      db.exec(
        `UPDATE speech_attempts SET json=json_set(json,'$.state','interrupted','$.error','PROCESS_INTERRUPTED') WHERE json_extract(json,'$.state') IN ('normalizing','transcribing')`,
      );
      return null;
    }
    case "completeAsr": {
      const v = source(r.input.id);
      if (v.status !== "draft" || v.recognition === "ready")
        throw new DomainError(
          "REVISION_CONFLICT",
          "recognition already adopted",
        );
      return saveSource({
        ...v,
        rawAsr: r.input.text,
        draft: r.input.text,
        draftRevision: v.draftRevision + 1,
        recognition: "ready",
      });
    }
    case "beginInterview": {
      db.prepare("INSERT OR IGNORE INTO interviews VALUES(?,?)").run(
        r.input.sessionId,
        JSON.stringify(r.input),
      );
      return read<InterviewState>(
        "SELECT json FROM interviews WHERE session_id=?",
        r.input.sessionId,
      );
    }
    case "getInterview":
      return read("SELECT json FROM interviews WHERE session_id=?", r.input);
    case "putReply": {
      const old = read<AssistantReply>(
        "SELECT json FROM assistant_replies WHERE session_id=?",
        r.input.sessionId,
      );
      if (old?.messageId === r.input.messageId) return old;
      db.prepare(
        "INSERT INTO assistant_replies VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET json=excluded.json",
      ).run(r.input.sessionId, JSON.stringify(r.input));
      return r.input;
    }
    case "getReply":
      return read(
        "SELECT json FROM assistant_replies WHERE session_id=?",
        r.input,
      );
    case "markReceipt":
      db.prepare(
        "INSERT INTO receipts VALUES(?,?) ON CONFLICT(transcript_id) DO UPDATE SET state=excluded.state",
      ).run(r.input.transcriptId, r.input.state);
      return null;
    case "getReceipts":
      return db
        .prepare(
          "SELECT t.json,COALESCE(r.state,'domain-accepted') state FROM transcripts t LEFT JOIN receipts r ON r.transcript_id=t.id WHERE session_id=? ORDER BY t.rowid DESC LIMIT 10",
        )
        .all(r.input)
        .map((v) => ({
          transcript: JSON.parse(String(v.json)),
          state: String(v.state),
        }));
    case "getSessionSpeaker":
      return (
        read(
          "SELECT json FROM session_speakers WHERE session_id=?",
          r.input,
        ) ?? { role: "self", authority: "explicit-user" }
      );
    case "setSessionSpeaker": {
      const value = speaker(r.input.speaker);
      db.prepare(
        "INSERT INTO session_speakers VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET json=excluded.json",
      ).run(r.input.sessionId, JSON.stringify(value));
      return value;
    }
    case "health":
      return {
        schema: SCHEMA_VERSION,
        sources: Number(db.prepare("SELECT count(*) n FROM sources").get()!.n),
        transcripts: Number(
          db.prepare("SELECT count(*) n FROM transcripts").get()!.n,
        ),
      };
    case "putMedia": {
      const old = read<Media>("SELECT json FROM media WHERE id=?", r.input.id);
      if (old) {
        if (old.sha256 !== r.input.sha256)
          throw new DomainError("IDEMPOTENCY_MISMATCH", "media");
        return old;
      }
      db.prepare("INSERT INTO media VALUES(?,?)").run(
        r.input.id,
        JSON.stringify(r.input),
      );
      return r.input;
    }
    case "getMedia":
      return read<Media>("SELECT json FROM media WHERE id=?", r.input);
    case "createSource":
      speaker(r.input.speaker);
      db.prepare("INSERT INTO sources VALUES(?,?,?,?,?)").run(
        r.input.id,
        r.input.sessionId,
        r.input.mediaId,
        r.input.status,
        JSON.stringify(r.input),
      );
      return r.input;
    case "getSource":
      return read<Source>("SELECT json FROM sources WHERE id=?", r.input);
    case "getDraft":
      return read<Source>(
        "SELECT json FROM sources WHERE session_id=? AND status='draft'",
        r.input,
      );
    case "saveDraft": {
      const v = source(r.input.id);
      if (v.status !== "draft" || v.draftRevision !== r.input.expectedRevision)
        throw new DomainError("REVISION_CONFLICT", "draft");
      if (r.input.text.length > 16000)
        throw new DomainError("INVALID_INPUT", "draft too long");
      return saveSource({
        ...v,
        draft: r.input.text,
        draftRevision: v.draftRevision + 1,
      });
    }
    case "setSpeaker": {
      const v = source(r.input.id);
      if (v.status !== "draft" || v.draftRevision !== r.input.expectedRevision)
        throw new DomainError("REVISION_CONFLICT", "speaker");
      return saveSource({
        ...v,
        speaker: speaker(r.input.speaker),
        draftRevision: v.draftRevision + 1,
      });
    }
    case "cancelSource": {
      const v = source(r.input);
      if (v.status === "submitted")
        throw new DomainError(
          "ALREADY_SUBMITTED",
          "cannot cancel accepted source",
        );
      return saveSource({ ...v, status: "cancelled" });
    }
    case "listTranscripts":
      return db
        .prepare(
          "SELECT json FROM transcripts WHERE session_id=? ORDER BY rowid LIMIT 100",
        )
        .all(r.input)
        .map((v) => JSON.parse(String(v.json)));
    case "acceptHuman":
      return transaction(() => {
        const i = r.input;
        const b = branch(i.sessionId);
        if (i.role !== "user" || i.sourceKind !== "user")
          return {
            transcript: null,
            branch: b,
            duplicate: false,
            blocked: false,
          };
        if (!i.messageId || !i.requestId || i.text.length > 16000)
          throw new DomainError("INVALID_INPUT", "human identity/size");
        const old = read<TranscriptSegment>(
          "SELECT json FROM transcripts WHERE session_id=? AND (message_id=? OR request_id=?)",
          i.sessionId,
          i.messageId,
          i.requestId,
        );
        if (old) {
          if (old.text !== parseSourceReference(i.text).text)
            throw new DomainError(
              "IDEMPOTENCY_MISMATCH",
              "human request content changed",
            );
          return {
            transcript: old,
            branch: b,
            duplicate: true,
            blocked: b?.state === "closed",
          };
        }
        if (b && b.state !== "active")
          return {
            transcript: null,
            branch: b,
            duplicate: false,
            blocked: true,
          };
        const ref = parseSourceReference(i.text);
        if (!ref.text.trim())
          throw new DomainError("INVALID_INPUT", "empty answer");
        let s: Source;
        if (ref.sourceId) {
          s = source(ref.sourceId);
          if (s.sessionId !== i.sessionId)
            throw new DomainError(
              "SOURCE_SESSION_MISMATCH",
              "source belongs to another session",
            );
          if (s.status !== "draft")
            throw new DomainError(
              "SOURCE_NOT_DRAFT",
              "source already used or cancelled",
            );
        } else {
          // Typed statements have no media or fabricated audio timestamp.
          s = {
            id: randomUUID() as SourceId,
            sessionId: i.sessionId,
            mediaId: null,
            rawAsr: "",
            draft: ref.text,
            draftRevision: 0,
            speaker: read<Source["speaker"]>(
              "SELECT json FROM session_speakers WHERE session_id=?",
              i.sessionId,
            ) ?? { role: "self", authority: "explicit-user" },
            status: "cancelled",
            createdAt: Date.now(),
          };
          db.prepare("INSERT INTO sources VALUES(?,?,?,?,?)").run(
            s.id,
            s.sessionId,
            s.mediaId,
            s.status,
            JSON.stringify(s),
          );
        }
        if (b && b.state !== "active")
          return {
            transcript: null,
            branch: b,
            duplicate: false,
            blocked: true,
          };
        const t: TranscriptSegment = {
          id: randomUUID(),
          sourceId: s.id,
          sessionId: i.sessionId,
          messageId: i.messageId,
          requestId: i.requestId,
          text: ref.text,
          rawAsr: s.rawAsr,
          speaker: s.speaker,
          createdAt: Date.now(),
          correction: s.rawAsr !== "" && s.rawAsr !== ref.text,
        };
        db.prepare("INSERT INTO transcripts VALUES(?,?,?,?,?,?)").run(
          t.id,
          s.id,
          i.sessionId,
          i.messageId,
          i.requestId,
          JSON.stringify(t),
        );
        saveSource({ ...s, status: "submitted", draft: ref.text });
        if (b) {
          db.prepare("INSERT INTO branch_answers VALUES(?,?,?,?)").run(
            b.id,
            i.messageId,
            i.requestId,
            t.id,
          );
          b.answerCount++;
          if (b.answerCount === 5) {
            b.state = "closed";
            b.memo = {
              title: "支线验证",
              key_sentence: "五次用户回答已保存",
              summary: "确定性 Phase 1 生命周期记录；未调用模型生成摘要。",
              source_turns: db
                .prepare(
                  "SELECT transcript_id FROM branch_answers WHERE branch_id=? ORDER BY rowid",
                )
                .all(b.id)
                .map((v) => String(v.transcript_id)),
              related_memory_nodes: [],
              new_memory_candidates: [],
              people: [],
              places: [],
              time: null,
              unresolved_questions: [],
              suggested_return_bridge: "这段故事已经保存，我们回到刚才的话题。",
            };
          }
          saveBranch(b);
        }
        return {
          transcript: t,
          branch: b,
          duplicate: false,
          blocked: b?.state === "closed",
        };
      });
    case "putMemory":
      return transaction(() => {
        const n = r.input.node;
        const latest = db
          .prepare("SELECT revision FROM memory_current WHERE id=?")
          .get(n.id);
        const current = latest ? Number(latest.revision) : 0;
        if (current !== r.input.expectedRevision || n.revision !== current + 1)
          throw new DomainError("REVISION_CONFLICT", "memory");
        if (
          !n.keySentence.trim() ||
          n.keySentence.length > 120 ||
          !["stated", "inferred", "disputed"].includes(n.time.certainty) ||
          !["month", "year", "decade", "approximate", "unknown"].includes(
            n.time.precision,
          )
        )
          throw new DomainError("INVALID_INPUT", "memory fields");
        if (
          n.placement === "drifting" &&
          (n.time.start !== null || n.time.end !== null)
        )
          throw new DomainError(
            "INVALID_TIME",
            "drifting time must be unknown",
          );
        if (
          n.placement === "anchored" &&
          (n.time.start === null ||
            n.time.end === null ||
            !Number.isInteger(n.time.start) ||
            !Number.isInteger(n.time.end) ||
            n.time.start > n.time.end)
        )
          throw new DomainError("INVALID_TIME", "invalid anchor");
        db.prepare("INSERT INTO memory_revisions VALUES(?,?,?,?)").run(
          n.id,
          n.revision,
          n.transcriptId,
          JSON.stringify(n),
        );
        db.prepare(
          "INSERT INTO memory_current VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
        ).run(n.id, n.revision);
        return n;
      });
    case "getMemory":
      return read<MemoryNode>(
        "SELECT r.json FROM memory_revisions r JOIN memory_current c ON r.id=c.id AND r.revision=c.revision WHERE r.id=?",
        r.input,
      );
    case "listMemories":
      if (
        !Number.isInteger(r.input.limit) ||
        r.input.limit < 1 ||
        r.input.limit > 50
      )
        throw new DomainError("INVALID_INPUT", "limit 1..50");
      return db
        .prepare(
          "SELECT r.json FROM memory_revisions r JOIN memory_current c ON r.id=c.id AND r.revision=c.revision WHERE r.id>? ORDER BY r.id LIMIT ?",
        )
        .all(r.input.after ?? "", r.input.limit)
        .map((v) => JSON.parse(String(v.json)));
    case "reserveBranch":
      db.prepare("INSERT INTO branches VALUES(?,?,?,?,?,?)").run(
        r.input.id,
        r.input.parentSessionId,
        r.input.sessionId,
        r.input.state,
        r.input.answerCount,
        JSON.stringify(r.input),
      );
      return r.input;
    case "activateBranch": {
      const b = branch(r.input);
      if (!b) throw new DomainError("NOT_FOUND", "branch");
      if (b.state === "closed") return b;
      return saveBranch({ ...b, state: "active" });
    }
    case "getParentBranch":
      return read<Branch>(
        "SELECT json FROM branches WHERE parent_session_id=? AND state IN ('active','provisioning')",
        r.input,
      );
    case "getBranch":
      return branch(r.input);
    case "close":
      db.close();
      return null;
  }
}
port.on("message", (request: WorkerRequest) => {
  try {
    const value = handle(request);
    port.postMessage({
      id: request.id,
      ok: true,
      value,
    } satisfies WorkerResponse);
    if (request.method === "close") port.close();
  } catch (error) {
    port.postMessage({
      id: request.id,
      ok: false,
      code: error instanceof DomainError ? error.code : "DATABASE_ERROR",
      message:
        error instanceof Error ? error.message : "database operation failed",
    } satisfies WorkerResponse);
  }
});

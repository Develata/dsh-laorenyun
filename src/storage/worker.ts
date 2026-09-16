import { randomInt } from "node:crypto";
import { schedule, type Region } from "../memory/scheduler.ts";
import { parseMemo, partialMemo } from "../memory/branch.ts";
import { GraphStorage } from "../memory/storage.ts";
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
const graph = new GraphStorage(db);
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
    case "branchContext": {
      const b = branch(r.input);
      if (!b?.proposalTranscriptId)
        throw new DomainError("NOT_FOUND", "branch proposal source");
      const t = graph.transcript(b.proposalTranscriptId);
      if (t.sessionId !== b.parentSessionId)
        throw new DomainError("INVALID_SOURCE", "branch parent");
      const memories = db
        .prepare(
          "SELECT DISTINCT r.id,json_extract(r.json,'$.keySentence') keySentence FROM source_refs s JOIN memory_revisions r ON r.id=s.node_id AND r.revision=s.revision JOIN memory_current c ON c.id=r.id AND c.revision=r.revision WHERE s.transcript_id=? LIMIT 6",
        )
        .all(t.id)
        .map((n) => ({ id: String(n.id), keySentence: String(n.keySentence) }));
      return {
        source: { id: t.id, text: t.text.slice(0, 2000), speaker: t.speaker },
        memories,
      };
    }
    case "branchProposal":
      return transaction(() => {
        const i = r.input,
          t = graph.transcript(i.transcriptId);
        if (
          t.sessionId !== i.parentSessionId ||
          branch(i.parentSessionId) ||
          !i.topic.trim() ||
          i.topic.length > 120 ||
          i.returnAnchor.length > 500
        )
          throw new DomainError("INVALID_BRANCH", "bounded Main proposal");
        const existing = read<Branch>(
          "SELECT json FROM branches WHERE parent_session_id=? AND state IN ('proposed','provisioning','active','closing')",
          i.parentSessionId,
        );
        if (existing) return existing;
        const b: Branch = {
          id: randomUUID() as Branch["id"],
          parentSessionId: i.parentSessionId,
          sessionId: randomUUID(),
          state: "proposed",
          answerCount: 0,
          memo: null,
          topic: i.topic,
          returnAnchor: i.returnAnchor,
          proposalTranscriptId: i.transcriptId,
        };
        db.prepare("INSERT INTO branches VALUES(?,?,?,?,?,?)").run(
          b.id,
          b.parentSessionId,
          b.sessionId,
          b.state,
          0,
          JSON.stringify(b),
        );
        return b;
      });
    case "branchConsent":
      return transaction(() => {
        const b = read<Branch>(
          "SELECT json FROM branches WHERE parent_session_id=? AND state IN ('proposed','provisioning','active')",
          r.input.parentSessionId,
        );
        if (!b) throw new DomainError("NOT_FOUND", "proposal");
        if (b.state !== "proposed") return b;
        const t = graph.transcript(r.input.transcriptId),
          latest = read<TranscriptSegment>(
            "SELECT json FROM transcripts WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
            b.parentSessionId,
          );
        if (
          t.sessionId !== b.parentSessionId ||
          latest?.id !== t.id ||
          t.id === b.proposalTranscriptId
        )
          throw new DomainError("CONSENT_REQUIRED", "new human answer");
        if (/不想|不愿|先不|以后|跳过|不要/.test(t.text))
          return saveBranch({ ...b, state: "cancelled" });
        if (
          !/^(好[的啊呀]?|可以|愿意|行|讲讲|说说|那就|嗯|没问题)/.test(
            t.text.trim(),
          )
        )
          throw new DomainError("CONSENT_REQUIRED", "explicit willingness");
        return saveBranch({
          ...b,
          state: "provisioning",
          consentTranscriptId: t.id,
        });
      });
    case "branchClosing": {
      const b = branch(r.input);
      if (!b) throw new DomainError("NOT_FOUND", "branch");
      return b.state === "active" ? saveBranch({ ...b, state: "closing" }) : b;
    }
    case "branchMemo":
      return transaction(() => {
        const b = branch(r.input.sessionId);
        if (!b) throw new DomainError("NOT_FOUND", "branch");
        if (b.state === "closed") return b;
        if (b.state !== "closing")
          throw new DomainError("BRANCH_STATE", "memo only while closing");
        const sourceTurns = db
          .prepare(
            "SELECT transcript_id FROM branch_answers WHERE branch_id=? ORDER BY rowid",
          )
          .all(b.id)
          .map((v) => String(v.transcript_id));
        const input = {
          topic: b.topic ?? "支线",
          sourceTurns,
          relatedNodes: [] as string[],
          inputRevision: b.answerCount,
        };
        const memo =
          r.input.memo.status === "partial"
            ? partialMemo(input)
            : parseMemo(JSON.stringify(r.input.memo), input);
        db.prepare("INSERT INTO branch_memos VALUES(?,?)").run(
          b.id,
          JSON.stringify(memo),
        );
        return saveBranch({
          ...b,
          memo,
          state: "closed",
          ...(r.input.evidence ? { memoGeneration: r.input.evidence } : {}),
        });
      });
    case "branchPending":
      return db
        .prepare(
          "SELECT json FROM branches WHERE json_extract(json,'$.topic') IS NOT NULL AND (state IN ('provisioning','closing') OR (state='closed' AND coalesce(json_extract(json,'$.returned'),0)=0)) LIMIT 10",
        )
        .all()
        .map((v) => JSON.parse(String(v.json)));
    case "branchReturned": {
      const b = branch(r.input);
      if (b) saveBranch({ ...b, returned: true });
      return null;
    }
    case "schedule":
      return transaction(() => {
        const i = r.input,
          t = graph.transcript(i.transcriptId);
        if (t.sessionId !== i.sessionId)
          throw new DomainError("INVALID_SOURCE", "scheduler testimony");
        const id = "schedule:" + i.transcriptId,
          prior = read<ReturnType<typeof schedule>>(
            "SELECT json FROM scheduler_decisions WHERE id=?",
            id,
          );
        if (prior) return prior;
        if (
          i.currentMonth !== null &&
          (!Number.isInteger(i.currentMonth) || i.currentMonth < 0)
        )
          throw new DomainError("INVALID_TIME", "current region");
        const now = new Date(),
          end = now.getUTCFullYear() * 12 + now.getUTCMonth();
        const bounds = db
          .prepare(
            "SELECT min(json_extract(r.json,'$.time.start')) lo FROM memory_revisions r JOIN memory_current c USING(id,revision) WHERE json_extract(r.json,'$.status')='confirmed'",
          )
          .get();
        const lo = bounds?.lo == null ? null : Number(bounds.lo);
        const regions: Region[] = [];
        const turn = Number(
          db
            .prepare("SELECT count(*) n FROM transcripts WHERE session_id=?")
            .get(i.sessionId)!.n,
        );
        if (
          i.currentMonth !== null &&
          /不想谈|以后再说|先跳过|不想说/.test(t.text)
        )
          db.prepare(
            "INSERT INTO interview_deferrals VALUES(?,?,?,?) ON CONFLICT(session_id,region) DO UPDATE SET until_turn=excluded.until_turn,transcript_id=excluded.transcript_id",
          ).run(
            i.sessionId,
            String(Math.floor(i.currentMonth / 120) * 120),
            turn + 8,
            t.id,
          );
        if (lo !== null) {
          const start = Math.floor(lo / 120) * 120;
          const width = Math.max(
            120,
            Math.ceil((end - start + 1) / 12 / 120) * 120,
          );
          for (let m = start; m <= end && regions.length < 12; m += width) {
            const hi = Math.min(end, m + width - 1),
              mid = Math.floor((m + hi) / 2);
            const row = db
              .prepare(
                `SELECT count(*) n,min(max(0,json_extract(r.json,'$.time.start')-?,?-json_extract(r.json,'$.time.end'))) gap FROM memory_revisions r JOIN memory_current c USING(id,revision) WHERE json_extract(r.json,'$.status')='confirmed' AND json_extract(r.json,'$.time.start') IS NOT NULL`,
              )
              .get(mid, mid)!;
            const n = Number(
              db
                .prepare(
                  "SELECT count(*) n FROM memory_revisions r JOIN memory_current c USING(id,revision) WHERE json_extract(r.json,'$.status')='confirmed' AND json_extract(r.json,'$.time.start')<=? AND json_extract(r.json,'$.time.end')>=?",
                )
                .get(hi, m)!.n,
            );
            const unresolved = Number(
              db
                .prepare(
                  "SELECT count(*) n FROM (SELECT f.id FROM conflicts f JOIN memory_revisions r ON r.id=f.left_id AND r.revision=f.left_revision WHERE f.status='open' AND json_extract(r.json,'$.time.start')<=? AND json_extract(r.json,'$.time.end')>=? UNION ALL SELECT r.id FROM memory_revisions r JOIN memory_current c USING(id,revision) WHERE json_extract(r.json,'$.status')='candidate' AND json_extract(r.json,'$.time.start')<=? AND json_extract(r.json,'$.time.end')>=?)",
                )
                .get(hi, m, hi, m)!.n,
            );
            regions.push({
              id: String(m),
              start: m,
              end: hi,
              n,
              gap: Number(row.gap ?? 120),
              unresolved,
            });
          }
        }
        const deferred = db
          .prepare(
            "SELECT region FROM interview_deferrals WHERE session_id=? AND until_turn>?",
          )
          .all(i.sessionId, turn)
          .map((v) => String(v.region));
        const result = schedule({
          graphRevision: graph.revision(),
          regions,
          currentMonth:
            i.currentMonth ?? graph.region(i.sessionId)?.start ?? null,
          deferred: deferred.includes("*")
            ? regions.map((r) => r.id)
            : deferred,
          seed: randomInt(1, 2147483647),
          boundary: i.boundary,
          userChoseTopic: i.userChoseTopic,
        });
        db.prepare("INSERT INTO scheduler_decisions VALUES(?,?,?)").run(
          id,
          i.sessionId,
          JSON.stringify(result),
        );
        return result;
      });
    case "memoryRecover":
      graph.recover();
      return null;
    case "memoryClaim":
      return graph.claim();
    case "memoryProposal":
      graph.saveProposal(r.input.id, r.input.result, r.input.evidence);
      return null;
    case "memoryApply":
      return graph.apply(r.input.id, r.input.expected);
    case "memoryRetry":
      graph.retry(r.input);
      return null;
    case "memoryFail":
      graph.fail(r.input.id, r.input.code);
      return null;
    case "memoryOperation":
      return graph.operation(r.input);
    case "timeline":
      return graph.query(r.input);
    case "graphIntegrity":
      return graph.integrity();
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
      if (
        read(
          "SELECT json FROM sources WHERE session_id=? AND status='draft'",
          r.input.sessionId,
        )
      )
        throw new DomainError("DRAFT_EXISTS", "finish existing source draft");
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
            blocked: b?.state === "closed" || b?.state === "closing",
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
        graph.enqueue(t);
        graph.defer(t);
        if (
          !b &&
          /^(这个(?:话题|故事)?(?:我)?|今天|还是)?(不想|不愿|先不|以后再|先跳过|不要)/.test(
            t.text.trim(),
          )
        ) {
          const proposed = read<Branch>(
            "SELECT json FROM branches WHERE parent_session_id=? AND state='proposed'",
            i.sessionId,
          );
          if (proposed) saveBranch({ ...proposed, state: "cancelled" });
        }
        if (b) {
          db.prepare("INSERT INTO branch_answers VALUES(?,?,?,?)").run(
            b.id,
            i.messageId,
            i.requestId,
            t.id,
          );
          b.answerCount++;
          if (b.answerCount === 5 && b.topic) {
            b.state = "closing";
          } else if (b.answerCount === 5) {
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
          blocked: b?.state === "closed" || b?.state === "closing",
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
        graph.bump();
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
        "SELECT json FROM branches WHERE parent_session_id=? AND state IN ('proposed','active','provisioning','closing')",
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

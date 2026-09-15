/** Synchronous domain statements. Imported only by the SQLite worker. */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { DomainError, type TranscriptSegment } from "../domain/types.ts";
import {
  parseExtraction,
  validateProposal,
  verifyEvidence,
} from "./validate.ts";
import type {
  Conflict,
  Entity,
  Evidence,
  ExtractionInput,
  ExtractionOperation,
  ExtractionResult,
  GraphNode,
  Page,
  TimelineQuery,
} from "./types.ts";
export class GraphStorage {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  revision(): number {
    return Number(
      this.db
        .prepare("SELECT revision FROM graph_metadata WHERE singleton=1")
        .get()!.revision,
    );
  }
  bump(): void {
    this.db.exec(
      "UPDATE graph_metadata SET revision=revision+1 WHERE singleton=1",
    );
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  json<T>(sql: string, ...args: SQLInputValue[]): T | null {
    const r = this.db.prepare(sql).get(...args);
    return r ? (JSON.parse(String(r.json)) as T) : null;
  }
  node(id: string, revision?: number): GraphNode | null {
    return this.json(
      revision
        ? "SELECT json FROM memory_revisions WHERE id=? AND revision=?"
        : "SELECT r.json FROM memory_revisions r JOIN memory_current c USING(id,revision) WHERE r.id=?",
      ...(revision ? [id, revision] : [id]),
    );
  }
  transcript(id: string): TranscriptSegment {
    const t = this.json<TranscriptSegment>(
      "SELECT json FROM transcripts WHERE id=?",
      id,
    );
    if (!t) throw new DomainError("DANGLING_SOURCE", "transcript");
    return t;
  }
  enqueue(t: TranscriptSegment): void {
    const hash = createHash("sha256")
      .update(JSON.stringify({ id: t.id, text: t.text }))
      .digest("hex");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memory_extraction_operations(id,transcript_id,input_hash,state) VALUES(?,?,?,'pending')",
      )
      .run("extract:" + t.id, t.id, hash);
  }
  recover(): void {
    this.tx(() => {
      this.db.exec(
        "UPDATE memory_extraction_operations SET state=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,error='PROCESS_INTERRUPTED' WHERE state='running'",
      );
      // Old accepted testimony is queued durably without copying the life archive into JS.
      const rows = this.db
        .prepare(
          "SELECT t.json FROM transcripts t LEFT JOIN memory_extraction_operations o ON t.id=o.transcript_id WHERE o.id IS NULL LIMIT 50",
        )
        .all();
      for (const r of rows) this.enqueue(JSON.parse(String(r.json)));
    });
  }
  operation(id: string): ExtractionOperation | null {
    const r = this.db
      .prepare("SELECT * FROM memory_extraction_operations WHERE id=?")
      .get(id);
    return r
      ? {
          id: String(r.id),
          transcriptId: String(r.transcript_id),
          inputHash: String(r.input_hash),
          state: r.state as ExtractionOperation["state"],
          attempts: Number(r.attempts),
          graphRevision: Number(r.graph_revision),
          ...(r.result ? { result: JSON.parse(String(r.result)) } : {}),
          ...(r.error ? { error: String(r.error) } : {}),
        }
      : null;
  }
  claim(): ExtractionInput | null {
    return this.tx(() => {
      let row = this.db
        .prepare(
          "SELECT id FROM memory_extraction_operations WHERE state IN ('pending','proposed','validated') ORDER BY rowid LIMIT 1",
        )
        .get();
      if (!row) {
        const legacy = this.db
          .prepare(
            "SELECT t.json FROM transcripts t LEFT JOIN memory_extraction_operations o ON o.transcript_id=t.id WHERE o.id IS NULL LIMIT 50",
          )
          .all();
        for (const r of legacy) this.enqueue(JSON.parse(String(r.json)));
        row = this.db
          .prepare(
            "SELECT id FROM memory_extraction_operations WHERE state='pending' ORDER BY rowid LIMIT 1",
          )
          .get();
        if (!row) return null;
      }
      const op = this.operation(String(row.id))!;
      const t = this.transcript(op.transcriptId);
      const hash = createHash("sha256")
        .update(JSON.stringify({ id: t.id, text: t.text }))
        .digest("hex");
      if (hash !== op.inputHash)
        throw new DomainError("INPUT_CHANGED", "immutable transcript hash");
      // A durable proposal retains the exact graph version and whitelist used
      // by its model call. Recovery must not silently rebase an old result.
      if (op.result)
        return { operation: op, transcript: t, candidates: [], conflicts: [] };
      this.db
        .prepare(
          "UPDATE memory_extraction_operations SET state=?,attempts=attempts+1,graph_revision=? WHERE id=?",
        )
        .run(op.result ? "proposed" : "running", this.revision(), op.id);
      // Cheap time/lexical signals; at most 12 candidate bodies reach the internal model.
      const year = /(\d{4})年/.exec(t.text)?.[1];
      const candidates = this.db
        .prepare(
          `SELECT r.json FROM memory_revisions r JOIN memory_current c USING(id,revision)
      WHERE (? IS NOT NULL AND json_extract(r.json,'$.time.start')<=? AND json_extract(r.json,'$.time.end')>=?)
      OR EXISTS(SELECT 1 FROM node_people np JOIN people p ON p.id=np.entity_id WHERE np.node_id=r.id AND np.revision=r.revision AND instr(?,p.name)>0)
      OR EXISTS(SELECT 1 FROM node_places np JOIN places p ON p.id=np.entity_id WHERE np.node_id=r.id AND np.revision=r.revision AND instr(?,p.name)>0)
      OR instr(?,json_extract(r.json,'$.keySentence'))>0
      OR (json_extract(r.json,'$.placement')='drifting' AND EXISTS(SELECT 1 FROM source_refs s JOIN transcripts t ON t.id=s.transcript_id WHERE s.node_id=r.id AND t.session_id=?))
      ORDER BY r.rowid DESC LIMIT 12`,
        )
        .all(
          year ?? null,
          year ? Number(year) * 12 + 11 : null,
          year ? Number(year) * 12 : null,
          t.text,
          t.text,
          t.text,
          t.sessionId,
        )
        .map((r) => {
          const n = JSON.parse(String(r.json)) as GraphNode;
          return {
            id: n.id,
            revision: n.revision,
            keySentence: n.keySentence,
            time: n.time,
            placement: n.placement,
            status: n.status,
            people: n.people ?? [],
            places: n.places ?? [],
          };
        });
      const conflicts = this.db
        .prepare(
          "SELECT json FROM conflicts WHERE status='open' ORDER BY rowid DESC LIMIT 5",
        )
        .all()
        .map((r) => JSON.parse(String(r.json)) as Conflict);
      this.db
        .prepare(
          "UPDATE memory_extraction_operations SET input_snapshot=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            candidates: [
              ...candidates.map((n) => ({ id: n.id, revision: n.revision })),
              ...conflicts.flatMap((c) => [c.left, c.right]),
            ],
            conflicts: conflicts.map((c) => c.id),
          }),
          op.id,
        );
      return {
        operation: this.operation(op.id)!,
        transcript: t,
        candidates,
        conflicts,
      };
    });
  }
  saveProposal(
    id: string,
    result: ExtractionResult,
    evidence?: { model: string; latencyMs: number; repairs: number },
  ): void {
    parseExtraction(JSON.stringify(result));
    const r = this.db
      .prepare(
        "UPDATE memory_extraction_operations SET state='proposed',result=?,error=NULL,model_evidence=? WHERE id=? AND state IN ('running','proposed')",
      )
      .run(
        JSON.stringify(result),
        evidence ? JSON.stringify(evidence) : null,
        id,
      );
    if (!r.changes)
      throw new DomainError("OPERATION_STATE", "proposal receipt");
  }
  retry(id: string): void {
    const op = this.operation(id);
    if (!op || op.state !== "failed" || op.attempts >= 3)
      throw new DomainError(
        "RETRY_LIMIT",
        "failed operation allows at most three attempts",
      );
    this.db
      .prepare(
        "UPDATE memory_extraction_operations SET state='pending',result=NULL,error=NULL WHERE id=?",
      )
      .run(id);
  }
  defer(t: TranscriptSegment): void {
    if (!/不想谈|以后再说|先跳过|不想说/.test(t.text)) return;
    const row = this.json<{ selected: { id: string } | null }>(
      "SELECT json FROM scheduler_decisions WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
      t.sessionId,
    );
    const count = Number(
      this.db
        .prepare("SELECT count(*) n FROM transcripts WHERE session_id=?")
        .get(t.sessionId)!.n,
    );
    this.db
      .prepare(
        "INSERT INTO interview_deferrals VALUES(?,?,?,?) ON CONFLICT(session_id,region) DO UPDATE SET until_turn=excluded.until_turn,transcript_id=excluded.transcript_id",
      )
      .run(t.sessionId, row?.selected?.id ?? "*", count + 8, t.id);
  }
  fail(id: string, code: string): void {
    this.db
      .prepare(
        "UPDATE memory_extraction_operations SET state='failed',error=? WHERE id=? AND state<>'applied'",
      )
      .run(code.slice(0, 80), id);
  }
  entity(
    table: "people" | "places",
    e: { name: string; identity: "explicit" | "ambiguous"; reuseId?: string },
    candidates: Set<string>,
  ): string {
    // Exact spelling alone is not identity. Only an explicit ID already visible in candidate context may be reused.
    if (e.reuseId) {
      const old = this.db
        .prepare(`SELECT * FROM ${table} WHERE id=?`)
        .get(e.reuseId);
      if (
        !old ||
        !candidates.has(e.reuseId) ||
        old.name !== e.name ||
        old.identity !== "explicit" ||
        e.identity !== "explicit"
      )
        throw new DomainError("IDENTITY_UNCERTAIN", "entity reuse");
      return e.reuseId;
    }
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO ${table} VALUES(?,?,?)`)
      .run(id, e.name, e.identity);
    return id;
  }
  write(n: GraphNode): void {
    const impossible = this.db
      .prepare(
        `SELECT 1 FROM memory_edges e
      JOIN memory_revisions r JOIN memory_current c ON c.id=r.id AND c.revision=r.revision
      WHERE e.kind='PRECEDES' AND
      ((e.from_id=? AND r.id=e.to_id AND ? > json_extract(r.json,'$.time.end')) OR
       (e.to_id=? AND r.id=e.from_id AND json_extract(r.json,'$.time.start') > ?)) LIMIT 1`,
      )
      .get(n.id, n.time.start, n.id, n.time.end);
    if (impossible)
      throw new DomainError(
        "INVALID_EDGE",
        "revision contradicts existing temporal order",
      );
    this.db
      .prepare("INSERT INTO memory_revisions VALUES(?,?,?,?)")
      .run(n.id, n.revision, n.transcriptId, JSON.stringify(n));
    this.db
      .prepare(
        "INSERT INTO memory_current VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
      )
      .run(n.id, n.revision);
    for (const e of n.evidence)
      this.db
        .prepare("INSERT OR IGNORE INTO source_refs VALUES(?,?,?,?,?)")
        .run(n.id, n.revision, e.transcriptId, e.field, e.text);
    for (const table of ["people", "places"] as const)
      for (const id of new Set(n[table]))
        this.db
          .prepare(`INSERT INTO node_${table} VALUES(?,?,?)`)
          .run(n.id, n.revision, id);
  }
  apply(
    id: string,
    expected: number,
  ): { graphRevision: number; nodeIds: string[] } {
    return this.tx(() => {
      const op = this.operation(id);
      if (!op) throw new DomainError("NOT_FOUND", "operation");
      if (op.state === "applied")
        return { graphRevision: this.revision(), nodeIds: [] };
      if (this.revision() !== expected)
        throw new DomainError("REVISION_CONFLICT", "graph compare-and-swap");
      if (!op.result || !["proposed", "validated"].includes(op.state))
        throw new DomainError("OPERATION_STATE", "apply");
      const result = parseExtraction(JSON.stringify(op.result)),
        t = this.transcript(op.transcriptId);
      // New claims must reference this immutable input, never arbitrary old testimony or summaries.
      const snapshotRow = this.db
        .prepare(
          "SELECT input_snapshot FROM memory_extraction_operations WHERE id=?",
        )
        .get(id)!;
      const snapshot = JSON.parse(String(snapshotRow.input_snapshot)) as {
        candidates: { id: string; revision: number }[];
        conflicts: string[];
      };
      for (const c of result.comparisons)
        if (
          !snapshot.candidates.some(
            (n) => n.id === c.nodeId && n.revision === c.revision,
          )
        )
          throw new DomainError(
            "INVALID_COMPARISON",
            "not in bounded input snapshot",
          );
      for (const p of result.proposals)
        if (p.targetId && !snapshot.candidates.some((n) => n.id === p.targetId))
          throw new DomainError(
            "INVALID_TARGET",
            "not in bounded input snapshot",
          );
      for (const r of result.resolutions)
        if (!snapshot.conflicts.includes(r.conflictId))
          throw new DomainError(
            "INVALID_RESOLUTION",
            "not in bounded input snapshot",
          );
      const transcripts = new Map([[t.id, t]]);
      const ids: string[] = [];
      for (const p of result.proposals) validateProposal(p, transcripts);
      this.db
        .prepare(
          "UPDATE memory_extraction_operations SET state='validated' WHERE id=?",
        )
        .run(id);
      for (const [index, p] of result.proposals.entries()) {
        // Explicit resolution creates the revision below. Do not duplicate its
        // selected claim from a model that also repeats it as a proposal.
        if (
          p.targetId &&
          result.resolutions.some((r) => r.selectedNodeId === p.targetId)
        )
          continue;
        let comparisons = result.comparisons.filter(
          (c) => c.proposal === index,
        );
        for (const c of comparisons)
          if (this.node(c.nodeId)?.revision !== c.revision)
            throw new DomainError("REVISION_CONFLICT", "comparison revision");
        const withoutDate = (v: string) =>
          v
            .replace(
              /(?:可能|大约|约)?[0-9一二三四五六七八九十零〇或]+年(?:代)?(?:[0-9一二三四五六七八九十]+月)?/g,
              "",
            )
            .replace(/[，。,.\s]/g, "");
        comparisons = comparisons.map((c) => {
          const other = this.node(c.nodeId)!;
          const overlap =
            p.time.start !== null &&
            other.time.start !== null &&
            p.time.start <= other.time.end! &&
            other.time.start <= p.time.end!;
          return overlap &&
            withoutDate(p.keySentence) === withoutDate(other.keySentence) &&
            ["material_conflict", "possible_conflict"].includes(c.verdict)
            ? { ...c, verdict: "not_conflict" as const }
            : c;
        });
        let old = p.targetId ? this.node(p.targetId) : null;
        if (p.targetId && !old)
          throw new DomainError("NOT_FOUND", "target node");
        if (
          old &&
          !(
            old.keySentence === p.keySentence ||
            (old.placement === "drifting" &&
              p.time.start !== null &&
              comparisons.some(
                (c) => c.nodeId === old!.id && c.verdict === "duplicate",
              ))
          )
        )
          throw new DomainError(
            "UNSAFE_MERGE",
            "only supported duplicate or later anchor may revise",
          );
        if (
          old &&
          comparisons.some(
            (c) =>
              c.verdict.includes("conflict") && c.verdict !== "not_conflict",
          )
        )
          throw new DomainError(
            "UNSAFE_MERGE",
            "conflicting testimony must stay separate",
          );
        if (!old) {
          // Exact extractive repeat is safe only with same speaker provenance and compatible time.
          const r = this.db
            .prepare(
              `SELECT r.json FROM memory_revisions r JOIN memory_current c USING(id,revision) JOIN transcripts t ON t.id=r.transcript_id WHERE json_extract(r.json,'$.keySentence')=? AND json_extract(t.json,'$.speaker')=json(?) LIMIT 1`,
            )
            .get(p.keySentence, JSON.stringify(t.speaker));
          const n = r ? (JSON.parse(String(r.json)) as GraphNode) : null;
          if (n && n.time.start === p.time.start && n.time.end === p.time.end)
            old = n;
        }
        const allowedPeople = new Set(old?.people ?? []),
          allowedPlaces = new Set(old?.places ?? []);
        // Reuse only IDs belonging to verified comparison/target candidates.
        for (const c of comparisons) {
          const n = this.node(c.nodeId)!;
          n.people?.forEach((x) => allowedPeople.add(x));
          n.places?.forEach((x) => allowedPlaces.add(x));
        }
        const status = validateProposal(p, transcripts);
        const n: GraphNode = {
          id: (old?.id ?? randomUUID()) as GraphNode["id"],
          revision: (old?.revision ?? 0) + 1,
          keySentence: p.keySentence,
          time: p.time,
          placement: p.time.start === null ? "drifting" : "anchored",
          transcriptId: t.id,
          basis: p.basis,
          status: comparisons.some(
            (c) =>
              c.verdict === "material_conflict" ||
              c.verdict === "possible_conflict",
          )
            ? "disputed"
            : status,
          people: p.people.map((e) => this.entity("people", e, allowedPeople)),
          places: p.places.map((e) => this.entity("places", e, allowedPlaces)),
          evidence: [...(old?.evidence ?? []), ...p.evidence],
          ...(p.cause ? { cause: p.cause } : {}),
          ...(p.process ? { process: p.process } : {}),
          ...(p.result ? { result: p.result } : {}),
        };
        if (n.evidence.length > 100)
          throw new DomainError("EVIDENCE_LIMIT", "revision evidence cap");
        this.write(n);
        ids.push(n.id);
        for (const e of p.edges)
          this.edge(n.id, e.to, e.kind, e.evidence, transcripts);
        for (const c of comparisons.filter((c) =>
          ["material_conflict", "possible_conflict"].includes(c.verdict),
        )) {
          if (c.nodeId === n.id)
            throw new DomainError("INVALID_CONFLICT", "same claim");
          const other = this.node(c.nodeId, c.revision)!;
          // A broad range containing a narrow range alone cannot be an incompatibility.
          if (other.keySentence === n.keySentence) continue;
          const conflict: Conflict = {
            id: randomUUID(),
            left: { id: other.id, revision: other.revision },
            right: { id: n.id, revision: n.revision },
            status: "open",
            explanation: c.explanation,
          };
          this.db
            .prepare("INSERT INTO conflicts VALUES(?,?,?,?,?,?,?)")
            .run(
              conflict.id,
              other.id,
              other.revision,
              n.id,
              n.revision,
              "open",
              JSON.stringify(conflict),
            );
        }
      }
      for (const r of result.resolutions) {
        verifyEvidence(r.evidence, transcripts);
        const c = this.json<Conflict>(
          "SELECT json FROM conflicts WHERE id=?",
          r.conflictId,
        );
        if (
          !c ||
          c.status !== "open" ||
          ![c.left.id, c.right.id].includes(r.selectedNodeId) ||
          !/(记错|更正|确认|确实|应该是|是.+不是)/.test(r.evidence.text)
        )
          throw new DomainError(
            "INVALID_RESOLUTION",
            "explicit new clarification required",
          );
        const selected = this.node(r.selectedNodeId)!;
        const named = this.db
          .prepare(
            "SELECT p.name FROM node_places n JOIN places p ON p.id=n.entity_id WHERE n.node_id=? AND n.revision=?",
          )
          .all(selected.id, selected.revision);
        if (
          !named.some((x) => r.evidence.text.includes(String(x.name))) &&
          !r.evidence.text.includes(selected.keySentence)
        )
          throw new DomainError(
            "INVALID_RESOLUTION",
            "selected fact must be named explicitly",
          );
        for (const ref of [c.left, c.right]) {
          const current = this.node(ref.id)!;
          if ((current.evidence?.length ?? 0) >= 100)
            throw new DomainError(
              "EVIDENCE_LIMIT",
              "resolution revision evidence",
            );
          this.write({
            ...current,
            revision: current.revision + 1,
            transcriptId: t.id,
            evidence: [...(current.evidence ?? []), r.evidence],
            status:
              current.id === r.selectedNodeId
                ? current.basis === "stated" &&
                  current.time.certainty === "stated"
                  ? "confirmed"
                  : "candidate"
                : "superseded",
          });
        }
        c.status = "resolved";
        c.resolution = {
          transcriptId: t.id,
          text: r.evidence.text,
          selectedNodeId: r.selectedNodeId,
          at: Date.now(),
        };
        this.db
          .prepare("UPDATE conflicts SET status='resolved',json=? WHERE id=?")
          .run(JSON.stringify(c), c.id);
      }
      if (ids.length || result.resolutions.length) this.bump();
      this.db
        .prepare(
          "UPDATE memory_extraction_operations SET state='applied' WHERE id=?",
        )
        .run(id);
      return { graphRevision: this.revision(), nodeIds: ids };
    });
  }
  edge(
    from: string,
    to: string,
    kind: string,
    evidence: Evidence[],
    transcripts: Map<string, TranscriptSegment>,
  ): void {
    if (
      !["PRECEDES", "CAUSES", "ELABORATES", "RELATES_TO"].includes(kind) ||
      from === to
    )
      throw new DomainError("INVALID_EDGE", "kind/self loop");
    const a = this.node(from),
      b = this.node(to);
    if (!a || !b) throw new DomainError("INVALID_EDGE", "missing endpoint");
    evidence.forEach((e) => verifyEvidence(e, transcripts));
    if (
      kind === "CAUSES" &&
      (!evidence.length ||
        !evidence.some((e) => /(因为|所以|导致|因此|使得|影响)/.test(e.text)))
    )
      throw new DomainError(
        "UNSUPPORTED_CAUSE",
        "causality testimony required",
      );
    if (kind === "PRECEDES") {
      if (
        a.time.start !== null &&
        b.time.end !== null &&
        a.time.start > b.time.end
      )
        throw new DomainError("INVALID_EDGE", "impossible temporal order");
      const rows = this.db
        .prepare(
          `WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT e.to_id FROM memory_edges e JOIN reach r ON e.from_id=r.id WHERE e.kind='PRECEDES' LIMIT 10001) SELECT id FROM reach`,
        )
        .all(to);
      if (rows.length > 10000 || rows.some((r) => r.id === from))
        throw new DomainError("PRECEDES_CYCLE", "cycle or traversal budget");
    }
    if (kind === "RELATES_TO" && from > to) [from, to] = [to, from];
    this.db
      .prepare("INSERT OR IGNORE INTO memory_edges VALUES(?,?,?,?,?)")
      .run(
        randomUUID(),
        from,
        to,
        kind,
        JSON.stringify({ evidence, basis: "stated" }),
      );
  }
  query(q: TimelineQuery): Page {
    const rev = this.revision(),
      limit = Math.min(
        q.method === "get_sources"
          ? 10
          : q.method === "get_conflicts" || q.method === "get_unresolved"
            ? 20
            : q.method === "overview"
              ? 12
              : 50,
        q.limit ?? 20,
      );
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      (q.text && q.text.length > 256)
    )
      throw new DomainError("INVALID_QUERY", "bounded query");
    let offset = 0;
    if (q.cursor) {
      const [r, o] = q.cursor.split(":").map(Number);
      if (r !== rev)
        throw new DomainError("REVISION_CONFLICT", "refresh timeline");
      if (!Number.isInteger(o) || o! < 0 || o! > 100000)
        throw new DomainError("INVALID_QUERY", "cursor");
      offset = o!;
    }
    let items: unknown[];
    if (q.method === "get_node") {
      const n = this.node(q.id ?? "", q.revision);
      if (!n) throw new DomainError("NOT_FOUND", "memory");
      return {
        items: [
          {
            ...n,
            evidence: undefined,
            sourceRefs: (n.evidence ?? [])
              .slice(0, 10)
              .map((e) => ({ transcriptId: e.transcriptId, field: e.field })),
            sourcesTruncated: (n.evidence?.length ?? 0) > 10,
          },
        ],
        graphRevision: rev,
        truncated: false,
      };
    }
    if (q.method === "get_sources") {
      const n = this.node(q.id ?? "", q.revision);
      if (!n) throw new DomainError("NOT_FOUND", "memory");
      items = this.db
        .prepare(
          "SELECT DISTINCT t.json FROM source_refs s JOIN transcripts t ON t.id=s.transcript_id WHERE s.node_id=? AND s.revision=? ORDER BY t.id LIMIT ? OFFSET ?",
        )
        .all(n.id, n.revision, limit + 1, offset)
        .map((r) => JSON.parse(String(r.json)));
    } else if (q.method === "get_conflicts") {
      items = this.db
        .prepare(
          "SELECT json FROM conflicts WHERE status='open' AND (? IS NULL OR left_id=? OR right_id=?) ORDER BY id LIMIT ? OFFSET ?",
        )
        .all(q.id ?? null, q.id ?? null, q.id ?? null, limit + 1, offset)
        .map((r) => JSON.parse(String(r.json)));
    } else {
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (
        q.method === "get_period" ||
        q.start !== undefined ||
        q.end !== undefined
      ) {
        if (
          !Number.isInteger(q.start) ||
          !Number.isInteger(q.end) ||
          q.start! > q.end! ||
          q.end! - q.start! > 1200
        )
          throw new DomainError("INVALID_QUERY", "period <=1200 months");
        where.push(
          "json_extract(r.json,'$.time.start')<=? AND json_extract(r.json,'$.time.end')>=?",
        );
        args.push(q.end!, q.start!);
      }
      if (q.method === "get_neighbors") {
        where.push(
          "r.id IN (SELECT to_id FROM memory_edges WHERE from_id=? UNION SELECT from_id FROM memory_edges WHERE to_id=?)",
        );
        args.push(q.id ?? "", q.id ?? "");
      }
      if (q.method === "get_drifting_memories")
        where.push("json_extract(r.json,'$.placement')='drifting'");
      if (q.method === "get_unresolved")
        where.push(
          "json_extract(r.json,'$.status') IN ('candidate','disputed')",
        );
      if (q.text) {
        where.push("instr(json_extract(r.json,'$.keySentence'),?)>0");
        args.push(q.text);
      }
      if (q.status) {
        where.push("json_extract(r.json,'$.status')=?");
        args.push(q.status);
      }
      for (const [table, id] of [
        ["people", q.personId],
        ["places", q.placeId],
      ])
        if (id) {
          where.push(
            `EXISTS(SELECT 1 FROM node_${table} ne WHERE ne.node_id=r.id AND ne.revision=r.revision AND ne.entity_id=?)`,
          );
          args.push(id);
        }
      items = this.db
        .prepare(
          `SELECT r.json FROM memory_revisions r JOIN memory_current c USING(id,revision) ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.id LIMIT ? OFFSET ?`,
        )
        .all(...args, limit + 1, offset)
        .map((r) => {
          const n = JSON.parse(String(r.json)) as GraphNode;
          return {
            id: n.id,
            revision: n.revision,
            keySentence: n.keySentence,
            time: n.time,
            placement: n.placement,
            status: n.status ?? "candidate",
            people: n.people ?? [],
            places: n.places ?? [],
          };
        });
    }
    const truncated = items.length > limit;
    items = items.slice(0, limit);
    // Bound source text by response size; cursor advances only over delivered rows.
    if (q.method === "get_sources") {
      let budget = 8000;
      items = items.map((v) => {
        const t = v as TranscriptSegment;
        const text = t.text.slice(0, Math.max(0, budget));
        budget -= text.length;
        return {
          id: t.id,
          sourceId: t.sourceId,
          text,
          textTruncated: text.length < t.text.length,
          speaker: t.speaker,
        };
      });
    }
    return {
      items,
      graphRevision: rev,
      truncated,
      ...(truncated ? { cursor: `${rev}:${offset + items.length}` } : {}),
    };
  }
  integrity(): string[] {
    const errors = this.db
      .prepare("PRAGMA foreign_key_check")
      .all()
      .map((r) => "foreign_key:" + String(r.table));
    for (const row of this.db
      .prepare(
        "SELECT DISTINCT r.id FROM memory_revisions r LEFT JOIN memory_current c ON c.id=r.id WHERE c.id IS NULL",
      )
      .all())
      errors.push("missing_current:" + String(row.id));
    for (const r of this.db
      .prepare(`SELECT r.json FROM memory_revisions r`)
      .iterate()) {
      const n = JSON.parse(String(r.json)) as GraphNode;
      if (
        (n.time.start === null) !== (n.time.end === null) ||
        (n.time.start !== null && n.time.start > n.time.end!)
      )
        errors.push("invalid_time");
      if (
        n.placement === "drifting" &&
        (n.time.start !== null || n.time.end !== null)
      )
        errors.push("drifting_time");
      for (const e of n.evidence ?? [])
        try {
          verifyEvidence(
            e,
            new Map([[e.transcriptId, this.transcript(e.transcriptId)]]),
          );
        } catch {
          errors.push("source_evidence");
        }
    }
    for (const r of this.db.prepare("SELECT * FROM memory_edges").iterate()) {
      if (r.from_id === r.to_id) errors.push("self_loop");
      if (
        !["PRECEDES", "CAUSES", "ELABORATES", "RELATES_TO"].includes(
          String(r.kind),
        )
      )
        errors.push("edge_kind");
      if (
        r.kind === "PRECEDES" &&
        this.db
          .prepare(
            `WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT to_id FROM memory_edges JOIN reach ON from_id=reach.id WHERE kind='PRECEDES' LIMIT 10001) SELECT id FROM reach WHERE id=?`,
          )
          .get(String(r.to_id), String(r.from_id))
      )
        errors.push("precedes_cycle");
    }
    return errors;
  }
  entities(): { people: Entity[]; places: Entity[] } {
    return {
      people: this.db
        .prepare("SELECT * FROM people LIMIT 50")
        .all() as unknown as Entity[],
      places: this.db
        .prepare("SELECT * FROM places LIMIT 50")
        .all() as unknown as Entity[],
    };
  }
}

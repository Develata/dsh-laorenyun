/** Loaded only in the existing SQLite owner. No model/filesystem work in transactions. */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { GraphStorage } from "../memory/storage.ts";
import {
  DomainError,
  type Source,
  type Media,
  type TranscriptSegment,
} from "../domain/types.ts";
import type { GraphNode } from "../memory/types.ts";
import type { Generation, GenerationSummary, Kind, Manifest } from "./types.ts";
import type {
  RiverQuery,
  RiverSnapshot,
  MemoryDetail,
} from "../river/types.ts";

export class PresentationStorage {
  private db: DatabaseSync;
  private graph: GraphStorage;
  constructor(db: DatabaseSync, graph: GraphStorage) {
    this.db = db;
    this.graph = graph;
  }
  rows<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => JSON.parse(String(r.json)) as T);
  }
  get(id: string): Generation {
    const g = this.rows<Generation>(
      "SELECT json FROM derived_generations WHERE id=?",
      id,
    )[0];
    if (!g) throw new DomainError("NOT_FOUND", "generation");
    return g;
  }
  active(kind: Kind): Generation | null {
    return (
      this.rows<Generation>(
        "SELECT g.json FROM derived_active a JOIN derived_generations g ON g.id=a.generation_id WHERE a.kind=?",
        kind,
      )[0] ?? null
    );
  }
  list(): GenerationSummary[] {
    return this.db
      .prepare(
        `SELECT json_extract(json,'$.id') id,kind,state,json_extract(json,'$.createdAt') createdAt,json_extract(json,'$.progress') progress,json_extract(json,'$.error') error,json_extract(json,'$.manifest.graphRevision') revision,json_array_length(json,'$.manifest.transcripts') sampleCount FROM derived_generations WHERE id IN (SELECT id FROM derived_generations ORDER BY rowid DESC LIMIT 17) OR id IN (SELECT generation_id FROM derived_active) ORDER BY rowid DESC LIMIT 20`,
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        kind: r.kind as Kind,
        state: r.state as GenerationSummary["state"],
        createdAt: Number(r.createdAt),
        progress: String(r.progress),
        ...(r.error ? { error: String(r.error) } : {}),
        stale: Number(r.revision) !== this.graph.revision(),
        sampleCount: Number(r.sampleCount),
      }));
  }
  save(g: Generation): void {
    this.db
      .prepare("UPDATE derived_generations SET state=?,json=? WHERE id=?")
      .run(g.state, JSON.stringify(g), g.id);
  }
  begin(input: {
    id: string;
    kind: Kind;
    sessionId: string;
    route: Generation["route"];
    personaId?: string;
    biographyId?: string;
  }): Generation {
    return this.graph.tx(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM derived_generations WHERE id=?")
          .get(input.id)
      ) {
        const old = this.get(input.id);
        if (old.kind !== input.kind || old.sessionId !== input.sessionId)
          throw new DomainError("IDEMPOTENCY_CONFLICT", "generation identity");
        return old;
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM derived_generations WHERE state IN ('pending','running')",
          )
          .get()
      )
        throw new DomainError(
          "GENERATION_BUSY",
          "one explicit generation at a time",
        );
      const manifest = this.capture(
        input.kind,
        input.personaId,
        input.biographyId,
      );
      const now = Date.now();
      const g: Generation = {
        ...input,
        state: "pending",
        createdAt: now,
        deadline: now + (input.kind === "export" ? 120000 : 300000),
        manifest,
        inputHash: createHash("sha256")
          .update(JSON.stringify(manifest))
          .digest("hex"),
        promptVersion: "phase4-v1",
        progress: "pending",
        result: null,
        candidates: [],
        evidence: [],
      };
      this.db
        .prepare("INSERT INTO derived_generations VALUES(?,?,?,?)")
        .run(g.id, g.kind, g.state, JSON.stringify(g));
      return g;
    });
  }
  capture(kind: Kind, personaId?: string, biographyId?: string): Manifest {
    if (kind === "export") {
      const b = biographyId ? this.get(biographyId) : this.active("biography");
      if (!b || b.kind !== "biography" || b.state !== "published")
        throw new DomainError(
          "BIOGRAPHY_REQUIRED",
          "published generation required",
        );
      const p = b.manifest.persona ? this.get(b.manifest.persona.id) : null;
      const metadata = (g: Generation) => ({
        createdAt: g.createdAt,
        inputHash: g.inputHash,
        model: g.route.model,
        provider: g.route.provider,
        promptVersion: g.promptVersion,
      });
      return {
        ...b.manifest,
        biography: b.result as Manifest["biography"],
        parentGenerationId: b.id,
        biographyMetadata: metadata(b),
        ...(p ? { personaMetadata: metadata(p) } : {}),
      };
    }
    if (
      kind !== "persona" &&
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(sum(length(json)),0) n FROM memory_revisions",
          )
          .get()!.n,
      ) > 1500000
    )
      throw new DomainError(
        "GENERATION_LIMIT",
        "revision snapshot exceeds character budget",
      );
    const nodes =
      kind === "persona"
        ? []
        : this.rows<GraphNode>(
            "SELECT r.json FROM memory_revisions r JOIN memory_current c USING(id,revision) ORDER BY r.id LIMIT 201",
          );
    if (nodes.length > 200)
      throw new DomainError(
        "GENERATION_LIMIT",
        "at most 200 current memories per generation",
      );
    const revisions =
      kind === "persona"
        ? []
        : this.rows<GraphNode>(
            "SELECT r.json FROM memory_revisions r ORDER BY r.id,r.revision LIMIT 1001",
          );
    if (revisions.length > 1000)
      throw new DomainError(
        "GENERATION_LIMIT",
        "at most 1000 historical revisions",
      );
    const ids = new Set(
      revisions.flatMap((n) => [
        n.transcriptId,
        ...(n.evidence ?? []).map((e) => e.transcriptId),
      ]),
    );
    if (ids.size > 500)
      throw new DomainError(
        "GENERATION_LIMIT",
        "at most 500 source transcripts",
      );
    const transcripts =
      kind === "persona"
        ? this.rows<TranscriptSegment>(
            `SELECT t.json FROM transcripts t JOIN sources s ON s.id=t.source_id WHERE s.status='submitted' AND json_extract(t.json,'$.speaker.role')='self' ORDER BY t.rowid DESC LIMIT 80`,
          ).reverse()
        : [...ids].sort().map((id) => this.graph.transcript(id));
    const sources = [...new Set(transcripts.map((t) => t.sourceId))]
      .sort()
      .map(
        (id) =>
          this.rows<Source>("SELECT json FROM sources WHERE id=?", id)[0]!,
      );
    const media: Media[] = [];
    for (const id of [
      ...new Set(
        sources
          .map((s) => s.mediaId)
          .filter((id): id is NonNullable<typeof id> => !!id),
      ),
    ].sort()) {
      const batch = this.rows<Media>(
        "SELECT json FROM media WHERE id=? OR json_extract(json,'$.originalMediaId')=? ORDER BY id LIMIT 101",
        id,
        id,
      );
      if (batch.length > 100 || media.length + batch.length > 1000)
        throw new DomainError("GENERATION_LIMIT", "media metadata cap");
      media.push(...batch);
    }
    const persona = personaId ? this.get(personaId) : null;
    if (
      persona &&
      (persona.kind !== "persona" || persona.state !== "published")
    )
      throw new DomainError("PERSONA_REQUIRED", "published snapshot");
    const m: Manifest = {
      schemaVersion: 1,
      graphRevision: this.graph.revision(),
      createdAt: Date.now(),
      nodes,
      revisions,
      transcripts,
      sources,
      media,
      people:
        kind === "persona"
          ? []
          : (this.db
              .prepare("SELECT * FROM people ORDER BY id LIMIT 2001")
              .all() as unknown as Manifest["people"]),
      places:
        kind === "persona"
          ? []
          : (this.db
              .prepare("SELECT * FROM places ORDER BY id LIMIT 2001")
              .all() as unknown as Manifest["places"]),
      edges:
        kind === "persona"
          ? []
          : this.db
              .prepare("SELECT * FROM memory_edges ORDER BY id LIMIT 2001")
              .all(),
      conflicts:
        kind === "persona"
          ? []
          : this.rows("SELECT json FROM conflicts ORDER BY id LIMIT 201"),
      branchMemos:
        kind === "persona"
          ? []
          : this.rows(
              "SELECT json FROM branch_memos ORDER BY branch_id LIMIT 101",
            ),
      persona: (persona?.result as Manifest["persona"]) ?? null,
      biography: null,
      parentGenerationId: null,
    };
    // Explicit bounds, never silently archive a partial table.
    if (
      m.people.length > 2000 ||
      m.places.length > 2000 ||
      m.edges.length > 2000 ||
      m.conflicts.length > 200 ||
      m.branchMemos.length > 100 ||
      JSON.stringify(m).length > 1500000
    )
      throw new DomainError("GENERATION_LIMIT", "manifest too large");
    if (kind === "persona" && !transcripts.length)
      throw new DomainError(
        "NO_SELF_TESTIMONY",
        "no accepted self transcripts",
      );
    return m;
  }
  claim(): Generation | null {
    return this.graph.tx(() => {
      const g = this.rows<Generation>(
        "SELECT json FROM derived_generations WHERE state='pending' ORDER BY rowid LIMIT 1",
      )[0];
      if (!g) return null;
      g.state = "running";
      this.save(g);
      return g;
    });
  }
  update(g: Generation): Generation {
    return this.graph.tx(() => {
      const old = this.get(g.id);
      if (old.state !== "running")
        throw new DomainError("GENERATION_STATE", "not running");
      if (
        g.inputHash !== old.inputHash ||
        JSON.stringify(g.manifest) !== JSON.stringify(old.manifest)
      )
        throw new DomainError("MANIFEST_CHANGED", "immutable generation input");
      this.save(g);
      if (g.state === "published")
        this.db
          .prepare(
            "INSERT INTO derived_active VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET generation_id=excluded.generation_id",
          )
          .run(g.kind, g.id);
      return g;
    });
  }
  recover(): null {
    return this.graph.tx(() => {
      for (const g of this.rows<Generation>(
        "SELECT json FROM derived_generations WHERE state IN ('pending','running')",
      )) {
        g.state = "failed";
        g.error = "INTERRUPTED";
        g.progress = "failed";
        this.save(g);
      }
      return null;
    });
  }
  cancel(id: string): null {
    const g = this.get(id);
    if (g.state === "pending" || g.state === "running") {
      g.state = "cancelled";
      g.progress = "cancelled";
      this.save(g);
    }
    return null;
  }
  river(q: RiverQuery): RiverSnapshot {
    const offset = q.offset ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      [q.start, q.end].some(
        (x) => x !== undefined && !Number.isSafeInteger(x),
      ) ||
      (q.start !== undefined && q.end !== undefined && q.start > q.end)
    )
      throw new DomainError("INVALID_QUERY", "river bounds");
    const where =
      "COALESCE(json_extract(r.json,'$.status'),'confirmed') <> 'superseded' AND (? IS NULL OR json_extract(r.json,'$.time.end')>=?) AND (? IS NULL OR json_extract(r.json,'$.time.start')<=?) AND (?=0 OR json_extract(r.json,'$.placement')='drifting')";
    const args = [
      q.start ?? null,
      q.start ?? null,
      q.end ?? null,
      q.end ?? null,
      q.drifting ? 1 : 0,
    ];
    const base =
      "FROM memory_revisions r JOIN memory_current c USING(id,revision) WHERE " +
      where;
    const total = Number(
      this.db.prepare("SELECT count(*) n " + base).get(...args)!.n,
    );
    const all = this.rows<GraphNode>(
      "SELECT json_object('id',r.id,'revision',r.revision,'keySentence',json_extract(r.json,'$.keySentence'),'time',json_extract(r.json,'$.time'),'placement',json_extract(r.json,'$.placement'),'status',COALESCE(json_extract(r.json,'$.status'),'confirmed')) json " +
        base +
        " ORDER BY json_extract(r.json,'$.time.start'),r.id LIMIT 500 OFFSET ?",
      ...args,
      offset,
    );
    const periods = this.db
      .prepare(
        "SELECT CAST(json_extract(r.json,'$.time.start')/120 AS INTEGER)*120 start,count(*) count FROM memory_revisions r JOIN memory_current c USING(id,revision) WHERE COALESCE(json_extract(r.json,'$.status'),'confirmed')<>'superseded' GROUP BY start ORDER BY start LIMIT 100",
      )
      .all() as unknown as RiverSnapshot["periods"];
    const conflictForNode = this.db.prepare(
      "SELECT 1 FROM conflicts WHERE status='open' AND (left_id=? OR right_id=?) LIMIT 1",
    );
    const openConflictNodes = new Set(
      all.filter((n) => conflictForNode.get(n.id, n.id)).map((n) => n.id),
    );
    const ids = new Set(all.map((n) => n.id));
    const relations = (
      this.db
        .prepare(
          'SELECT from_id as "from",to_id as "to",kind FROM memory_edges ORDER BY id LIMIT 2000',
        )
        .all() as unknown as RiverSnapshot["relations"]
    ).filter(
      (e) =>
        ids.has(e.from as GraphNode["id"]) && ids.has(e.to as GraphNode["id"]),
    );
    return {
      graphRevision: this.graph.revision(),
      nodes: all.map((n) => ({
        id: n.id,
        revision: n.revision,
        keySentence: n.keySentence,
        time: n.time,
        placement: n.placement,
        status: n.status ?? "confirmed",
        hasOpenConflict: openConflictNodes.has(n.id),
      })),
      total,
      offset,
      truncated: offset + all.length < total,
      periods,
      relations,
    };
  }
  detail(id: string, revision?: number): MemoryDetail {
    const node = this.graph.node(id, revision);
    if (!node) throw new DomainError("NOT_FOUND", "memory");
    const rows = this.rows<TranscriptSegment>(
      "SELECT DISTINCT t.json FROM source_refs s JOIN transcripts t ON t.id=s.transcript_id WHERE s.node_id=? AND s.revision=? ORDER BY t.id LIMIT 11",
      id,
      node.revision,
    );
    return {
      graphRevision: this.graph.revision(),
      node,
      people: (node.people ?? []).map((id) =>
        String(
          this.db.prepare("SELECT name FROM people WHERE id=?").get(id)?.name ??
            "",
        ),
      ),
      places: (node.places ?? []).map((id) =>
        String(
          this.db.prepare("SELECT name FROM places WHERE id=?").get(id)?.name ??
            "",
        ),
      ),
      conflicts: this.rows(
        "SELECT json FROM conflicts WHERE status='open' AND (left_id=? OR right_id=?) LIMIT 10",
        id,
        id,
      ),
      sources: rows.slice(0, 10).map((transcript) => {
        const source = this.rows<Source>(
          "SELECT json FROM sources WHERE id=?",
          transcript.sourceId,
        )[0];
        const m = source?.mediaId
          ? this.rows<Media>(
              "SELECT json FROM media WHERE id=?",
              source.mediaId,
            )[0]
          : null;
        return {
          transcript,
          media: m
            ? { id: m.id, mime: m.mime, durationMs: m.durationMs }
            : null,
        };
      }),
      truncated: rows.length > 10,
    };
  }
  correction(input: {
    sourceId: string;
    nodeId: string;
    revision: number;
  }): null {
    const s = this.rows<Source>(
        "SELECT json FROM sources WHERE id=?",
        input.sourceId,
      )[0],
      n = this.graph.node(input.nodeId);
    if (!s || s.status !== "draft" || !n || n.revision !== input.revision)
      throw new DomainError(
        "REVISION_CONFLICT",
        "correction requires current node and unsubmitted source",
      );
    this.db
      .prepare("INSERT INTO correction_intents VALUES(?,?,?)")
      .run(s.id, n.id, n.revision);
    return null;
  }
}

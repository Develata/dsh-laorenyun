/** Only the worker imports SQLite; migrations are explicit and transactional. */
import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../domain/types.ts";
export const SCHEMA_VERSION = 4;
export function migrate(db: DatabaseSync): void {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version > SCHEMA_VERSION)
    throw new DomainError(
      "SCHEMA_FUTURE",
      "database belongs to a newer application",
    );
  if (version === SCHEMA_VERSION) return;
  if (version === 3) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE graph_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
        INSERT INTO graph_metadata VALUES(1,0);
        CREATE TABLE memory_extraction_operations(id TEXT PRIMARY KEY, transcript_id TEXT UNIQUE NOT NULL REFERENCES transcripts(id), input_hash TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, graph_revision INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, input_snapshot TEXT, model_evidence TEXT);
        CREATE INDEX extraction_pending ON memory_extraction_operations(state,id);
        CREATE TABLE people(id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL);
        CREATE TABLE places(id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL);
        CREATE INDEX people_name ON people(name);
        CREATE INDEX places_name ON places(name);
        CREATE TABLE node_people(node_id TEXT, revision INTEGER, entity_id TEXT REFERENCES people(id), PRIMARY KEY(node_id,revision,entity_id), FOREIGN KEY(node_id,revision) REFERENCES memory_revisions(id,revision));
        CREATE TABLE node_places(node_id TEXT, revision INTEGER, entity_id TEXT REFERENCES places(id), PRIMARY KEY(node_id,revision,entity_id), FOREIGN KEY(node_id,revision) REFERENCES memory_revisions(id,revision));
        CREATE TABLE source_refs(node_id TEXT, revision INTEGER, transcript_id TEXT REFERENCES transcripts(id), field TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(node_id,revision,transcript_id,field,quote), FOREIGN KEY(node_id,revision) REFERENCES memory_revisions(id,revision));
        INSERT INTO source_refs(node_id,revision,transcript_id,field,quote) SELECT r.id,r.revision,r.transcript_id,'claim',json_extract(t.json,'$.text') FROM memory_revisions r JOIN transcripts t ON r.transcript_id=t.id WHERE json_extract(t.json,'$.text') IS NOT NULL;
        CREATE TABLE memory_edges(id TEXT PRIMARY KEY, from_id TEXT REFERENCES memory_current(id), to_id TEXT REFERENCES memory_current(id), kind TEXT CHECK(kind IN ('PRECEDES','CAUSES','ELABORATES','RELATES_TO')), json TEXT NOT NULL, UNIQUE(from_id,to_id,kind), CHECK(from_id<>to_id));
        CREATE INDEX edge_to ON memory_edges(to_id,kind);
        CREATE TABLE conflicts(id TEXT PRIMARY KEY, left_id TEXT, left_revision INTEGER, right_id TEXT, right_revision INTEGER, status TEXT NOT NULL, json TEXT NOT NULL, FOREIGN KEY(left_id,left_revision) REFERENCES memory_revisions(id,revision), FOREIGN KEY(right_id,right_revision) REFERENCES memory_revisions(id,revision));
        CREATE TABLE scheduler_decisions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, json TEXT NOT NULL);
        CREATE TABLE interview_deferrals(session_id TEXT, region TEXT, until_turn INTEGER NOT NULL, transcript_id TEXT REFERENCES transcripts(id), PRIMARY KEY(session_id,region));
        CREATE TABLE branch_memos(branch_id TEXT PRIMARY KEY REFERENCES branches(id), json TEXT NOT NULL);
        DROP INDEX one_active_branch;
        CREATE UNIQUE INDEX one_active_branch ON branches(parent_session_id) WHERE state IN ('proposed','provisioning','active','closing');
        CREATE INDEX memory_time ON memory_revisions(json_extract(json,'$.time.start'),json_extract(json,'$.time.end'));
        PRAGMA user_version=4; COMMIT;
      `);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  if (version === 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE speech_attempts(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), json TEXT NOT NULL);
      CREATE TABLE interviews(session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE assistant_replies(session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE receipts(transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id), state TEXT NOT NULL);
      PRAGMA user_version=3; COMMIT`);
      migrate(db);
      return;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version === 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "CREATE TABLE session_speakers(session_id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version=2; COMMIT",
      );
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    migrate(db);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
   CREATE TABLE media(id TEXT PRIMARY KEY, json TEXT NOT NULL);
   CREATE TABLE sources(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, media_id TEXT REFERENCES media(id), status TEXT NOT NULL, json TEXT NOT NULL);
   CREATE UNIQUE INDEX one_draft_per_session ON sources(session_id) WHERE status='draft';
   CREATE TABLE transcripts(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), session_id TEXT NOT NULL, message_id TEXT NOT NULL, request_id TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(session_id,message_id), UNIQUE(session_id,request_id));
   CREATE INDEX transcript_session ON transcripts(session_id,id);
   CREATE TABLE memory_revisions(id TEXT NOT NULL, revision INTEGER NOT NULL, transcript_id TEXT NOT NULL REFERENCES transcripts(id), json TEXT NOT NULL, PRIMARY KEY(id,revision));
   CREATE TABLE memory_current(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, FOREIGN KEY(id,revision) REFERENCES memory_revisions(id,revision));
   CREATE TABLE branches(id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, session_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL, answer_count INTEGER NOT NULL CHECK(answer_count BETWEEN 0 AND 5), json TEXT NOT NULL);
   CREATE UNIQUE INDEX one_active_branch ON branches(parent_session_id) WHERE state IN ('provisioning','active');
   CREATE TABLE branch_answers(branch_id TEXT NOT NULL REFERENCES branches(id), message_id TEXT NOT NULL, request_id TEXT NOT NULL, transcript_id TEXT NOT NULL REFERENCES transcripts(id), PRIMARY KEY(branch_id,message_id), UNIQUE(branch_id,request_id));
   CREATE TABLE session_speakers(session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
   PRAGMA user_version=2;
  `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  migrate(db);
}

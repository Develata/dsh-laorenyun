-- Schema-only fixture from plugin 5d6d149 (no interview content).
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

CREATE TABLE speech_attempts(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), json TEXT NOT NULL);
      CREATE TABLE interviews(session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE assistant_replies(session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE receipts(transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id), state TEXT NOT NULL);
      PRAGMA user_version=3;

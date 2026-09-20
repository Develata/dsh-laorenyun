/** Synthetic storage projection fixture; no cloud, production volume or model writes. */
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../src/storage/migrations.ts";
import { GraphStorage } from "../../src/memory/storage.ts";
import { PresentationStorage } from "../../src/derived/storage.ts";
export function riverScale(anchored = 700, drifting = 300) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  const graph = new GraphStorage(db),
    storage = new PresentationStorage(db, graph);
  db.exec("BEGIN");
  const id = (i: number) => `node-${String(i).padStart(4, "0")}`;
  for (let i = 0; i < anchored + drifting; i++) {
    const nid = id(i),
      tid = `t-${i}`,
      sid = `s-${i}`,
      month = i < anchored ? 1950 * 12 + i : null;
    const text = `合成记录${i}：我在村里学习修理自行车。`;
    const t = {
      id: tid,
      sourceId: sid,
      sessionId: "synthetic",
      messageId: tid,
      requestId: tid,
      text,
      speaker: { role: "self" },
      revision: 1,
    };
    db.prepare("INSERT INTO sources VALUES(?,?,NULL,'submitted',?)").run(
      sid,
      "synthetic",
      JSON.stringify({ id: sid, mediaId: null }),
    );
    db.prepare("INSERT INTO transcripts VALUES(?,?,?,?,?,?)").run(
      tid,
      sid,
      "synthetic",
      tid,
      tid,
      JSON.stringify(t),
    );
    const n = {
      id: nid,
      revision: 1,
      keySentence: text,
      transcriptId: tid,
      basis: "stated",
      status: "confirmed",
      people: [],
      places: [],
      evidence: [{ transcriptId: tid, text, field: "claim" }],
      placement: month === null ? "drifting" : "anchored",
      time: {
        start: month,
        end: month,
        precision: month === null ? "unknown" : "month",
        certainty: "stated",
        originalText: "",
      },
    };
    db.prepare("INSERT INTO memory_revisions VALUES(?,1,?,?)").run(
      nid,
      tid,
      JSON.stringify(n),
    );
    db.prepare("INSERT INTO memory_current VALUES(?,1)").run(nid);
    db.prepare("INSERT INTO source_refs VALUES(?,1,?,'claim',?)").run(
      nid,
      tid,
      text,
    );
  }
  const edge = (key: string, from: number, to: number, kind: string) =>
    db
      .prepare("INSERT OR IGNORE INTO memory_edges VALUES(?,?,?,?,?)")
      .run(
        key,
        id(from),
        id(to),
        kind,
        JSON.stringify({ from: id(from), to: id(to), kind }),
      );
  let edges = 0;
  // Global first 2100 IDs point outside first dated page where possible.
  if (anchored >= 700)
    for (let i = 0; i < 300; i++)
      for (let j = 1; j <= 7; j++) {
        edge(
          `a-${String(edges++).padStart(5, "0")}`,
          400 + i,
          400 + ((i + j) % 300),
          ["RELATES_TO", "CAUSES", "PRECEDES"][j % 3]!,
        );
      }
  if (anchored > 4) {
    edge("z-visible-elaboration", 1, 0, "ELABORATES");
    edge("z-visible-deep", 2, 1, "ELABORATES");
  }
  const memo = (i: number, members: string[]) => {
    const bid = `branch-${String(i).padStart(3, "0")}`;
    db.prepare(
      "INSERT OR IGNORE INTO branches VALUES(?,? ,?,'closed',2,?)",
    ).run(bid, "synthetic", bid, JSON.stringify({ id: bid, state: "closed" }));
    db.prepare("INSERT OR REPLACE INTO branch_memos VALUES(?,?)").run(
      bid,
      JSON.stringify({ related_memory_nodes: members, status: "complete" }),
    );
  };
  if (anchored >= 100)
    for (let i = 0; i < 50; i++) memo(i, [id(i * 2), id(i * 2 + 1)]);
  if (anchored >= 100)
    for (let i = 0; i < 8; i++) {
      const c = {
        id: `conflict-${i}`,
        left: { id: id(i * 2), revision: 1 },
        right: { id: id(i * 2 + 1), revision: 1 },
        status: "open",
        explanation: "合成不同说法",
      };
      db.prepare("INSERT INTO conflicts VALUES(?,?,1,?,1,'open',?)").run(
        c.id,
        c.left.id,
        c.right.id,
        JSON.stringify(c),
      );
    }
  graph.bump();
  db.exec("COMMIT");
  return { db, graph, storage, id, memo };
}

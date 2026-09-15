import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Foundation } from "../src/application.ts";
import { DomainDatabase } from "../src/storage/database.ts";
import {
  operation,
  type BranchId,
  type NodeId,
  type HumanInput,
} from "../src/domain/types.ts";
import { sourceMarker } from "../src/domain/source-reference.ts";
const temp = () => mkdtemp(join(tmpdir(), "laorenyun-phase1-"));
function human(
  sessionId: string,
  text: string,
  requestId = randomUUID(),
): HumanInput {
  return {
    sessionId,
    text,
    requestId,
    messageId: randomUUID(),
    role: "user",
    sourceKind: "user",
  };
}

test("empty migration, durable source, native serialized correction and memory provenance survive reopen", async () => {
  const root = await temp();
  let app = await Foundation.open(root);
  try {
    assert.equal((await app.db.call("health", null)).schema, 3);
    const source = await app.fakeDraft("session-a", {
      role: "self",
      authority: "explicit-user",
    });
    assert.equal(source.rawAsr, "我那个时候去了合肥一中");
    const bytes = await app.recordings.read(source.mediaId!, operation());
    const media = await app.db.call("getMedia", source.mediaId!);
    assert.equal(
      media!.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(
      (await stat(join(root, media!.relativePath))).mode & 0o777,
      0o600,
    );
    await app.close();
    app = await Foundation.open(root);
    assert.equal((await app.db.call("getDraft", "session-a"))!.id, source.id);
    const message = human(
      "session-a",
      sourceMarker(source.id) + " 我那个时候去了合肥六中",
    );
    const accepted = await app.db.call("acceptHuman", message);
    const t = accepted.transcript!;
    assert.equal(t.text, "我那个时候去了合肥六中");
    assert.equal(t.rawAsr, source.rawAsr);
    assert.equal(t.correction, true);
    assert.equal(t.speaker.role, "self");
    assert.equal(t.messageId, message.messageId);
    assert.equal(t.requestId, message.requestId);
    assert.equal((await app.db.call("acceptHuman", message)).duplicate, true);
    assert.equal((await app.db.call("listTranscripts", "session-a")).length, 1);
    const node = {
      id: randomUUID() as NodeId,
      revision: 1,
      keySentence: "在合肥六中求学",
      time: {
        start: null,
        end: null,
        precision: "unknown" as const,
        certainty: "stated" as const,
      },
      placement: "drifting" as const,
      transcriptId: t.id,
      basis: "stated" as const,
    };
    await app.db.call("putMemory", { node, expectedRevision: 0 });
    await app.close();
    app = await Foundation.open(root);
    assert.deepEqual(await app.db.call("getMemory", node.id), node);
    const updated = {
      ...node,
      revision: 2,
      time: {
        start: 1960 * 12,
        end: 1960 * 12 + 11,
        precision: "year" as const,
        certainty: "inferred" as const,
      },
      placement: "anchored" as const,
    };
    await app.db.call("putMemory", { node: updated, expectedRevision: 1 });
    assert.equal(
      (await app.db.call("listMemories", { limit: 10 }))[0]!.time.certainty,
      "inferred",
    );
    await assert.rejects(
      app.db.call("putMemory", { node: updated, expectedRevision: 1 }),
      /REVISION_CONFLICT/,
    );
  } finally {
    await app.close();
  }
});

test("cancel and cross-session submission failures retain source and original bytes", async () => {
  const root = await temp();
  const app = await Foundation.open(root);
  try {
    const source = await app.fakeDraft("a", {
      role: "child",
      displayName: "子女",
      authority: "explicit-user",
    });
    await assert.rejects(
      app.db.call(
        "acceptHuman",
        human("b", sourceMarker(source.id) + " 修订稿"),
      ),
      /SOURCE_SESSION_MISMATCH/,
    );
    assert.equal((await app.db.call("getSource", source.id))!.status, "draft");
    await app.db.call("cancelSource", source.id);
    await assert.rejects(
      app.db.call(
        "acceptHuman",
        human("a", sourceMarker(source.id) + " 修订稿"),
      ),
      /SOURCE_NOT_DRAFT/,
    );
    assert.ok(
      (await app.recordings.read(source.mediaId!, operation())).length > 0,
    );
  } finally {
    await app.close();
  }
});

test("only human answers count; replay and cold recovery cannot reset five-answer closure", async () => {
  const root = await temp();
  let app = await Foundation.open(root);
  try {
    const branch = {
      id: randomUUID() as BranchId,
      parentSessionId: "parent",
      sessionId: "child",
      state: "provisioning" as const,
      answerCount: 0,
      memo: null,
    };
    await app.db.call("reserveBranch", branch);
    await app.db.call("activateBranch", "child");
    for (const [role, sourceKind] of [
      ["assistant", "model"],
      ["user", "tool"],
      ["system", "plugin"],
      ["user", "model"],
    ])
      await app.db.call("acceptHuman", {
        ...human("child", "not a human answer"),
        role: role!,
        sourceKind: sourceKind!,
      });
    assert.equal((await app.db.call("getBranch", "child"))!.answerCount, 0);
    const first = human("child", "回答1");
    await app.db.call("acceptHuman", first);
    await app.db.call("acceptHuman", first);
    await app.db.call("acceptHuman", human("child", "回答2"));
    await app.close();
    app = await Foundation.open(root);
    assert.equal((await app.db.call("getBranch", "child"))!.answerCount, 2);
    for (let n = 3; n <= 5; n++)
      await app.db.call("acceptHuman", human("child", `回答${n}`));
    const closed = (await app.db.call("getBranch", "child"))!;
    assert.equal(closed.state, "closed");
    assert.equal(closed.answerCount, 5);
    assert.equal(closed.memo!.source_turns.length, 5);
    assert.equal(
      (await app.db.call("acceptHuman", human("child", "第六次不应接纳")))
        .blocked,
      true,
    );
    assert.equal((await app.db.call("listTranscripts", "child")).length, 5);
  } finally {
    await app.close();
  }
});

test("recording failure never reports success and committed manifest reconciles after DB failure", async () => {
  const root = await temp();
  const app = await Foundation.open(root);
  const data = new TextEncoder().encode("fixture");
  await app.close();
  await assert.rejects(
    app.recordings.write(data, "audio/wav", true, operation()),
    /DATABASE_CLOSED/,
  );
  const reopened = await Foundation.open(root);
  try {
    assert.equal((await reopened.db.call("health", null)).sources, 0);
    const manifestName = (await readdir(join(root, "audio"))).find((n) =>
      n.endsWith(".json"),
    )!;
    const manifest = JSON.parse(
      await readFile(join(root, "audio", manifestName), "utf8"),
    );
    assert.equal(
      (await reopened.db.call("getMedia", manifest.id))?.sha256,
      manifest.sha256,
    );
    assert.deepEqual(
      await reopened.recordings.read(manifest.id, operation()),
      Buffer.from(data),
    );
  } finally {
    await reopened.close();
  }
  const bad = await temp();
  await writeFile(join(bad, "audio"), "not a directory");
  await assert.rejects(Foundation.open(bad), /EEXIST|ENOTDIR/);
});

test("corrupt SQLite and invalid provenance propagate errors", async () => {
  const root = await temp();
  await writeFile(join(root, "laorenyun.db"), "corrupt sqlite");
  await assert.rejects(
    DomainDatabase.open(root),
    /MIGRATION_FAILED|WORKER_START_FAILED/,
  );
  const app = await Foundation.open(await temp());
  try {
    await assert.rejects(
      app.db.call("putMemory", {
        node: {
          id: randomUUID() as NodeId,
          revision: 1,
          keySentence: "unsupported",
          time: {
            start: null,
            end: null,
            precision: "unknown",
            certainty: "inferred",
          },
          placement: "drifting",
          transcriptId: "missing",
          basis: "inferred",
        },
        expectedRevision: 0,
      }),
      /FOREIGN KEY/,
    );
  } finally {
    await app.close();
  }
});

test("speaker selection is durable for typed answers; changed request replay is rejected", async () => {
  const root = await temp();
  let app = await Foundation.open(root);
  try {
    await app.db.call("setSessionSpeaker", {
      sessionId: "s",
      speaker: {
        role: "child",
        displayName: "测试讲述者",
        authority: "explicit-user",
      },
    });
    await app.close();
    app = await Foundation.open(root);
    const input = human("s", "这是子女明确选择身份后的文字回答");
    const accepted = await app.db.call("acceptHuman", input);
    assert.equal(accepted.transcript?.speaker.role, "child");
    await assert.rejects(
      app.db.call("acceptHuman", { ...input, text: "different" }),
      /IDEMPOTENCY_MISMATCH/,
    );
    assert.equal((await app.db.call("listTranscripts", "s")).length, 1);
  } finally {
    await app.close();
  }
});

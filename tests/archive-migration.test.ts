import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { Archives } from "../src/archive/registry.ts";
test("singleton migration is restart-idempotent and only adopts matching native workspace membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "laorenyun-migration-"));
  const records: any[] = [];
  const headers = new Map([
    ["legacy", { id: "legacy", cwd: process.cwd() }],
    ["unrelated", { id: "unrelated", cwd: "/tmp" }],
    ["child", { id: "child", parentSession: "legacy" }],
  ]);
  const registry = {
    list: () => records,
    create: async (path: string, title: string) => {
      let w = records.find((w) => w.path === resolve(path));
      if (w) return w;
      w = {
        id: randomUUID(),
        path: resolve(path),
        title,
        sessionIds: [],
        attachSession: async (id: string) => {
          if (!w.sessionIds.includes(id)) w.sessionIds.push(id);
        },
      };
      records.push(w);
      return w;
    },
  };
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: {
      list: async () => [...headers.values()].map((header) => ({ header })),
      stat: async (id: string) =>
        headers.has(id) ? { header: headers.get(id) } : null,
    },
  } as unknown as Context;
  const first = await Archives.open(ctx, root);
  assert.equal(first.dataRoot(first.defaultId), root);
  assert.deepEqual(first.list()[0]!.sessionIds, ["legacy"]);
  const second = await Archives.open(ctx, root);
  assert.equal(first.defaultId, second.defaultId);
  assert.equal(records.length, 1);
  assert.equal(await second.forSession("child"), first.defaultId);
  await assert.rejects(second.forSession("unrelated"), /membership missing/);
  const other = await second.create("另一人");
  assert.notEqual(second.dataRoot(other.id), root);
  assert.deepEqual(
    second.list().find((w) => w.id === other.id)!.sessionIds,
    [],
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "archive-default.json"), "utf8"))
      .workspaceId,
    first.defaultId,
  );
});

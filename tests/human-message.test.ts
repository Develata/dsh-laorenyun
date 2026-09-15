import { test } from "node:test";
import assert from "node:assert/strict";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { browserHuman } from "../src/host/human-message.ts";
const message = (source: UserMessage["source"]): UserMessage => ({
  id: "message-fixture" as UserMessage["id"],
  role: "user",
  content: [{ type: "text", text: "回答" }],
  source,
});
test("only DSH browser-authored human messages carry the authoritative RPC identity", () => {
  assert.equal(browserHuman("child", message({ kind: "user" })), null);
  assert.equal(
    browserHuman(
      "child",
      message({
        kind: "model",
        provider: "fixture",
        model: "fixture",
      } as UserMessage["source"]),
    ),
    null,
  );
  const result = browserHuman(
    "child",
    message({
      kind: "user",
      rpcId: "browser-request",
    } as UserMessage["source"]),
  );
  assert.equal(result?.requestId, "browser-request");
  assert.equal(result?.messageId, "message-fixture");
});

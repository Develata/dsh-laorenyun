import { test } from "node:test";
import assert from "node:assert/strict";
import { readingTitle } from "../src/river/reading-title.ts";
test("reading heading suppresses exact lead duplication without rewriting stored prose", () => {
  const title = "我1952年出生在安徽一个村子",
    text = title + "。家里有四个孩子。";
  assert.equal(readingTitle(title, text, 0), "第1章");
  assert.equal(readingTitle("修理铺", text, 1), "修理铺");
  assert.ok(text.startsWith(title));
});

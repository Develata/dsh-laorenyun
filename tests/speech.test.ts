import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Foundation } from "../src/application.ts";
import { operation, type SourceId, type MediaId } from "../src/domain/types.ts";
import {
  signFlash,
  parseFlash,
  TencentFlashAsrProvider,
} from "../src/speech/tencent-flash.ts";
import { TencentTtsProvider, splitSpeech } from "../src/speech/tencent-tts.ts";
import { normalizeAudio, inspectWav } from "../src/speech/normalize.ts";
import { SpeechService } from "../src/speech/service.ts";
import { boundedBody } from "../src/speech/bounds.ts";
const config = {
  appId: "1234567890",
  secretId: "fixture-id",
  secretKey: "fixture-key",
  engine: "16k_zh_en",
  timeoutMs: 1000,
};
const result = {
  code: 0,
  request_id: "request",
  audio_duration: 1000,
  flash_result: [
    {
      channel_id: 0,
      text: "合肥一中",
      sentence_list: [{ text: "合肥一中", start_time: 0, end_time: 1000 }],
    },
  ],
};
test("Flash canonical sorted raw signature, encoded wire params, timestamp and AppID", () => {
  const signed = signFlash(
    "1234567890",
    {
      voice_format: "wav",
      timestamp: "1700000000",
      hotword_list: "合肥 六中|10&x",
      engine_type: "16k_zh_en",
    },
    "test-key",
  );
  assert.equal(signed.authorization, "eerDpWJbsw5+yq4hSR30G5Av+Hw=");
  assert.ok(signed.url.includes("/1234567890?engine_type="));
  assert.equal(
    new URL(signed.url).searchParams.get("hotword_list"),
    "合肥 六中|10&x",
  );
  assert.equal(
    signed.authorization,
    signFlash(
      "1234567890",
      {
        engine_type: "16k_zh_en",
        hotword_list: "合肥 六中|10&x",
        timestamp: "1700000000",
        voice_format: "wav",
      },
      "test-key",
    ).authorization,
  );
  assert.notEqual(
    signed.authorization,
    signFlash("1234567890", { timestamp: "1700000001" }, "test-key")
      .authorization,
  );
  assert.throws(() => signFlash("../bad", {}, "secret"));
});
test("Flash neutral result, provider errors, malformed response and bounded timeout", async () => {
  assert.equal(parseFlash(result, "16k_zh_en", 42).segments[0]?.endMs, 1000);
  for (const [code, expected] of [
    [4002, "CONFIGURATION"],
    [4006, "RATE_LIMIT"],
    [4007, "UNSUPPORTED_AUDIO"],
    [5003, "PROVIDER_TIMEOUT"],
    [5002, "PROVIDER_REJECTION"],
  ] as const)
    assert.throws(() => parseFlash({ code }, "x", 0), new RegExp(expected));
  assert.throws(() => parseFlash({}, "x", 0), /MALFORMED_RESPONSE/);
  const provider = new TencentFlashAsrProvider(config, async () =>
    Response.json(result),
  );
  assert.equal(
    (await provider.transcribe(new Uint8Array([1]), operation())).text,
    "合肥一中",
  );
  const timeout = new TencentFlashAsrProvider(
    config,
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("secret-url must not escape")),
        ),
      ),
  );
  await assert.rejects(
    timeout.transcribe(new Uint8Array([1]), operation(20)),
    /PROVIDER_TIMEOUT/,
  );
  const network = new TencentFlashAsrProvider(config, async () => {
    throw new Error("fixture-key");
  });
  await assert.rejects(
    network.transcribe(new Uint8Array([1]), operation()),
    (e) =>
      String(e).includes("NETWORK_FAILURE") &&
      !String(e).includes("fixture-key"),
  );
});
test("bounded streaming upload rejects over limit", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8));
      c.enqueue(new Uint8Array(8));
      c.close();
    },
  });
  await assert.rejects(
    boundedBody(body, 10, AbortSignal.timeout(1000)),
    /SIZE_LIMIT/,
  );
});
test("real WebM Opus normalization verifies PCM shape and rejects failures/timeouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "laorenyun-normalize-"));
  try {
    execFileSync(
      "/usr/bin/ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:a",
        "libopus",
        join(root, "input.webm"),
      ],
      { timeout: 10000 },
    );
    const original = await readFile(join(root, "input.webm"));
    const normalized = await normalizeAudio(original, root, operation(10000));
    const format = inspectWav(normalized);
    assert.equal(format.channels, 1);
    assert.equal(format.sampleRate, 16000);
    assert.ok(format.durationMs >= 990 && format.durationMs < 1100);
    assert.deepEqual(await readFile(join(root, "input.webm")), original);
    await assert.rejects(
      normalizeAudio(new Uint8Array([0, 1]), root, operation()),
      /NORMALIZATION_FAILED/,
    );
    // Disposable executable imitates a hung converter; no input-controlled args or shell invocation in production.
    const executable = join(root, "hang");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nsetInterval(()=>{},1000)\n",
      { mode: 0o700 },
    );
    await assert.rejects(
      normalizeAudio(original, root, operation(), executable, 20),
      /NORMALIZATION_TIMEOUT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("original -> derivative -> attempt -> draft survives reopen, retry and correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "laorenyun-speech-"));
  let app = await Foundation.open(root);
  const id = randomUUID() as SourceId;
  try {
    execFileSync(
      "/usr/bin/ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:a",
        "libopus",
        join(root, "input.webm"),
      ],
      { timeout: 10000 },
    );
    let calls = 0;
    const factory = () => ({
      transcribe: async () => {
        calls++;
        if (calls === 1) throw new Error("cloud unavailable");
        return parseFlash(result, "fixture", 2);
      },
    });
    let service = new SpeechService(app, root, factory, () => {
      throw new Error("unused");
    });
    await service.initialize();
    await service.reserve("s", id);
    const media = await app.recordings.write(
      await readFile(join(root, "input.webm")),
      "audio/webm",
      false,
      operation(),
      { id: id as unknown as MediaId, sourceId: id },
    );
    await app.db.call("attachRecording", { sourceId: id, mediaId: media.id });
    await assert.rejects(service.recognize("s", id));
    assert.ok((await app.recordings.read(media.id, operation())).length);
    assert.equal((await app.db.call("getAttempt", id))?.state, "failed");
    await service.recognize("s", id);
    assert.equal(calls, 2);
    await service.recognize("s", id);
    assert.equal(calls, 2);
    const attempt = await app.db.call("getAttempt", id);
    assert.equal(attempt?.derivative?.originalMediaId, media.id);
    await service.close();
    await app.close();
    app = await Foundation.open(root);
    service = new SpeechService(app, root, factory, () => {
      throw new Error("unused");
    });
    await service.initialize();
    const draft = await app.db.call("getDraft", "s");
    assert.equal(draft?.rawAsr, "合肥一中");
    const receipt = await app.db.call("acceptHuman", {
      sessionId: "s",
      messageId: "m",
      requestId: "r",
      role: "user",
      sourceKind: "user",
      text: `[[laorenyun-source:${id}]] 合肥六中`,
    });
    assert.equal(receipt.transcript?.rawAsr, "合肥一中");
    assert.equal(receipt.transcript?.text, "合肥六中");
    const first = await app.db.call("beginInterview", {
      sessionId: "s",
      bootstrapId: randomUUID(),
      createdAt: 1,
    });
    const second = await app.db.call("beginInterview", {
      sessionId: "s",
      bootstrapId: randomUUID(),
      createdAt: 2,
    });
    assert.deepEqual(first, second);
    await service.close();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("TTS uses bounded chunks, SDK abort options, neutral bytes and one cached reply", async () => {
  const texts: string[] = [];
  const provider = new TencentTtsProvider(
    {
      secretId: "fixture",
      secretKey: "fixture",
      voice: 101001,
      speed: -0.5,
      volume: 0,
      timeoutMs: 5000,
    },
    async (params, signal) => {
      assert.ok(signal);
      assert.equal(params.Codec, "mp3");
      texts.push(String(params.Text));
      return {
        Audio: Buffer.from("fake mp3").toString("base64"),
        RequestId: "r",
      };
    },
  );
  const text = "您那时在哪里上学？".repeat(20);
  const audio = await provider.synthesize(text, operation());
  assert.equal(texts.join(""), text);
  assert.ok(texts.every((t) => [...t].length <= 140));
  assert.equal(audio.mime, "audio/mpeg");
  assert.throws(() => splitSpeech("x".repeat(1201)), /SIZE_LIMIT/);
});

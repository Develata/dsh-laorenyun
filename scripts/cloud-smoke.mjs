// Explicit paid smoke only. The caller supplies private env and an untracked local audio file.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operation } from "../src/domain/types.ts";
import { TencentFlashAsrProvider } from "../src/speech/tencent-flash.ts";
import { TencentTtsProvider } from "../src/speech/tencent-tts.ts";
import { normalizeAudio, inspectWav } from "../src/speech/normalize.ts";
if (process.argv[2] !== "--cloud")
  throw new Error("Explicit --cloud required; may incur cloud usage");
const secretId = process.env.TENCENTCLOUD_SECRET_ID,
  secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
if (!secretId || !secretKey)
  throw new Error("Tencent credentials required in private environment");
const tts = new TencentTtsProvider({
  secretId,
  secretKey,
  voice: Number(process.env.TENCENT_TTS_VOICE || 101001),
  speed: -0.5,
  volume: 0,
  timeoutMs: 60000,
});
let start = Date.now();
try {
  const spoken = await tts.synthesize(
    "我们先从最开始聊起吧。您是在哪里出生的？大概是哪一年？",
    operation(65000),
  );
  console.log(
    JSON.stringify({
      provider: "Tencent TextToVoice",
      voice: spoken.voice,
      bytes: spoken.bytes.length,
      latencyMs: Date.now() - start,
      status: "success",
    }),
  );
  if (process.argv[3]) {
    const root = await mkdtemp(join(tmpdir(), "laorenyun-cloud-"));
    try {
      const wav = await normalizeAudio(
        await readFile(process.argv[3]),
        root,
        operation(35000),
      );
      const asr = new TencentFlashAsrProvider({
        secretId,
        secretKey,
        appId: process.env.TENCENTCLOUD_APP_ID ?? "",
        engine: process.env.TENCENT_ASR_ENGINE || "16k_zh_en",
        timeoutMs: 90000,
      });
      const result = await asr.transcribe(wav, operation(95000));
      console.log(
        JSON.stringify({
          provider: result.provider,
          engine: result.engine,
          durationMs: inspectWav(wav).durationMs,
          latencyMs: result.latencyMs,
          resultLength: result.text.length,
          status: "success",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: typeof error?.code === "string" ? error.code : "SMOKE_FAILED",
    }),
  );
  process.exitCode = 1;
}

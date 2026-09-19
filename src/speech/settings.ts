import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
export const SPEECH_SETTINGS = "laorenyun-speech";
const schema = z.object({
  appId: z.string().role("secret"),
  secretId: z.string().role("secret"),
  secretKey: z.string().role("secret"),
  engine: z.string().default("16k_zh"),
  voice: z.number().min(1).step(1).default(101001),
  speed: z.number().min(-2).max(6).default(-0.5),
});
export interface SpeechSettings {
  appId: string;
  secretId: string;
  secretKey: string;
  engine: string;
  voice: number;
  speed: number;
}
export function speechSettings(ctx: Context): () => SpeechSettings {
  const base: SpeechSettings = {
    appId: process.env.TENCENTCLOUD_APP_ID ?? "",
    secretId: process.env.TENCENTCLOUD_SECRET_ID ?? "",
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY ?? "",
    engine: process.env.TENCENT_ASR_ENGINE || "16k_zh",
    voice: Number(process.env.TENCENT_TTS_VOICE || 101001),
    speed: Number(process.env.TENCENT_TTS_SPEED || -0.5),
  };
  let source = () => base;
  ctx.settings.installSection(ctx, SPEECH_SETTINGS, schema, base, {
    onChange: () => {},
    setSource: (current) => {
      source = current as () => SpeechSettings;
    },
    validate: (value) => {
      if (value.appId && !/^\d+$/.test(value.appId))
        throw new Error("AppID must be numeric");
      if (!/^[a-z0-9_]+$/.test(value.engine ?? ""))
        throw new Error("Invalid ASR engine");
    },
  });
  return () => source();
}

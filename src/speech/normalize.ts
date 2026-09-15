import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { DomainError, type OperationContext } from "../domain/types.ts";
import { MAX_AUDIO_BYTES, MAX_RECORDING_MS } from "../domain/speech.ts";
import { boundedSignal } from "./bounds.ts";
export function inspectWav(bytes: Uint8Array): {
  durationMs: number;
  channels: 1;
  sampleRate: 16000;
} {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new DomainError("UNSUPPORTED_AUDIO", "WAV header");
  let format = false,
    size = 0;
  for (let i = 12; i + 8 <= b.length; ) {
    const n = b.readUInt32LE(i + 4);
    if (i + 8 + n > b.length)
      throw new DomainError("UNSUPPORTED_AUDIO", "truncated WAV");
    const tag = b.toString("ascii", i, i + 4);
    if (tag === "fmt ") {
      if (
        n < 16 ||
        b.readUInt16LE(i + 8) !== 1 ||
        b.readUInt16LE(i + 10) !== 1 ||
        b.readUInt32LE(i + 12) !== 16000 ||
        b.readUInt16LE(i + 22) !== 16
      )
        throw new DomainError("UNSUPPORTED_AUDIO", "expected mono 16k PCM16");
      format = true;
    }
    if (tag === "data") size = n;
    i += 8 + n + (n % 2);
  }
  if (!format || size === 0 || size / 32 > MAX_RECORDING_MS)
    throw new DomainError("UNSUPPORTED_AUDIO", "WAV duration");
  return { durationMs: size / 32, channels: 1, sampleRate: 16000 };
}
/** Fixed local files and args only. Original archive is never an output path. */
export async function normalizeAudio(
  input: Uint8Array,
  root: string,
  op: OperationContext,
  executable = "/usr/bin/ffmpeg",
  timeoutMs = 30000,
): Promise<Uint8Array> {
  if (!isAbsolute(executable) || input.length > MAX_AUDIO_BYTES)
    throw new DomainError("INVALID_INPUT", "normalization input");
  await mkdir(join(root, "normalizing"), { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, "normalizing", "job-"));
  try {
    await writeFile(join(dir, "input"), input, { mode: 0o600 });
    const signal = boundedSignal(op, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "matroska,webm,mov,mp3,wav,ogg,aac,amr",
          "-i",
          join(dir, "input"),
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-t",
          "601",
          "-fs",
          String(20 * 1024 * 1024),
          "-f",
          "wav",
          join(dir, "output.wav"),
        ],
        { stdio: ["ignore", "ignore", "ignore"], shell: false },
      );
      let killed = false;
      const kill = () => {
        killed = true;
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      child.once("error", () => {
        signal.removeEventListener("abort", kill);
        reject(
          new DomainError("NORMALIZATION_FAILED", "FFmpeg could not start"),
        );
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", kill);
        if (killed)
          reject(
            new DomainError(
              "NORMALIZATION_TIMEOUT",
              "FFmpeg exceeded deadline",
            ),
          );
        else if (code !== 0)
          reject(
            new DomainError(
              "NORMALIZATION_FAILED",
              "audio could not be decoded",
            ),
          );
        else resolve();
      });
    });
    if ((await stat(join(dir, "output.wav"))).size > 20 * 1024 * 1024)
      throw new DomainError("SIZE_LIMIT", "normalized audio");
    const output = await readFile(join(dir, "output.wav"), {
      signal: op.signal,
    });
    inspectWav(output);
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

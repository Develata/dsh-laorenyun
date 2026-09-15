import {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
/** Deterministic keyless transport probe, clearly separate from an interviewer. */
export class FixtureLlm extends LlmAdapter {
  async listModels(provider: string) {
    return [
      {
        id: "fixture",
        name: "Phase 1 验证（非真实模型）",
        provider,
        contextWindow: 32000,
      },
    ];
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const text = "验证回执：这次提交已经处理。";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

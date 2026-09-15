import {
  DomainError,
  checkOperation,
  type OperationContext,
} from "../domain/types.ts";
export function boundedSignal(
  op: OperationContext,
  maxMs: number,
): AbortSignal {
  checkOperation(op);
  return AbortSignal.any([
    op.signal,
    AbortSignal.timeout(Math.max(1, Math.min(maxMs, op.deadline - Date.now()))),
  ]);
}
/** Streaming reader rejects before accumulating more than its documented cap. */
export async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!body) throw new DomainError("INVALID_INPUT", "empty body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      size += item.value.length;
      if (size > limit)
        throw new DomainError("SIZE_LIMIT", "body exceeds limit");
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

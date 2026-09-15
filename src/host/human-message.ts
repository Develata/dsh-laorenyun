import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { HumanInput } from "../domain/types.ts";
/** Web-only authority: DSH's browser RPC stamps rpcId; synthetic spawn prompts do not. */
export function browserHuman(
  sessionId: string,
  message: UserMessage,
): HumanInput | null {
  if (
    message.source.kind !== "user" ||
    !("rpcId" in message.source) ||
    typeof message.source.rpcId !== "string" ||
    message.source.rpcId.length === 0
  )
    return null;
  return {
    sessionId,
    messageId: String(message.id),
    requestId: message.source.rpcId,
    role: "user",
    sourceKind: "user",
    text: message.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n"),
  };
}

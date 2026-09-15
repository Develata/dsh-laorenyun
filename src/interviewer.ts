import { installMemoryTools } from "./memory/tools.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import { readFile } from "node:fs/promises";
/** Agent-scoped production preset; only the five packaged references are readable. */
export const inject = ["systemPrompt", "tools", "laorenyunMemory"];
export async function apply(ctx: Context): Promise<void> {
  const root = new URL("../skills/oral-history-interviewer/", import.meta.url);
  const skill = (await readFile(new URL("SKILL.md", root), "utf8")).replace(
    /^---[\s\S]*?---\s*/,
    "",
  );
  ctx.systemPrompt.section({
    name: "oral-history-interviewer",
    order: 0,
    complete: true,
    text: skill,
  });
  installMemoryTools(ctx);
  const names = [
    "questioning",
    "chronology",
    "sensitive-topics",
    "clarification",
    "branch-policy",
  ];
  const reference = new Map<string, string>();
  for (const name of names)
    reference.set(
      name,
      await readFile(new URL(`references/${name}.md`, root), "utf8"),
    );
  ctx.tools.register({
    name: "interview_reference",
    description:
      "按需读取口述史采访规范。只提供questioning、chronology、sensitive-topics、clarification、branch-policy。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: names } },
      required: ["name"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    execute: async (args) => {
      const name = (args as { name: string }).name;
      const text = reference.get(name);
      if (!text) throw new Error("Unknown interview reference");
      return text;
    },
  });
}

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-subagent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage, MessageId } from "@deepseek-ai/dsh-llm";
import type { DomainDatabase } from "../storage/database.ts";
import { DomainError, type Branch } from "../domain/types.ts";
import { InternalModel } from "./model.ts";
import { MemoryService } from "./service.ts";
import { MEMO_PROMPT, parseMemo, partialMemo } from "./branch.ts";
export interface Intelligence {
  db: DomainDatabase;
  memory: MemoryService;
  activate(parent: Agent, transcriptId: string): Promise<Branch>;
  finish(sessionId: string): Promise<void>;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    laorenyunMemory: Intelligence;
  }
}
export async function installIntelligence(
  ctx: Context,
  db: DomainDatabase,
  resolve: (id: string) => Promise<Agent>,
) {
  const stop = new AbortController(),
    model = new InternalModel(ctx.llm);
  const resolveBounded = async (id: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        resolve(id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DomainError("AGENT_TIMEOUT", "resolve memory model route"),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const route = async (id: string) => {
    const branch = await db.call("getBranch", id);
    const agent = await resolveBounded(branch?.parentSessionId ?? id);
    const c = agent.session.requestHeader()?.config ?? agent.options;
    if (!c.provider || !c.model)
      throw new DomainError("MODEL_CONFIG", "interview route missing");
    return { provider: c.provider, model: c.model };
  };
  const memory = new MemoryService(db, model, route, (code) =>
    ctx.logger.warn("laorenyun memory: " + code),
  );
  const opening = new Set<string>();
  const activate = async (parent: Agent, transcriptId: string) => {
    const b = await db.call("branchConsent", {
      parentSessionId: String(parent.id),
      transcriptId,
    });
    if (b.state !== "provisioning") return b;
    if (opening.has(b.id)) return b;
    opening.add(b.id);
    try {
      const children = await ctx.subagents.listChildren(
        parent.id,
        AbortSignal.timeout(5000),
      );
      if (!children.some((c) => String(c.id) === b.sessionId))
        await ctx.subagents.startContinuable({
          provider: "spawn",
          label: b.topic!,
          childId: SessionId(b.sessionId),
          request: {
            parent,
            prompt: [
              {
                type: "text",
                text: JSON.stringify({
                  role: "isolated-oral-history-branch",
                  topic: b.topic,
                  returnAnchor: b.returnAnchor,
                  policy:
                    "只围绕支线每次一个问题；不加载主线全历史；最多五次真人答案；愿意停止随时finish。",
                }),
              },
            ],
            maxDepth: 1,
            toolFilter: {
              allow: ["interview_reference", "interview_finish_branch"],
            },
          },
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
        });
      return await db.call("activateBranch", b.sessionId);
    } finally {
      opening.delete(b.id);
    }
  };
  // One persisted closing branch at a time; timer recovery owns retries, never detached unbounded jobs.
  const finalize = async (b: Branch) => {
    if (b.state === "closing") {
      const answers = await db.call("listTranscripts", b.sessionId);
      const input = {
        topic: b.topic!,
        sourceTurns: answers.map((t) => t.id),
        relatedNodes: [] as string[],
        inputRevision: b.answerCount,
      };
      let memo = partialMemo(input);
      let evidence: Branch["memoGeneration"];
      try {
        const generated = await model.json(
          await route(b.parentSessionId),
          MEMO_PROMPT,
          {
            ...input,
            returnAnchor: b.returnAnchor,
            answers: answers.map((t) => ({
              id: t.id,
              text: t.text.slice(0, 4000),
            })),
          },
          (text) => parseMemo(text, input),
          stop.signal,
        );
        memo = generated.value;
        evidence = generated.evidence;
      } catch {
        ctx.logger.warn("laorenyun branch: PARTIAL_MEMO");
      }
      b = await db.call("branchMemo", {
        sessionId: b.sessionId,
        memo,
        evidence,
      });
    }
    if (b.state === "closed" && !b.returned) {
      const parent = await resolveBounded(b.parentSessionId),
        id = MessageId(b.id);
      const exists =
        parent.session
          .snapshotEvents()
          .some((e) => e.type === "user/message" && e.data.id === id) ||
        [...parent.inbox.nextTurn, ...parent.inbox.nextStep].some(
          (m) => m.id === id,
        );
      if (!exists)
        parent.followup({
          ...createUserMessage({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  derivedBranchMemo: {
                    title: b.memo?.title,
                    keySentence: b.memo?.key_sentence,
                    summary: b.memo?.summary.slice(0, 1000),
                    status: b.memo?.status,
                  },
                  returnAnchor: b.returnAnchor,
                  instruction:
                    b.memo?.status === "complete"
                      ? b.memo.suggested_return_bridge
                      : "这段故事已经保存。请温和回到主线，避免重问此前问题。",
                  notice:
                    "memo是派生摘要，不是事实证据；需要核实时读取原始source。",
                }),
              },
            ],
            source: {
              kind: "plugin",
              plugin: "dsh-laorenyun",
              form: "notice",
              summary: "回到主采访",
            },
          }),
          id,
        });
      await parent.ctx.parallel("session/flush", parent.session);
      await db.call("branchReturned", b.sessionId);
    }
  };
  let recovery: Promise<void> | null = null;
  const tick = () => {
    if (recovery || stop.signal.aborted) return;
    recovery = (async () => {
      for (const b of await db.call("branchPending", null)) {
        if (b.state === "provisioning" && b.consentTranscriptId)
          await activate(
            await resolveBounded(b.parentSessionId),
            b.consentTranscriptId,
          );
        else await finalize(b);
      }
    })()
      .catch(() => ctx.logger.warn("laorenyun branch: RECOVERY_PENDING"))
      .finally(() => {
        recovery = null;
      });
  };
  ctx.provide("laorenyunMemory", {
    db,
    memory,
    activate,
    finish: async (id: string) => {
      await db.call("branchClosing", id);
      tick();
    },
  } satisfies Intelligence);
  await memory.start();
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    stop.abort();
    await memory.close();
    await recovery;
  };
}

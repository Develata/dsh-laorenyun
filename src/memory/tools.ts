import type { Context } from "@deepseek-ai/cordis";
import { DomainError } from "../domain/types.ts";
import type { TimelineQuery, TimelineMethod } from "./types.ts";
import type {} from "./host.ts";
export function installMemoryTools(ctx: Context) {
  // Agent-scoped closure, released with its preset. Budget resets only at a real turn boundary.
  let turnNumber = 0,
    calls = 0,
    chars = 0;
  ctx.on("agent/pre-step", async ({ turn }, next) => {
    if (turn !== turnNumber) {
      turnNumber = turn;
      calls = 0;
      chars = 0;
    }
    return next();
  });
  const tools: TimelineMethod[] = [
    "overview",
    "search",
    "get_node",
    "get_period",
    "get_neighbors",
    "get_sources",
    "get_conflicts",
    "get_unresolved",
    "get_drifting_memories",
  ];
  for (const method of tools)
    ctx.tools.register({
      name: "timeline_" + method,
      description:
        method === "get_sources"
          ? "显式深读节点证据，最多10段/8000字；不能把摘要当证据。"
          : `只读时间记忆查询 ${method}；先索引再深读，查询失败继续当前话题。`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          revision: { type: "integer" },
          text: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
          personId: { type: "string" },
          placeId: { type: "string" },
          status: { type: "string" },
          limit: { type: "integer" },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      execute: async (args) => {
        if (++calls > 6)
          throw new DomainError("TOOL_BUDGET", "six memory queries per turn");
        const output = JSON.stringify(
          await ctx.laorenyunMemory.db.call("timeline", {
            ...(args as Omit<TimelineQuery, "method">),
            method,
          }),
        );
        if (chars + output.length > 12000)
          throw new DomainError(
            "CONTEXT_BUDGET",
            "memory deep reads exhausted for this turn",
          );
        chars += output.length;
        return output;
      },
    });
  ctx.tools.register({
    name: "interview_propose_branch",
    description: "有价值侧题先登记提议，再自然问用户是否愿意。不得自动开始。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string" },
        returnAnchor: { type: "string" },
      },
      required: ["topic", "returnAnchor"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_a, v) => [{ type: "text", text: String(v) }],
    },
    execute: async (args, exec) => {
      if (!exec.agent) throw new DomainError("SESSION_REQUIRED", "branch");
      const id = String(exec.agent.id);
      const latest = (await ctx.laorenyunMemory.db.call("getReceipts", id))[0]
        ?.transcript;
      if (!latest) throw new DomainError("SOURCE_REQUIRED", "branch proposal");
      const b = await ctx.laorenyunMemory.db.call("branchProposal", {
        parentSessionId: id,
        transcriptId: latest.id,
        ...(args as { topic: string; returnAnchor: string }),
      });
      return JSON.stringify({
        state: b.state,
        topic: b.topic,
        instruction: "仅邀请，等待明确同意后调用interview_accept_branch。",
      });
    },
  });
  ctx.tools.register({
    name: "interview_accept_branch",
    description: "仅在用户明确愿意探索已提议侧题时调用；Host核验最新真人回答。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_a, v) => [{ type: "text", text: String(v) }],
    },
    execute: async (_args, exec) => {
      if (!exec.agent) throw new DomainError("SESSION_REQUIRED", "branch");
      const latest = (
        await ctx.laorenyunMemory.db.call("getReceipts", String(exec.agent.id))
      )[0]?.transcript;
      if (!latest) throw new DomainError("CONSENT_REQUIRED", "answer");
      const b = await ctx.laorenyunMemory.activate(exec.agent, latest.id);
      if (b.state === "active") exec.concludeTurn();
      return b.state === "active"
        ? "支线已开始，界面将进入侧题。"
        : "用户未同意，继续主线。";
    },
  });
  ctx.tools.register({
    name: "interview_finish_branch",
    description: "用户想回主线或支线自然结束时调用。不可嵌套支线。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_a, v) => [{ type: "text", text: String(v) }],
    },
    execute: async (_args, exec) => {
      if (!exec.agent) throw new DomainError("SESSION_REQUIRED", "branch");
      await ctx.laorenyunMemory.finish(String(exec.agent.id));
      exec.concludeTurn();
      return "支线已保存，正在回到主采访。";
    },
  });
  ctx.tools.register({
    name: "interview_next_region",
    description:
      "只在当前话题自然结束、没有更好追问且用户没选新话题时调用；不在故事中途调度。用户拒谈优先。",
    parameters: {
      type: "object",
      properties: {
        boundary: { type: "boolean" },
        userChoseTopic: { type: "boolean" },
        currentMonth: { type: ["integer", "null"] },
      },
      required: ["boundary", "userChoseTopic", "currentMonth"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_a, v) => [{ type: "text", text: String(v) }],
    },
    execute: async (args, exec) => {
      if (!exec.agent) throw new DomainError("SESSION_REQUIRED", "schedule");
      const id = String(exec.agent.id);
      if (await ctx.laorenyunMemory.db.call("getBranch", id))
        throw new DomainError("MAIN_ONLY", "schedule");
      const latest = (await ctx.laorenyunMemory.db.call("getReceipts", id))[0]
        ?.transcript;
      if (!latest) return "继续当前线索。";
      const result = await ctx.laorenyunMemory.db.call("schedule", {
        ...(args as {
          boundary: boolean;
          userChoseTopic: boolean;
          currentMonth: number | null;
        }),
        sessionId: id,
        transcriptId: latest.id,
      });
      return JSON.stringify({
        region: result.selected
          ? { start: result.selected.start, end: result.selected.end }
          : null,
        reason: result.reason,
        instruction: "自然询问，不向用户解释评分或系统选择。",
      });
    },
  });
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const value = await next();
    if (!context.agent) return value;
    const branch = await ctx.laorenyunMemory.db.call(
      "getBranch",
      String(context.agent.id),
    );
    if (branch?.topic) {
      value.contexts.push({
        name: "laorenyun-branch",
        text: JSON.stringify({
          role: "Branch",
          topic: branch.topic,
          returnAnchor: branch.returnAnchor,
          answers: branch.answerCount,
          limit: 5,
          policy:
            "只围绕本侧题；不展开新支线；用户要回去就finish；不读Main完整档案。",
        }),
      });
      return value;
    }
    try {
      const [overview, conflicts, unresolved] = await Promise.all([
        ctx.laorenyunMemory.db.call("timeline", {
          method: "overview",
          limit: 12,
        }),
        ctx.laorenyunMemory.db.call("timeline", {
          method: "get_conflicts",
          limit: 3,
        }),
        ctx.laorenyunMemory.db.call("timeline", {
          method: "get_unresolved",
          limit: 2,
        }),
      ]);
      const content = JSON.stringify({
        objective: "沿人生时间主线温和采访；每次一个主问题",
        derived: true,
        graphRevision: overview.graphRevision,
        generationVersion: 1,
        nodes: overview.items,
        conflicts: conflicts.items,
        unresolved: unresolved.items,
        policy:
          "索引和摘要不是证据。需要事实细节用timeline_get_node/get_sources。不要全档扫描；冲突仅在相关且适宜时轻问。",
      });
      value.contexts.push({
        name: "laorenyun-memory",
        text: content.slice(0, 8000),
      });
    } catch {
      value.contexts.push({
        name: "laorenyun-memory",
        text: "记忆查询暂不可用，继续近期对话，不声称记忆为空。",
      });
    }
    return value;
  });
}

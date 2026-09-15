import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-subagent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Foundation } from "./application.ts";
import {
  DomainError,
  operation,
  type BranchId,
  type SourceId,
  type SpeakerIdentity,
} from "./domain/types.ts";
import { browserHuman } from "./host/human-message.ts";
import { FixtureLlm } from "./probes/llm.ts";
export interface Config {
  dataDir: string;
  probes: boolean;
  developer: boolean;
}
export const Config = z.object({
  dataDir: z.string().required(),
  probes: z.boolean().default(false),
  developer: z.boolean().default(false),
});
export const inject = [
  "agents",
  "llm",
  "connection",
  "webServer",
  "sessionController",
  "subagents",
];
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.dataDir))
    throw new DomainError("CONFIG_ERROR", "dataDir must be absolute");
  const app = await Foundation.open(config.dataDir);
  ctx.effect(() => () => app.close());
  if (config.probes)
    ctx.effect(() =>
      ctx.llm.registerAdapter(["laorenyun-fixture"], new FixtureLlm()),
    );
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const rejected = new Set<string>();
    for (const message of messages) {
      if (message.role !== "user") continue;
      const input = browserHuman(String(agent.id), message);
      if (!input) continue;
      const receipt = await app.db.call("acceptHuman", input, {
        signal,
        deadline: Date.now() + 5000,
      });
      if (receipt.blocked && !receipt.transcript)
        rejected.add(String(message.id));
    }
    if (rejected.size === messages.length && rejected.size > 0)
      return { kind: "reject" };
    const decision = await next();
    if (decision.kind === "reject" || rejected.size === 0) return decision;
    return {
      ...decision,
      messages: decision.messages.filter((m) => !rejected.has(String(m.id))),
    };
  });
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/laorenyun/healthz",
      handler: async (_req, res) => {
        try {
          await app.db.call("health", null, operation(1500));
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end('{"status":"ready"}');
        } catch {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end('{"status":"degraded"}');
        }
      },
    }),
  );
  // Supported authenticated Fetch routes. This is a bounded Phase 1 probe API,
  // not a replacement transport, router, or general RPC framework.
  const route = (
    name: string,
    handler: (body: Record<string, unknown>) => Promise<unknown>,
  ) =>
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: `/api/laorenyun/${name}`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          try {
            const bytes = await request.text();
            if (bytes.length > 20000)
              throw new DomainError("INVALID_INPUT", "request too large");
            const body: unknown = JSON.parse(bytes);
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new DomainError("INVALID_INPUT", "object required");
            const value = await handler(body as Record<string, unknown>);
            return Response.json(
              { ok: true, value },
              { headers: { "Cache-Control": "no-store" } },
            );
          } catch (error) {
            return Response.json(
              {
                ok: false,
                error:
                  error instanceof DomainError
                    ? error.code
                    : "OPERATION_FAILED",
              },
              { status: 400 },
            );
          }
        },
      }),
    );
  route("state", async (b) => {
    const sessionId = String(b.sessionId ?? "");
    return {
      probes: config.probes,
      developer: config.developer,
      speaker: await app.db.call("getSessionSpeaker", sessionId),
      draft: sessionId ? await app.db.call("getDraft", sessionId) : null,
      branch: sessionId ? await app.db.call("getBranch", sessionId) : null,
    };
  });
  route("speaker", async (b) =>
    app.db.call("setSessionSpeaker", {
      sessionId: String(b.sessionId),
      speaker: b.speaker as SpeakerIdentity,
    }),
  );
  route("source", async (b) => {
    const source = await app.db.call(
      "getSource",
      String(b.sourceId) as SourceId,
    );
    if (!source || source.sessionId !== b.sessionId)
      throw new DomainError("NOT_FOUND", "source in session");
    return source;
  });
  route("save-draft", async (b) =>
    app.db.call("saveDraft", {
      id: String(b.sourceId) as SourceId,
      expectedRevision: Number(b.revision),
      text: String(b.text),
    }),
  );
  route("cancel", async (b) =>
    app.db.call("cancelSource", String(b.sourceId) as SourceId),
  );
  if (config.probes) {
    route("fake", async (b) =>
      app.fakeDraft(String(b.sessionId), b.speaker as SpeakerIdentity),
    );
    route("evidence", async (b) => ({
      health: await app.db.call("health", null),
      transcripts: await app.db.call("listTranscripts", String(b.sessionId)),
      branch: await app.db.call("getBranch", String(b.sessionId)),
    }));
    route("branch", async (b) => {
      const parentId = String(b.sessionId);
      const resolved = await ctx.sessionController.resolveAgent(
        SessionId(parentId),
      );
      if ("error" in resolved)
        throw new DomainError("SESSION_ERROR", resolved.error.message);
      const existing = await app.db.call("getParentBranch", parentId);
      if (existing?.state === "active") return existing;
      if (existing) {
        const children = await ctx.subagents.listChildren(
          SessionId(parentId),
          AbortSignal.timeout(5000),
        );
        if (children.some((c) => String(c.id) === existing.sessionId))
          return app.db.call("activateBranch", existing.sessionId);
      }
      const childId = SessionId(existing?.sessionId ?? randomUUID());
      const branch = existing ?? {
        id: randomUUID() as BranchId,
        parentSessionId: parentId,
        sessionId: String(childId),
        state: "provisioning" as const,
        answerCount: 0,
        memo: null,
      };
      if (!existing) await app.db.call("reserveBranch", branch);
      await ctx.subagents.startContinuable({
        provider: "spawn",
        label: "支线验证",
        childId,
        request: {
          parent: resolved.agent,
          prompt: [{ type: "text", text: "确定性的支线生命周期验证。" }],
          maxDepth: 1,
          toolFilter: { allow: [] },
        },
        signal: AbortSignal.timeout(10000),
      });
      return app.db.call("activateBranch", String(childId));
    });
  }
  ctx.logger.info(
    "laorenyun: database ready; schema=2; probes=" + String(config.probes),
  );
}

export type * from "./domain/types.ts";

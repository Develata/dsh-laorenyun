import { createUserMessage, MessageId } from "@deepseek-ai/dsh-llm";
import { SpeechService } from "./speech/service.ts";
import { TencentFlashAsrProvider } from "./speech/tencent-flash.ts";
import { TencentTtsProvider } from "./speech/tencent-tts.ts";
import { boundedBody } from "./speech/bounds.ts";
import { MAX_AUDIO_BYTES, MAX_RECORDING_MS } from "./domain/speech.ts";
import { parseSourceReference } from "./domain/source-reference.ts";
import type { MediaId } from "./domain/types.ts";
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
  const speech = new SpeechService(
    app,
    config.dataDir,
    () =>
      new TencentFlashAsrProvider({
        appId: process.env.TENCENTCLOUD_APP_ID ?? "",
        secretId: process.env.TENCENTCLOUD_SECRET_ID ?? "",
        secretKey: process.env.TENCENTCLOUD_SECRET_KEY ?? "",
        engine: process.env.TENCENT_ASR_ENGINE || "16k_zh_en",
        timeoutMs: Number(process.env.TENCENT_ASR_TIMEOUT_MS || 90000),
      }),
    () =>
      new TencentTtsProvider({
        secretId: process.env.TENCENTCLOUD_SECRET_ID ?? "",
        secretKey: process.env.TENCENTCLOUD_SECRET_KEY ?? "",
        voice: Number(process.env.TENCENT_TTS_VOICE || 101001),
        speed: Number(process.env.TENCENT_TTS_SPEED || -0.5),
        volume: Number(process.env.TENCENT_TTS_VOLUME || 0),
        timeoutMs: Number(process.env.TENCENT_TTS_TIMEOUT_MS || 60000),
      }),
  );
  await speech.initialize();
  ctx.effect(() => async () => {
    await speech.close();
    await app.close();
  });
  const resolve = async (id: string) => {
    if (!id || id.length > 128)
      throw new DomainError("INVALID_SESSION", "session identity");
    const result = await ctx.sessionController.resolveAgent(SessionId(id));
    if ("error" in result)
      throw new DomainError("SESSION_ERROR", "interview is unavailable");
    return result.agent;
  };
  const reconcile = async (id: string) => {
    const agent = await resolve(id);
    const receipts = await app.db.call("getReceipts", id);
    // Public native snapshot; no filesystem log parsing and no new-ID retransmission.
    const events = agent.session.snapshotEvents();
    for (const { transcript, state } of receipts) {
      if (state === "session-observed") continue;
      const observed = events.some(
        (e) =>
          e.type === "user/message" &&
          String(e.data.id) === transcript.messageId &&
          e.data.source.kind === "user" &&
          "rpcId" in e.data.source &&
          e.data.source.rpcId === transcript.requestId,
      );
      if (observed)
        await app.db.call("markReceipt", {
          transcriptId: transcript.id,
          state: "session-observed",
        });
    }
    const final = events.findLast(
      (e) =>
        e.type === "assistant/message" &&
        e.data.message.content.some((c) => c.type === "text") &&
        !e.data.message.content.some((c) => c.type === "tool-call"),
    );
    if (final?.type === "assistant/message" && agent.status === "idle") {
      const text = final.data.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      await app.db.call("putReply", {
        sessionId: id,
        messageId: String(final.data.message.id),
        text,
        createdAt: Date.now(),
      });
    }
    return agent;
  };
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
    if (decision.kind === "reject") return decision;
    return {
      ...decision,
      messages: decision.messages
        .filter((m) => !rejected.has(String(m.id)))
        .map((m) => {
          if (m.source.kind !== "user") return m;
          const ref = parseSourceReference(
            m.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
          );
          if (!ref.sourceId) return m;
          return {
            ...m,
            source: { ...m.source, laorenyunSourceId: ref.sourceId },
            content: m.content.map((c) =>
              c.type === "text"
                ? { ...c, text: parseSourceReference(c.text).text }
                : c,
            ),
          };
        }),
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
    const agent = sessionId ? await reconcile(sessionId) : null;
    return {
      interview: sessionId
        ? await app.db.call("getInterview", sessionId)
        : null,
      reply: sessionId ? await app.db.call("getReply", sessionId) : null,
      processing: agent?.status === "running",
      receipts: sessionId
        ? (await app.db.call("getReceipts", sessionId)).map((r) => ({
            state: r.state,
            text: r.transcript.text,
          }))
        : [],
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
  route("begin", async (b) => {
    const id = String(b.sessionId);
    const agent = await resolve(id);
    const init = await app.db.call("beginInterview", {
      sessionId: id,
      bootstrapId: randomUUID(),
      createdAt: Date.now(),
    });
    const exists =
      agent.session
        .snapshotEvents()
        .some(
          (e) =>
            e.type === "user/message" && String(e.data.id) === init.bootstrapId,
        ) ||
      [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(
        (m) => String(m.id) === init.bootstrapId,
      );
    if (!exists && (await app.db.call("listTranscripts", id)).length === 0) {
      agent.followup({
        ...createUserMessage({
          content: [
            {
              type: "text",
              text: "用户点击开始讲我的故事。这是应用初始化，不是用户口述事实。请开始口述史采访：我们先从最开始聊起吧，您是在哪里出生的，大概是哪一年？只问这一组紧密相关的问题。",
            },
          ],
          source: {
            kind: "plugin",
            plugin: "dsh-laorenyun",
            form: "notice",
            summary: "采访开始",
          },
        }),
        id: MessageId(init.bootstrapId),
      });
      await agent.ctx.parallel("session/flush", agent.session);
    }
    return init;
  });
  route("pause", async (b) => {
    const agent = await resolve(String(b.sessionId));
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return { paused: true };
  });
  route("reserve-recording", async (b) => {
    await resolve(String(b.sessionId));
    return speech.reserve(String(b.sessionId), String(b.sourceId) as SourceId);
  });
  route("recognize", (b) =>
    speech.recognize(String(b.sessionId), String(b.sourceId) as SourceId),
  );
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: "/api/laorenyun/upload",
      methods: ["POST"],
      requestBody: "streaming",
      fetch: async (request) => {
        try {
          return await speech.exclusive("upload", async () => {
            const url = new URL(request.url);
            const id = url.searchParams.get("sourceId") as SourceId;
            const sessionId = url.searchParams.get("sessionId");
            const source = await app.db.call("getSource", id);
            if (
              !source ||
              source.sessionId !== sessionId ||
              source.status !== "draft"
            )
              throw new DomainError("SOURCE_NOT_DRAFT", "upload source");
            const mime = request.headers.get("content-type") ?? "";
            if (
              !/^audio\/(webm|mp4|ogg|wav|mpeg)(;.*)?$/.test(mime) ||
              mime.length > 100
            )
              throw new DomainError("UNSUPPORTED_AUDIO", "recording format");
            const duration = Number(request.headers.get("x-duration-ms"));
            if (
              !Number.isFinite(duration) ||
              duration <= 0 ||
              duration > MAX_RECORDING_MS + 2000
            )
              throw new DomainError("INVALID_INPUT", "recording duration");
            const op = speech.context(60000);
            const signal = AbortSignal.any([request.signal, op.signal]);
            const bytes = await boundedBody(
              request.body,
              MAX_AUDIO_BYTES,
              signal,
            );
            if (bytes.length === 0)
              throw new DomainError("INVALID_INPUT", "empty recording");
            const media = await app.recordings.write(bytes, mime, false, op, {
              id: id as unknown as MediaId,
              sourceId: id,
              durationMs: duration,
              capturedAt: source.createdAt,
            });
            const result = await app.db.call("attachRecording", {
              sourceId: id,
              mediaId: media.id,
            });
            return Response.json({ ok: true, value: result });
          });
        } catch (error) {
          return Response.json(
            {
              ok: false,
              error:
                error instanceof DomainError ? error.code : "UPLOAD_FAILED",
            },
            { status: 400 },
          );
        }
      },
    }),
  );
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: "/api/laorenyun/tts",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const b = (await request.json()) as {
            sessionId: string;
            messageId: string;
          };
          const audio = await speech.synthesize(b.sessionId, b.messageId);
          return new Response(Buffer.from(audio.bytes), {
            headers: {
              "Content-Type": audio.mime,
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          return Response.json(
            {
              ok: false,
              error: error instanceof DomainError ? error.code : "TTS_FAILED",
            },
            { status: 400 },
          );
        }
      },
    }),
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
    "laorenyun: database ready; schema=3; probes=" + String(config.probes),
  );
}

export type * from "./domain/types.ts";

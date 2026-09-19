import { InternalModel } from "./memory/model.ts";
import { speechSettings } from "./speech/settings.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { Archives } from "./archive/registry.ts";
import { DomainDatabase } from "./storage/database.ts";
import type { Intelligence } from "./memory/host.ts";
import { DerivedService } from "./derived/service.ts";
import { readExport } from "./derived/export.ts";
import type { Kind } from "./derived/types.ts";
import { installIntelligence } from "./memory/host.ts";
import { fixtureAsr, fixtureTts } from "./probes/speech.ts";
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
  "workspaceRegistry",
  "settings",
  "sessionPersistence",
];
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.dataDir))
    throw new DomainError("CONFIG_ERROR", "dataDir must be absolute");
  const speechConfig = speechSettings(ctx);
  const archives = await Archives.open(ctx, config.dataDir);
  const shared = await DomainDatabase.open(config.dataDir);
  const internalModel = new InternalModel(ctx.llm);
  type Runtime = {
    id: string;
    root: string;
    app: Foundation;
    speech: SpeechService;
    derived: DerivedService;
    intelligence: Intelligence;
    close: () => Promise<void>;
  };
  const scope = new AsyncLocalStorage<Runtime>();
  const runtimes = new Map<string, Promise<Runtime>>();
  function current() {
    const r = scope.getStore();
    if (!r)
      throw new DomainError(
        "ARCHIVE_REQUIRED",
        "missing explicit operation scope",
      );
    return r;
  }
  function proxy<K extends "app" | "speech" | "derived">(key: K): Runtime[K] {
    return new Proxy({} as Runtime[K], {
      get(_target, p) {
        const v = current()[key];
        const field = Reflect.get(v, p);
        return typeof field === "function" ? field.bind(v) : field;
      },
    });
  }
  const app = proxy("app"),
    speech = proxy("speech"),
    derived = proxy("derived");
  const runtime = (id: string): Promise<Runtime> => {
    archives.get(id);
    let pending = runtimes.get(id);
    if (!pending) {
      pending = (async () => {
        const root = archives.dataRoot(id);
        const app = await Foundation.open(root, shared);
        const speech = new SpeechService(
          app,
          root,
          () =>
            config.probes && process.env.LAORENYUN_SPEECH_FIXTURE === "true"
              ? fixtureAsr
              : new TencentFlashAsrProvider({
                  appId: speechConfig().appId,
                  secretId: speechConfig().secretId,
                  secretKey: speechConfig().secretKey,
                  engine: speechConfig().engine,
                  timeoutMs: Number(
                    process.env.TENCENT_ASR_TIMEOUT_MS || 90000,
                  ),
                }),
          () =>
            config.probes && process.env.LAORENYUN_SPEECH_FIXTURE === "true"
              ? fixtureTts
              : new TencentTtsProvider({
                  secretId: speechConfig().secretId,
                  secretKey: speechConfig().secretKey,
                  voice: speechConfig().voice,
                  speed: speechConfig().speed,
                  volume: Number(process.env.TENCENT_TTS_VOLUME || 0),
                  timeoutMs: Number(
                    process.env.TENCENT_TTS_TIMEOUT_MS || 60000,
                  ),
                }),
        );
        await speech.initialize();

        const r = { id, root, app, speech } as Runtime;
        await scope.run(r, async () => {
          const installed = await installIntelligence(
            ctx,
            app.db,
            resolve,
            internalModel,
          );
          r.intelligence = installed.intelligence;
          r.derived = new DerivedService(
            app.db,
            r.intelligence.model,
            root,
            (code) => ctx.logger.warn("laorenyun derived: " + code),
          );
          try {
            await r.derived.start();
          } catch (error) {
            await Promise.allSettled([installed.close(), speech.close()]);
            throw error;
          }
          r.close = async () => {
            const results = await Promise.allSettled([
              r.derived.close(),
              installed.close(),
              speech.close(),
            ]);
            if (results.some((result) => result.status === "rejected"))
              throw new DomainError("ARCHIVE_CLOSE_FAILED", "archive shutdown");
          };
        });
        return r;
      })();
      runtimes.set(id, pending);
      pending.catch(() => runtimes.delete(id));
    }
    return pending;
  };
  ctx.provide("laorenyunMemory", {
    forSession: async (id: string) =>
      (await runtime(await archives.forSession(id))).intelligence,
  });
  const resolve = async (id: string) => {
    if (!id || id.length > 128)
      throw new DomainError("INVALID_SESSION", "session identity");
    const b = await app.db.call("getBranch", id);
    if (b) {
      const parent = await ctx.sessionController.resolveAgent(
        SessionId(b.parentSessionId),
      );
      if ("error" in parent)
        throw new DomainError("SESSION_ERROR", "branch parent unavailable");
      const child = ctx.agents.get(SessionId(id));
      if (child) return child;
      throw new DomainError(
        "CHILD_COLD",
        "native subagent prompt will resume child",
      );
    }
    const result = await ctx.sessionController.resolveAgent(SessionId(id));
    if ("error" in result)
      throw new DomainError("SESSION_ERROR", "interview is unavailable");
    return result.agent;
  };
  ctx.effect(() => async () => {
    const results = await Promise.allSettled(
      [...runtimes.values()].map(async (pending) => (await pending).close()),
    );
    await shared.close();
    if (results.some((r) => r.status === "rejected"))
      ctx.logger.warn("laorenyun archive shutdown: resource close failed");
  });
  for (const archive of archives.list()) await runtime(archive.id);
  const reconcile = async (id: string) => {
    const b = await app.db.call("getBranch", id);
    if (b) await resolve(b.parentSessionId);
    const agent = b
      ? (ctx.agents.get(SessionId(id)) ?? null)
      : await resolve(id);
    const receipts = await app.db.call("getReceipts", id);
    // Public native snapshot; no filesystem log parsing and no new-ID retransmission.
    const events = agent
      ? agent.session.snapshotEvents()
      : (
          await ctx.sessionController.inspect(
            SessionId(id),
            AbortSignal.timeout(5000),
          )
        ).events;
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
        !e.data.interrupted &&
        !e.data.message.content.some((c) => c.type === "tool-call"),
    );
    if (
      final?.type === "assistant/message" &&
      (!agent || agent.status === "idle")
    ) {
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
  ctx.on("agent/pre-step", async ({ agent, messages, signal, step }, next) =>
    scope.run(
      await runtime(await archives.forSession(String(agent.id))),
      async () => {
        if (step > 8) return { kind: "reject" };
        const rejected = new Set<string>();
        for (const message of messages) {
          if (message.role !== "user") continue;
          const input = browserHuman(String(agent.id), message);
          if (!input) continue;
          const receipt = await app.db.call("acceptHuman", input, {
            signal,
            deadline: Date.now() + 5000,
          });
          current().intelligence.memory.wake();
          if (receipt.branch?.state === "closing" && receipt.transcript) {
            // Public durable log admission; block any model step after the fifth answer.
            if (
              !agent.session
                .snapshotEvents()
                .some(
                  (e) => e.type === "user/message" && e.data.id === message.id,
                )
            ) {
              const ref = parseSourceReference(input.text);
              agent.session.append(
                "user/message",
                {
                  ...message,
                  content: [{ type: "text", text: ref.text }],
                  source: {
                    ...message.source,
                    ...(ref.sourceId
                      ? { laorenyunSourceId: ref.sourceId }
                      : {}),
                  },
                },
                { surfaceOp: "append" },
              );
              await agent.ctx.parallel("session/flush", agent.session);
            }
            rejected.add(String(message.id));
            await current().intelligence.finish(String(agent.id));
          }
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
      },
    ),
  );
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/laorenyun/healthz",
      handler: async (_req, res) => {
        try {
          await shared.call("health", null, operation(1500));
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
  const fetchRoute = (
    entry: Parameters<typeof ctx.connection.fetch.register>[0],
  ) => {
    const fetch = entry.fetch;
    return ctx.connection.fetch.register({
      ...entry,
      fetch: async (request) => {
        try {
          const id =
            request.headers.get("X-Laorenyun-Archive") ??
            new URL(request.url).searchParams.get("archive") ??
            archives.defaultId;
          return await scope.run(await runtime(id), () => fetch(request));
        } catch {
          return Response.json(
            { ok: false, error: "ARCHIVE_UNAVAILABLE" },
            { status: 400 },
          );
        }
      },
    });
  };
  // Supported authenticated Fetch routes. This is a bounded application API,
  // not a replacement transport, router, or general RPC framework.
  const route = (
    name: string,
    handler: (body: Record<string, unknown>) => Promise<unknown>,
  ) =>
    ctx.effect(() =>
      fetchRoute({
        path: `/api/laorenyun/${name}`,
        methods: ["POST"],
        requestBody: "streaming",
        fetch: async (request) => {
          try {
            const bytes = new TextDecoder().decode(
              await boundedBody(
                request.body,
                80000,
                AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
              ),
            );
            if (bytes.length > 20000)
              throw new DomainError("INVALID_INPUT", "request too large");
            const body: unknown = JSON.parse(bytes);
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new DomainError("INVALID_INPUT", "object required");
            const input = body as Record<string, unknown>;
            if (
              typeof input.sessionId === "string" &&
              input.sessionId &&
              (await archives.forSession(input.sessionId)) !== current().id
            )
              throw new DomainError("ARCHIVE_MISMATCH", "session archive");
            const value = await handler(input);
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
  route("archives", async () => ({
    defaultId: archives.defaultId,
    items: archives.list(),
  }));
  route("archive-create", async (b) => archives.create(String(b.title ?? "")));
  route("river", async (b) =>
    app.db.call("river", {
      start: b.start === undefined ? undefined : Number(b.start),
      end: b.end === undefined ? undefined : Number(b.end),
      offset: Number(b.offset ?? 0),
      drifting: b.drifting === true,
    }),
  );
  route("memory-detail", async (b) =>
    app.db.call("memoryDetail", {
      id: String(b.id),
      revision: b.revision === undefined ? undefined : Number(b.revision),
    }),
  );
  route("derived-list", async () => app.db.call("derivedList", null));
  route("derived-view", async (b) => {
    const g = await app.db.call("derivedGet", String(b.id));
    return {
      id: g.id,
      kind: g.kind,
      state: g.state,
      result: g.result,
      progress: g.progress,
      sampleCount: g.manifest.transcripts.length,
      stale:
        g.manifest.graphRevision !==
        (await app.db.call("timeline", { method: "overview", limit: 1 }))
          .graphRevision,
    };
  });
  route("derived-start", async (b) => {
    if (
      !["persona", "biography", "export"].includes(String(b.kind)) ||
      !/^[a-f0-9-]{36}$/.test(String(b.id))
    )
      throw new DomainError("INVALID_INPUT", "generation");
    const agent = await reconcile(String(b.sessionId));
    if (!agent)
      throw new DomainError("SESSION_ERROR", "main interview required");
    const c = agent.session.requestHeader()?.config ?? agent.options;
    if (!c.provider || !c.model)
      throw new DomainError("MODEL_CONFIG", "model route");
    const g = await app.db.call("derivedBegin", {
      id: String(b.id),
      kind: b.kind as Kind,
      narrativeVersion: 2,
      sessionId: String(b.sessionId),
      route: { provider: c.provider, model: c.model },
      personaId: typeof b.personaId === "string" ? b.personaId : undefined,
      biographyId:
        typeof b.biographyId === "string" ? b.biographyId : undefined,
    });
    derived.tick();
    return { id: g.id, state: g.state };
  });
  route("derived-cancel", async (b) => {
    await derived.cancel(String(b.id));
    return null;
  });
  route("correction", async (b) => {
    const sessionId = String(b.sessionId);
    await resolve(sessionId);
    return app.db.call("correctionCreate", {
      sessionId,
      nodeId: String(b.nodeId),
      revision: Number(b.revision),
      text: String(b.text ?? "").trim(),
    });
  });
  ctx.effect(() =>
    fetchRoute({
      path: "/api/laorenyun/export-download",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const u = new URL(request.url),
            g = await app.db.call("derivedGet", u.searchParams.get("id") ?? ""),
            name = u.searchParams.get("name") ?? "";
          const bytes = await readExport(current().root, g, name);
          return new Response(bytes as BodyInit, {
            headers: {
              "Content-Type":
                name === "index.html"
                  ? "text/html; charset=utf-8"
                  : name === "memories.json"
                    ? "application/json"
                    : "text/markdown; charset=utf-8",
              "Content-Disposition": `attachment; filename="${name}"`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("导出文件暂不可用", { status: 400 });
        }
      },
    }),
  );
  ctx.effect(() =>
    fetchRoute({
      path: "/api/laorenyun/source-audio",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const u = new URL(request.url),
            detail = await app.db.call("memoryDetail", {
              id: u.searchParams.get("node") ?? "",
              revision: Number(u.searchParams.get("revision")),
            });
          const selected = detail.sources.find(
            (s) => s.transcript.id === u.searchParams.get("transcript"),
          );
          if (!selected?.media)
            throw new DomainError("NOT_FOUND", "original audio");
          const bytes = await app.recordings.read(
            selected.media.id,
            operation(10000),
          );
          return new Response(bytes as BodyInit, {
            headers: {
              "Content-Type": selected.media.mime,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("原声暂不可用", { status: 400 });
        }
      },
    }),
  );
  route("state", async (b) => {
    const sessionId = String(b.sessionId ?? "");
    const agent = sessionId ? await reconcile(sessionId) : null;
    const receipts = sessionId
      ? await app.db.call("getReceipts", sessionId)
      : [];
    const latest = receipts.at(-1)?.transcript;
    const extraction = latest
      ? await app.db.call("memoryOperation", `extract:${latest.id}`)
      : null;
    return {
      extracting:
        !!extraction &&
        ["pending", "running", "proposed", "validated"].includes(
          extraction.state,
        ),
      memoryFeedback: !latest
        ? "none"
        : extraction?.state === "applied" &&
            !!extraction.result?.proposals.length
          ? "added"
          : extraction?.state === "failed"
            ? "failed"
            : "saved",
      interview: sessionId
        ? await app.db.call("getInterview", sessionId)
        : null,
      reply: sessionId ? await app.db.call("getReply", sessionId) : null,
      processing: agent?.status === "running",
      receipts: receipts.map((r) => ({
        state: r.state,
        text: r.transcript.text,
      })),
      activeBranch: sessionId
        ? await app.db.call("getParentBranch", sessionId)
        : null,
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
    const branch = await app.db.call("getBranch", String(b.sessionId));
    if (branch) {
      await resolve(branch.parentSessionId);
      await ctx.sessionController.inspect(
        SessionId(String(b.sessionId)),
        AbortSignal.timeout(5000),
      );
    } else await resolve(String(b.sessionId));
    return speech.reserve(String(b.sessionId), String(b.sourceId) as SourceId);
  });
  route("recognize", (b) =>
    speech.recognize(String(b.sessionId), String(b.sourceId) as SourceId),
  );
  ctx.effect(() =>
    fetchRoute({
      path: "/api/laorenyun/upload",
      methods: ["POST"],
      requestBody: "streaming",
      fetch: async (request) => {
        try {
          return await speech.exclusive("upload", async () => {
            const url = new URL(request.url);
            const id = url.searchParams.get("sourceId") as SourceId;
            const sessionId = url.searchParams.get("sessionId");
            if (
              !sessionId ||
              (await archives.forSession(sessionId)) !== current().id
            )
              throw new DomainError("ARCHIVE_MISMATCH", "upload");
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
            const incomplete = request.headers.get("x-capture-incomplete");
            if (
              incomplete &&
              !["size-limit", "recorder-error", "stop-timeout"].includes(
                incomplete,
              )
            )
              throw new DomainError("INVALID_INPUT", "recording completeness");
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
              ...(incomplete
                ? {
                    captureIncomplete: incomplete as
                      | "size-limit"
                      | "recorder-error"
                      | "stop-timeout",
                  }
                : {}),
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
    fetchRoute({
      path: "/api/laorenyun/tts",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const b = (await request.json()) as {
            sessionId: string;
            messageId: string;
          };
          if ((await archives.forSession(b.sessionId)) !== current().id)
            throw new DomainError("ARCHIVE_MISMATCH", "tts");
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
      health: await shared.call("health", null),
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
    "laorenyun: database ready; schema=5; probes=" + String(config.probes),
  );
}

export type * from "./domain/types.ts";

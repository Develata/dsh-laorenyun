import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionSeq } from "@deepseek-ai/dsh-session";
/** Narrow published compaction service; supplied by the pinned base bundle, no extra implementation/package. */
interface NativeCompaction {
  compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export function installRetention(ctx: Context) {
  const retryAfter = new WeakMap<Agent, number>();
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    if (!messages.some((m) => m.source.kind === "user" && "rpcId" in m.source))
      return next();
    const surface = agent.session.surface.nodes;
    const retainedChars = surface.reduce((sum, seq) => {
      const e = agent.session.eventAt(seq);
      return (
        sum +
        (e && "content" in e.data ? JSON.stringify(e.data.content).length : 0)
      );
    }, 0);
    if (retainedChars <= 8000 && surface.length < (retryAfter.get(agent) ?? 0))
      return next();
    // Read only the currently retained surface; old archived log remains untouched.
    const humans: number[] = [];
    for (let i = surface.length - 1; i >= 0 && humans.length < 9; i--) {
      const e = agent.session.eventAt(surface[i]!);
      if (
        e?.type === "user/message" &&
        e.data.source.kind === "user" &&
        "rpcId" in e.data.source
      )
        humans.unshift(i);
    }
    if (humans.length < 9) return next();
    const first = agent.session.eventAt(surface[0]!);
    const start = first?.type === "system/message" ? 1 : 0;
    // Batch older turns: a one-turn summary can be larger than its source.
    const keep = humans[4]!; // Keep five recent turns plus incoming input; never the full archive.
    if (keep <= start) return next();
    const compaction = ctx.get("compaction") as NativeCompaction | undefined;
    if (!compaction)
      throw new Error(
        "MEMORY_CONTEXT: pinned native compaction service missing",
      );
    // The public implementation checks balanced tool boundaries, persists the replacement and preserves the log.
    try {
      await compaction.compactRegion(
        surface[start]!,
        surface[keep - 1]!,
        agent,
        AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      );
      retryAfter.delete(agent);
    } catch (error) {
      // Native compaction intentionally rejects a larger summary. Short testimony
      // needs no expansion: retain it under a strict character bound and retry
      // after more complete turns, never retry every token or swallow other errors.
      if (
        !(error instanceof Error) ||
        !error.message.includes("summary is not smaller") ||
        retainedChars > 8000
      )
        throw error;
      retryAfter.set(agent, surface.length + 8);
    }
    return next();
  });
}

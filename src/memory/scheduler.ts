import { DomainError } from "../domain/types.ts";
export interface Region {
  id: string;
  start: number;
  end: number;
  n: number;
  unresolved: number;
  gap: number;
}
export interface ScheduleInput {
  graphRevision: number;
  regions: Region[];
  currentMonth: number | null;
  deferred: string[];
  seed: number;
  boundary: boolean;
  userChoseTopic: boolean;
  temperature?: number;
  weights?: [number, number, number, number];
}
export function schedule(i: ScheduleInput) {
  const temperature = i.temperature ?? 0.25,
    weights = i.weights ?? [0.3, 0.3, 0.2, 0.2];
  if (
    !Number.isFinite(temperature) ||
    temperature <= 0 ||
    weights.some((w) => !Number.isFinite(w) || w < 0) ||
    i.regions.length > 12
  )
    throw new DomainError("INVALID_SCHEDULER", "bounded parameters");
  if (!i.boundary || i.userChoseTopic)
    return {
      graphRevision: i.graphRevision,
      seed: i.seed,
      temperature,
      weights,
      candidates: [],
      selected: null,
      reason: "local-continuity",
    };
  const candidates = i.regions
    .filter((r) => !i.deferred.includes(r.id))
    .map((r) => {
      const G = Math.min(1, Math.max(0, r.gap) / 120),
        C = 1 / (1 + Math.max(0, r.n)),
        U = Math.min(3, Math.max(0, r.unresolved)) / 3;
      const distance =
        i.currentMonth === null
          ? 120
          : Math.max(0, r.start - i.currentMonth, i.currentMonth - r.end);
      const R = Math.max(0, 1 - distance / 120),
        score =
          G * weights[0] + C * weights[1] + U * weights[2] + R * weights[3];
      return { ...r, G, C, U, R, score, probability: 0 };
    });
  const max = Math.max(...candidates.map((c) => c.score)),
    den = candidates.reduce(
      (sum, c) => sum + Math.exp((c.score - max) / temperature),
      0,
    );
  let x = i.seed | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const random = (x >>> 0) / 4294967296;
  let cumulative = 0,
    selected: Region | null = null;
  for (const c of candidates) {
    c.probability = Math.exp((c.score - max) / temperature) / den;
    cumulative += c.probability;
    if (!selected && random < cumulative) selected = c;
  }
  return {
    graphRevision: i.graphRevision,
    seed: i.seed,
    temperature,
    weights,
    candidates,
    selected,
    reason: selected ? "coverage-and-continuity" : "no-eligible-region",
  };
}

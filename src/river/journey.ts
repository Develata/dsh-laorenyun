import { arcPosition } from "./layout.ts";
/** Geometry in actual CSS pixels: y strictly increases so the river cannot self-cross. */
export function journeyPath(width: number, months: number) {
  const w = Math.max(240, width),
    height = Math.max(760, Math.min(14400, months * 3 + 160));
  const steps = Math.max(2, Math.ceil(height / 500));
  const center = w < 520 ? 36 : w * 0.5,
    swing = w < 520 ? 12 : Math.min(180, w * 0.2);
  let d = `M ${center} 70`,
    previous = center,
    y = 70;
  const weights = Array.from(
    { length: steps },
    (_, i) => [1.2, 0.85, 1.1, 0.75][i % 4]!,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < steps; i++) {
    const z = y + ((height - 140) * weights[i]!) / total;
    const x = center + (i % 2 ? -1 : 1) * swing * [0.7, 0.9, 0.3, 0.65][i % 4]!;
    // Vertical tangents at shared endpoints: smooth joins with strictly increasing y.
    d += ` C ${previous} ${y + (z - y) * 0.4}, ${x} ${y + (z - y) * 0.6}, ${x} ${z}`;
    previous = x;
    y = z;
  }
  return { d, height, width: w };
}
export interface ArcPath {
  getTotalLength(): number;
  getPointAtLength(s: number): { x: number; y: number };
}
/** True arc segment, at most 257 samples, never dash a different full path. */
export function intervalPath(
  path: ArcPath,
  start: number,
  end: number,
  t0: number,
  t1: number,
) {
  const l = path.getTotalLength(),
    a = arcPosition(start, t0, t1, l),
    b = arcPosition(end, t0, t1, l);
  const count = Math.min(256, Math.max(1, Math.ceil((b - a) / 8)));
  return Array.from({ length: count + 1 }, (_, i) => {
    const p = path.getPointAtLength(a + ((b - a) * i) / count);
    return `${i ? "L" : "M"} ${p.x} ${p.y}`;
  }).join(" ");
}

/** Offset actual arc samples along their local normal; decorative currents never alter time. */
export function currentPath(path: ArcPath, offset: number) {
  const length = path.getTotalLength(),
    count = Math.min(1024, Math.ceil(length / 12));
  return Array.from({ length: count + 1 }, (_, i) => {
    const s = (length * i) / count,
      p = path.getPointAtLength(s),
      a = path.getPointAtLength(Math.max(0, s - 2)),
      b = path.getPointAtLength(Math.min(length, s + 2));
    const norm = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const local = offset + 3 * Math.sin(i * 0.17);
    return `${i ? "L" : "M"} ${p.x + ((b.y - a.y) / norm) * local} ${p.y - ((b.x - a.x) / norm) * local}`;
  }).join(" ");
}

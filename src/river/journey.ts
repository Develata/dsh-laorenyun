import { arcPosition } from "./layout.ts";
/** Geometry in actual CSS pixels: y strictly increases so the river cannot self-cross. */
export function journeyPath(width: number, months: number) {
  const w = Math.max(240, width),
    height = Math.max(760, Math.min(14400, months * 3 + 160));
  const steps = Math.max(2, Math.ceil(height / 500));
  const center = w < 520 ? 36 : w * 0.5,
    swing = w < 520 ? 12 : Math.min(125, w * 0.16);
  let d = `M ${center} 70`;
  for (let i = 0; i < steps; i++) {
    const a = 70 + ((height - 140) * i) / steps,
      z = 70 + ((height - 140) * (i + 1)) / steps;
    const x = center + (i % 2 ? -swing : swing);
    d += ` C ${x} ${a + (z - a) / 3}, ${x} ${a + (2 * (z - a)) / 3}, ${center} ${z}`;
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

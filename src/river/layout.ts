import type { RiverNode } from "./types.ts";
export const RIVER_PATH =
  "M 92 48 C 255 65, 270 125, 151 160 S 44 251, 218 302 S 268 395, 133 447 S 71 529, 218 568";
export function arcPosition(
  month: number,
  start: number,
  end: number,
  length: number,
): number {
  return start === end
    ? length / 2
    : Math.max(0, Math.min(length, (length * (month - start)) / (end - start)));
}
export function anchors(nodes: RiverNode[]) {
  const dated = nodes
    .filter(
      (n) =>
        n.placement === "anchored" &&
        n.time.start !== null &&
        n.time.end !== null,
    )
    .sort((a, b) => a.time.start! - b.time.start! || a.id.localeCompare(b.id));
  const lanes = new Map<number, number>();
  return dated.map((n) => {
    const month = (n.time.start! + n.time.end!) / 2;
    const i = lanes.get(month) ?? 0;
    lanes.set(month, i + 1);
    return {
      node: n,
      month,
      lane: i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2),
      interval: n.time.precision !== "month" || n.time.start !== n.time.end,
    };
  });
}
export const timeLabel = (n: RiverNode) =>
  n.time.originalText ||
  (n.time.start === null
    ? "时间待确认"
    : `${Math.floor(n.time.start / 12)}年${n.time.precision === "month" ? `${(n.time.start % 12) + 1}月` : n.time.precision === "year" ? "内" : n.time.precision === "decade" ? "代" : "前后"}`);

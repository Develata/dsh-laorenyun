import { memoryPreview } from "./memory-preview.ts";
import React, { useEffect, useMemo, useState } from "react";
import type { RiverSnapshot } from "../river/types.ts";
import {
  storyTrees,
  treeGeometry,
  selectedCrossLinks,
} from "../river/trees.ts";
import type { ArcPath } from "../river/journey.ts";
import { timeLabel } from "../river/layout.ts";
const curve = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  `M ${a.x} ${a.y} C ${(a.x + b.x) / 2} ${a.y}, ${(a.x + b.x) / 2} ${b.y}, ${b.x} ${b.y}`;
function branchCurve(
  a: { x: number; y: number; direction?: { x: number; y: number } },
  b: { x: number; y: number; direction: { x: number; y: number } },
) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y),
    d = a.direction ?? b.direction;
  return `M ${a.x} ${a.y} C ${a.x + d.x * distance * 0.4} ${a.y + d.y * distance * 0.4}, ${b.x - b.direction.x * distance * 0.3} ${b.y - b.direction.y * distance * 0.3}, ${b.x} ${b.y}`;
}
function caption(text: string, label: string) {
  const year = label.match(/^(\d{4})年/);
  const prefix = text.startsWith(label)
    ? label
    : year && text.startsWith(year[0])
      ? year[0]
      : "";
  return prefix ? text.slice(prefix.length).replace(/^[，、,\s]+/, "") : text;
}
type Box = { x: number; y: number; width: number; height: number };
function captions(
  points: Array<{ id: string; x: number; y: number }>,
  width: number,
) {
  const result = new Map<string, Box>(),
    occupied: Box[] = points.map((p) => ({
      x: p.x - 23,
      y: p.y - 23,
      width: 46,
      height: 46,
    }));
  const overlap = (a: Box, b: Box) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  for (const p of points) {
    const candidates = [
      { x: p.x - 74, y: p.y + 25 },
      { x: p.x - 74, y: p.y - 95 },
      { x: p.x + 28, y: p.y - 34 },
      { x: p.x - 176, y: p.y - 34 },
    ].map((b) => ({
      ...b,
      x: Math.max(0, Math.min(width - 148, b.x)),
      y: Math.max(0, b.y),
      width: 148,
      height: 70,
    }));
    candidates.sort(
      (a, b) =>
        occupied.reduce((sum, r) => sum + overlap(a, r), 0) -
        occupied.reduce((sum, r) => sum + overlap(b, r), 0),
    );
    const chosen = candidates[0]!;
    result.set(p.id, chosen);
    occupied.push(chosen);
  }
  return result;
}
export function StoryForest({
  data,
  path,
  min,
  max,
  width,
  onSelect,
  drifting = false,
  onExtent,
}: {
  data: RiverSnapshot;
  path: ArcPath;
  min: number;
  max: number;
  width: number;
  onSelect: (id: string) => void;
  drifting?: boolean;
  onExtent?: (extent: number) => void;
}) {
  const trees = useMemo(
    () => storyTrees(data).filter((t) => t.drifting === drifting),
    [data, drifting],
  );
  const [expanded, setExpanded] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const nodes = new Map<string, (typeof data.nodes)[number]>(
    data.nodes.map((n) => [n.id, n]),
  );
  let groveTop = 100;
  const layouts = trees.map((t, i) => {
    const localPath: ArcPath = drifting
      ? {
          getTotalLength: () => 500,
          getPointAtLength: (s) => ({
            x: width < 520 ? 32 : width / 2,
            y: groveTop + (s - 250),
          }),
        }
      : path;
    const layout = {
      tree: t,
      ...treeGeometry(
        t,
        localPath,
        nodes.get(t.root)!,
        min,
        max,
        width,
        i % 2 ? 1 : -1,
      ),
    };
    if (drifting) {
      const visible =
        expanded === t.id
          ? layout.points
          : [layout.junction ?? layout.points[0]!];
      groveTop = Math.max(...visible.map((p) => p.y)) + 140;
    }
    return layout;
  });
  useEffect(() => {
    onExtent?.(
      Math.max(
        0,
        ...layouts.flatMap((l) =>
          (expanded === l.tree.id
            ? l.points
            : [l.junction ?? l.points[0]!]
          ).map((p) => p.y + 160),
        ),
      ),
    );
  }, [expanded, width, data, onExtent]);
  const visible = new Map(
    layouts.flatMap((l) =>
      l.points
        .filter((p) => expanded === l.tree.id || (!l.junction && p.depth === 0))
        .map((p) => [p.id, p] as const),
    ),
  );
  const pick = (id: string) => {
    setSelected(id);
    const n = nodes.get(id)!;
    memoryPreview.show(
      n,
      trees.find((t) => t.members.some((m) => m.id === id))?.members.length ??
        1,
    );
  };
  const key = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
  return (
    <g className="ly-story-forest">
      {selectedCrossLinks(data, selected).map((e, i) => {
        const a = visible.get(e.from),
          b = visible.get(e.to);
        return a && b ? (
          <g key={i}>
            <path d={curve(a, b)} className="ly-crosslink" />
            <text
              x={(a.x + b.x) / 2}
              y={(a.y + b.y) / 2 - 10}
              className="ly-relation-label"
            >
              {e.kind === "CAUSES" ? "讲述中的因果" : "相关故事"}
            </text>
          </g>
        ) : null;
      })}
      {layouts.map((l) => {
        const open = expanded === l.tree.id,
          root = l.points[0]!,
          count = l.tree.members.length + l.tree.hidden.length;
        const branch = l.tree.kind !== "single";
        const labels = captions(open ? l.points : [root], width);
        return (
          <g key={l.tree.id} data-story-root={l.tree.root}>
            <path
              d={curve(l.anchor, l.junction ?? root)}
              className="ly-tributary-root"
            />
            {(open || (!drifting && branch)) && (
              <g
                className={open ? "ly-tree-open" : "ly-tree-outline"}
                aria-hidden={!open || undefined}
              >
                {l.points
                  .filter((p) => p.parent !== null || l.junction !== null)
                  .map((p) => {
                    const parent =
                      l.points.find((x) => x.id === p.parent) ??
                      l.junction ??
                      root;
                    return (
                      <path
                        key={p.id}
                        d={branchCurve(parent, p)}
                        style={{
                          strokeWidth: [10, 7, 4, 2.5][
                            Math.min(3, p.depth + (l.junction ? 1 : 0))
                          ],
                          opacity: 1 - p.depth * 0.13,
                        }}
                        pathLength={1}
                        className={`ly-tributary ${l.tree.kind === "elaboration" ? "" : "ly-visual-group"}`}
                      />
                    );
                  })}
              </g>
            )}
            {l.junction && (
              <g
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-label={`${count}个故事，${open ? "收起" : "展开"}浏览分组`}
                onClick={() => setExpanded(open ? null : l.tree.id)}
                onKeyDown={key(() => setExpanded(open ? null : l.tree.id))}
              >
                <rect
                  x={l.junction.x - 23}
                  y={l.junction.y - 23}
                  width={46}
                  height={46}
                  fill="transparent"
                />
                <path
                  d={`M ${l.junction.x} ${l.junction.y - 14} Q ${l.junction.x + 28} ${l.junction.y} ${l.junction.x} ${l.junction.y + 14} Q ${l.junction.x - 28} ${l.junction.y} ${l.junction.x} ${l.junction.y - 14}`}
                  className="ly-junction"
                />
                <text
                  x={l.junction.x}
                  y={l.junction.y + 40}
                  textAnchor="middle"
                  className="ly-tree-control"
                >
                  {count} 个故事
                </text>
              </g>
            )}
            {(open ? l.points : l.junction ? [] : [root]).map((p) => {
              const n = nodes.get(p.id)!;
              const label = labels.get(p.id)!;
              const toggle = () =>
                p.depth === 0 && branch && !l.junction
                  ? setExpanded(open ? null : l.tree.id)
                  : pick(p.id);
              return (
                <g
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  aria-expanded={
                    p.depth === 0 && branch && !l.junction ? open : undefined
                  }
                  aria-label={`${timeLabel(n)}：${n.keySentence}${p.depth === 0 && branch && !l.junction ? `，${count}个故事，${open ? "收起" : "展开"}` : "，预览故事"}`}
                  onClick={toggle}
                  onKeyDown={key(toggle)}
                  className={`${p.depth > 0 || l.junction ? "ly-tree-leaf" : "ly-tree-root"} ${selected === p.id ? "ly-node-selected" : ""}`}
                >
                  <rect
                    x={p.x - 23}
                    y={p.y - 23}
                    width={46}
                    height={46}
                    fill="transparent"
                  />
                  <path
                    d={`M ${p.x - 17} ${p.y + 4} Q ${p.x - 10} ${p.y - 22} ${p.x + 20} ${p.y - 10} Q ${p.x + 14} ${p.y + 19} ${p.x - 17} ${p.y + 4}`}
                    className={`ly-stone ${n.hasOpenConflict || n.status !== "confirmed" ? "ly-stone-uncertain" : ""}`}
                  />
                  <text
                    x={p.x + 1}
                    y={p.y + 5}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize="13"
                  >
                    {p.depth === 0 && branch && !l.junction
                      ? ""
                      : n.hasOpenConflict
                        ? "!"
                        : ""}
                  </text>
                  <title>
                    {timeLabel(n)} · {n.keySentence}
                  </title>
                  {(p.depth === 0 || open) && (
                    <foreignObject
                      x={label.x}
                      y={label.y}
                      width={148}
                      height={70}
                      pointerEvents="auto"
                    >
                      <div className="ly-tree-caption">
                        <small>
                          {n.placement === "drifting" ? "" : timeLabel(n)}
                          {p.depth === 0 && branch && !l.junction
                            ? `${n.placement === "drifting" ? "" : " · "}${count} 个故事`
                            : ""}
                        </small>
                        <span>
                          {caption(n.keySentence, timeLabel(n)).slice(
                            0,
                            open ? 28 : 18,
                          )}
                        </span>
                      </div>
                    </foreignObject>
                  )}
                </g>
              );
            })}
            {open && !l.junction && (
              <g
                role="button"
                tabIndex={0}
                aria-label="查看这段主故事"
                onClick={() => pick(root.id)}
                onKeyDown={key(() => pick(root.id))}
              >
                <text
                  x={Math.max(10, Math.min(width - 150, root.x - 75))}
                  y={root.y - 38}
                  className="ly-tree-control"
                >
                  查看主故事 ↗
                </text>
              </g>
            )}
            {open && l.tree.hidden.length > 0 && (
              <g
                role="button"
                tabIndex={0}
                aria-label={`还有${l.tree.hidden.length}个故事，进入详情继续浏览`}
                onClick={() => onSelect(root.id)}
                onKeyDown={key(() => onSelect(root.id))}
              >
                <text x={12} y={root.y + 130}>
                  ＋{l.tree.hidden.length} 个相关故事，查看详情 →
                </text>
              </g>
            )}
          </g>
        );
      })}
      {selected &&
        visible.has(selected) &&
        (() => {
          const p = visible.get(selected)!;
          const occupied: Box[] = layouts.flatMap((l) => {
            const shown = l.points.filter((point) => visible.has(point.id));
            return [
              ...captions(shown, width).values(),
              ...shown.map((point) => ({
                x: point.x - 24,
                y: point.y - 24,
                width: 48,
                height: 48,
              })),
            ];
          });
          const candidates = [
            { x: p.x - 85, y: p.y - 150 },
            { x: p.x - 85, y: p.y + 110 },
            { x: p.x - 205, y: p.y - 22 },
            { x: p.x + 35, y: p.y - 22 },
          ].map((b) => ({
            ...b,
            x: Math.max(4, Math.min(width - 174, b.x)),
            y: Math.max(8, b.y),
            width: 170,
            height: 44,
          }));
          const cost = (box: Box) =>
            occupied.reduce(
              (sum, b) =>
                sum +
                Math.max(
                  0,
                  Math.min(box.x + box.width, b.x + b.width) -
                    Math.max(box.x, b.x),
                ) *
                  Math.max(
                    0,
                    Math.min(box.y + box.height, b.y + b.height) -
                      Math.max(box.y, b.y),
                  ),
              0,
            );
          candidates.sort((a, b) => cost(a) - cost(b));
          const action = candidates[0]!;
          return (
            <g
              role="button"
              tabIndex={0}
              aria-label="查看完整故事"
              onClick={() => onSelect(selected)}
              onKeyDown={key(() => onSelect(selected))}
            >
              <rect
                x={action.x}
                y={action.y}
                width={170}
                height={42}
                rx={3}
                fill="#345b50"
              />
              <text
                x={action.x + 85}
                y={action.y + 28}
                textAnchor="middle"
                fill="#fff"
                fontSize="17"
              >
                查看完整故事 →
              </text>
            </g>
          );
        })()}
    </g>
  );
}

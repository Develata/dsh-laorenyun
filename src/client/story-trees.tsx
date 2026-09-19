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
  const layouts = trees.map((t, i) => {
    const localPath: ArcPath = drifting
      ? {
          getTotalLength: () => 500,
          getPointAtLength: (s) => ({
            x: width < 520 ? 32 : width / 2,
            y: 120 + i * 900 + (s - 250),
          }),
        }
      : path;
    return {
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
  });
  useEffect(() => {
    onExtent?.(
      Math.max(
        0,
        ...layouts.flatMap((l) =>
          (expanded === l.tree.id ? l.points : [l.points[0]!]).map(
            (p) => p.y + 120,
          ),
        ),
      ),
    );
  }, [expanded, width, data, onExtent]);
  const visible = new Map(
    layouts.flatMap((l) =>
      l.points
        .filter((p) => expanded === l.tree.id || p.depth === 0)
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
        return (
          <g key={l.tree.id} data-story-root={l.tree.root}>
            <path d={curve(l.anchor, root)} className="ly-tributary-root" />
            {open && (
              <g className="ly-tree-open">
                {l.points
                  .filter((p) => p.depth > 0)
                  .map((p) => {
                    const parent =
                      l.points.find((x) => x.id === p.parent) ?? root;
                    return (
                      <path
                        key={p.id}
                        d={curve(parent, p)}
                        pathLength={1}
                        className={`ly-tributary ${l.tree.kind === "elaboration" ? "" : "ly-visual-group"}`}
                      />
                    );
                  })}
              </g>
            )}
            {(open ? l.points : [root]).map((p) => {
              const n = nodes.get(p.id)!;
              const toggle = () =>
                p.depth === 0 && branch
                  ? setExpanded(open ? null : l.tree.id)
                  : pick(p.id);
              return (
                <g
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  aria-expanded={p.depth === 0 && branch ? open : undefined}
                  aria-label={`${timeLabel(n)}：${n.keySentence}${p.depth === 0 && branch ? `，${count}个故事，${open ? "收起" : "展开"}` : "，预览故事"}`}
                  onClick={toggle}
                  onKeyDown={key(toggle)}
                  className={p.depth > 0 ? "ly-tree-leaf" : "ly-tree-root"}
                >
                  <rect
                    x={Math.max(0, Math.min(width - 160, p.x - 80))}
                    y={p.y - 25}
                    width={160}
                    height={120}
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
                    {p.depth === 0 && branch
                      ? count
                      : n.hasOpenConflict
                        ? "!"
                        : ""}
                  </text>
                  <title>
                    {timeLabel(n)} · {n.keySentence}
                  </title>
                  {(p.depth === 0 || open) && (
                    <foreignObject
                      x={Math.max(0, Math.min(width - 160, p.x - 80))}
                      y={p.y + 24}
                      width={160}
                      height={70}
                      pointerEvents="auto"
                    >
                      <div className="ly-tree-caption">
                        <small>{timeLabel(n)}</small>
                        <span>
                          {p.depth === 0
                            ? n.keySentence
                            : n.keySentence.slice(0, 24)}
                        </span>
                      </div>
                    </foreignObject>
                  )}
                </g>
              );
            })}
            {open && (
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
          return (
            <g
              role="button"
              tabIndex={0}
              aria-label="查看完整故事"
              onClick={() => onSelect(selected)}
              onKeyDown={key(() => onSelect(selected))}
            >
              <rect
                x={Math.max(4, Math.min(width - 174, p.x - 85))}
                y={p.y - 80}
                width={170}
                height={42}
                rx={3}
                fill="#345b50"
              />
              <text
                x={Math.max(4, Math.min(width - 174, p.x - 85)) + 85}
                y={p.y - 52}
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

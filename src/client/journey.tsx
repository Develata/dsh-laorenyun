import { StoryForest } from "./story-trees.tsx";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RiverSnapshot } from "../river/types.ts";
import { anchors, arcPosition, timeLabel } from "../river/layout.ts";
import { journeyPath, intervalPath } from "../river/journey.ts";
export function Journey({
  data,
  onSelect,
  range,
  onRange,
}: {
  data: RiverSnapshot;
  onSelect: (id: string) => void;
  range: string;
  onRange: (value: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null),
    path = useRef<SVGPathElement>(null);
  const [width, setWidth] = useState(800),
    [projection, setProjection] = useState<{
      input: RiverSnapshot;
      points: Array<{ id: string; x: number; y: number; band: string }>;
    } | null>(null);
  // Never join coordinates from the previous revision/filter to a new node array.
  const layout = projection?.input === data ? projection.points : [];
  const [extent, setExtent] = useState(0);
  const [groveExtent, setGroveExtent] = useState(360);
  const [cluster, setCluster] = useState<string[] | null>(null);
  const [list, setList] = useState(false),
    [decade, setDecade] = useState<number | null>(null);
  const dated = useMemo(() => anchors(data.nodes), [data]);
  const min = dated.length
    ? Math.min(...dated.map((x) => x.node.time.start!))
    : 0;
  const max = dated.length
    ? Math.max(...dated.map((x) => x.node.time.end!))
    : 0;
  const geometry = useMemo(
    () => journeyPath(width, max - min),
    [width, min, max],
  );
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  useEffect(() => {
    const p = path.current;
    if (!p) return;
    const length = p.getTotalLength();
    setProjection({
      input: data,
      points: dated.map((a) => {
        const point = p.getPointAtLength(
          arcPosition(a.month, min, max, length),
        );
        return {
          id: a.node.id,
          x: point.x,
          y: point.y,
          band: a.interval
            ? intervalPath(p, a.node.time.start!, a.node.time.end!, min, max)
            : "",
        };
      }),
    });
  }, [dated, geometry, min, max, list]);
  useEffect(() => {
    const el = box.current,
      curve = path.current;
    const scroller = el?.parentElement;
    if (!el || !curve || !scroller || list) return;
    const length = curve.getTotalLength();
    const stops = data.periods
      .filter((p) => p.start !== null)
      .map((p) => ({
        year: Math.floor(p.start! / 12),
        y: curve.getPointAtLength(arcPosition(p.start!, min, max, length)).y,
      }));
    let frame = 0;
    const update = () => {
      frame = 0;
      const visible =
        scroller.scrollTop - el.offsetTop + scroller.clientHeight / 3;
      let current = stops[0];
      for (const stop of stops) if (stop.y <= visible) current = stop;
      if (current) setDecade(current.year);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      scroller.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [data.periods, geometry, min, max, list]);
  const jump = (year: number) => {
    setDecade(year);
    const p = path.current;
    if (!p) return;
    const point = p.getPointAtLength(
      arcPosition(year * 12, min, max, p.getTotalLength()),
    );
    box.current?.parentElement?.scrollTo({
      top: box.current.offsetTop + point.y - 150,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };
  const labels = new Set<string>();
  const occupied = new Set<number>();
  for (const p of layout) {
    const cell = Math.floor(p.y / 125);
    if (!occupied.has(cell)) {
      occupied.add(cell);
      labels.add(p.id);
    }
  }
  const groups = new Map<number, typeof layout>();
  for (const p of layout) {
    const key = Math.floor(p.y / 45);
    const group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  }
  const clusters = [...groups.values()].filter((g) => g.length > 2);
  const clustered = new Set(clusters.flatMap((g) => g.map((p) => p.id)));
  const drift = data.nodes.filter((n) => n.placement === "drifting");
  return (
    <>
      {cluster && (
        <section className="ly-access-list">
          <button onClick={() => setCluster(null)}>← 返回长河全景</button>
          <h2>这一段岁月</h2>
          {data.nodes
            .filter((n) => cluster.includes(n.id))
            .map((n) => (
              <p key={n.id}>
                <button onClick={() => onSelect(n.id)}>
                  {timeLabel(n)} · {n.keySentence}
                </button>
              </p>
            ))}
        </section>
      )}
      <div hidden={!!cluster} className="ly-journey-toolbar">
        <label>
          浏览
          <select
            aria-label="长河时间范围"
            value={range}
            onChange={(e) => onRange(e.target.value)}
          >
            <option value="all">整段人生</option>
            {data.periods
              .filter((p) => p.start !== null)
              .map((p) => (
                <option key={p.start} value={String(p.start)}>
                  {Math.floor(p.start! / 12)}年代
                </option>
              ))}
            <option value="drifting">漂流湾</option>
          </select>
        </label>
        <button onClick={() => setList(!list)}>
          {list ? "回到长河" : "列表浏览"}
        </button>
      </div>
      <nav className="ly-time-nav" aria-label="年代导航">
        {data.periods
          .filter((p) => p.start !== null)
          .map((p) => (
            <button
              key={p.start}
              aria-current={
                decade === Math.floor(p.start! / 12) ? "date" : undefined
              }
              onClick={() => jump(Math.floor(p.start! / 12))}
            >
              {Math.floor(p.start! / 12)}
              <small> · {p.count}</small>
            </button>
          ))}
        <a href="#ly-drifting-bay">漂流湾</a>
      </nav>
      <div ref={box} className="ly-journey" hidden={!!cluster}>
        {list ? (
          <ol className="ly-access-list">
            {data.nodes.map((n) => (
              <li key={n.id}>
                <button onClick={() => onSelect(n.id)}>
                  {timeLabel(n)} · {n.keySentence}
                  {n.hasOpenConflict ? " · 有不同说法" : ""}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <>
            <svg
              width={geometry.width}
              height={Math.max(geometry.height, extent)}
              viewBox={`0 0 ${geometry.width} ${Math.max(geometry.height, extent)}`}
              aria-label="人生长河，沿河向下时间前进"
              role="group"
            >
              <defs>
                <linearGradient id="ly-water" x1="0" y1="0" x2="1" y2="1">
                  <stop stopColor="#507f79" />
                  <stop offset=".5" stopColor="#89b5a5" />
                  <stop offset="1" stopColor="#3f706c" />
                </linearGradient>
              </defs>
              <path d={geometry.d} className="ly-bank" />
              <path ref={path} d={geometry.d} className="ly-water" />
              <path d={geometry.d} className="ly-current" />
              <path d={geometry.d} className="ly-current ly-current-inner" />
              <path
                d={geometry.d}
                className="ly-current ly-current-bank"
                transform="translate(-14 0)"
              />
              <path
                d={geometry.d}
                className="ly-current ly-current-bank"
                transform="translate(14 0)"
              />
              {layout
                .filter((point) => point.band)
                .map((point) => (
                  <path
                    key={point.id}
                    d={point.band}
                    className="ly-interval"
                    pointerEvents="none"
                  />
                ))}
              {path.current && layout.length > 0 && (
                <StoryForest
                  key={String(data.graphRevision) + range}
                  data={data}
                  path={path.current}
                  min={min}
                  max={max}
                  width={width}
                  onSelect={onSelect}
                  onExtent={setExtent}
                />
              )}
            </svg>
            <p className="ly-river-key">
              沿主河是年月，支流展开故事细节。数字表示可展开的故事；虚线分组只为浏览，不代表事件关系。
            </p>
          </>
        )}
      </div>
      <section id="ly-drifting-bay" className="ly-bay">
        <small>年月未定，故事仍在</small>
        <h2>漂流湾</h2>
        <p>有些往事还没有找到年月，先让它们在这里停一停。</p>
        {drift.length > 0 && (
          <svg
            className="ly-grove"
            width={width}
            height={Math.max(360, groveExtent)}
            role="group"
            aria-label="漂流湾故事群"
          >
            <StoryForest
              data={data}
              path={{
                getTotalLength: () => 500,
                getPointAtLength: (s) => ({ x: width / 2, y: s }),
              }}
              min={0}
              max={0}
              width={width}
              onSelect={onSelect}
              drifting
              onExtent={setGroveExtent}
            />
          </svg>
        )}
        {!drift.length && <p>暂时没有漂流记忆。</p>}
      </section>
    </>
  );
}

import { type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CalendarDay } from '@setryx/shared';

// Hand-drawn SVG charts, one series each, in plate blue. Thin marks, recessive
// hairline grid, a hover/tap tooltip on every mark, and a table view alongside.

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Clean axis ticks from zero (or near the data) to just above the top. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 100) / 100);
  if (out[out.length - 1]! < hi) out.push(Math.round((out[out.length - 1]! + step) * 100) / 100);
  return out;
}

const fmtTick = (v: number) => (v >= 10_000 ? `${Math.round(v / 1000)}K` : v.toLocaleString(undefined, { maximumFractionDigits: 1 }));

type Tip = { x: number; y: number; content: ReactNode } | null;

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const left = Math.max(70, Math.min(width - 70, tip.x));
  return (
    <div className="chart-tip" style={{ left, top: tip.y }} role="status">
      {tip.content}
    </div>
  );
}

// ── Columns ──

export type Column = { key: string; label: string; value: number; tip: ReactNode; current?: boolean };

/** Single-series columns from one baseline, e.g. sessions per week. */
export function ColumnChart({ data, height = 180, unit, title }: { data: Column[]; height?: number; unit?: string; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const pad = { l: 34, r: 6, t: 12, b: 22 };
  const ticks = niceTicks(0, Math.max(1, ...data.map((d) => d.value)), 3);
  const top = ticks[ticks.length - 1]!;
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.min(24, Math.max(4, band - 2));
  const y = (v: number) => pad.t + plotH - (v / top) * plotH;
  const labelEvery = band < 26 ? Math.ceil(26 / Math.max(band, 1)) : 1;

  const show = (i: number) => {
    const d = data[i]!;
    setTip({ x: pad.l + band * i + band / 2, y: y(d.value) - 8, content: d.tip });
  };

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{fmtTick(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + band * i + (band - barW) / 2;
            const h = Math.max(0, plotH - (y(d.value) - pad.t));
            const r = Math.min(4, barW / 2, h);
            return (
              <g key={d.key}>
                {h > 0 && (
                  <path
                    className={`bar${d.current ? ' current' : ''}`}
                    d={`M${x},${pad.t + plotH} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                  />
                )}
                {i % labelEvery === 0 && (
                  <text className="tick" x={pad.l + band * i + band / 2} y={height - 6} textAnchor="middle">{d.label}</text>
                )}
                {/* Hit target: the whole band, taller than the bar */}
                <rect
                  className="hit"
                  x={pad.l + band * i}
                  y={pad.t}
                  width={band}
                  height={plotH}
                  tabIndex={0}
                  aria-label={`${d.label}: ${d.value}${unit ? ` ${unit}` : ''}`}
                  onPointerEnter={() => show(i)}
                  onPointerDown={() => show(i)}
                  onFocus={() => show(i)}
                  onBlur={() => setTip(null)}
                />
              </g>
            );
          })}
          <line className="axis" x1={pad.l} x2={width - pad.r} y1={pad.t + plotH} y2={pad.t + plotH} />
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

// ── Line over time ──

export type LinePoint = { key: string; t: number; value: number; tip: ReactNode; record?: boolean };

/** One measure over time, with a crosshair that snaps to the nearest session. */
export function LineChart({ data, height = 220, title, unit }: { data: LinePoint[]; height?: number; title: string; unit?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const pad = { l: 40, r: 14, t: 14, b: 24 };
  const vals = data.map((d) => d.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.max(1, hi * 0.1);
  const ticks = niceTicks(Math.max(0, lo - span * 0.15), hi + span * 0.1, 4);
  const t0 = data[0]?.t ?? 0;
  const t1 = data[data.length - 1]?.t ?? 1;
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const x = (t: number) => pad.l + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
  const y = (v: number) => pad.t + plotH - ((v - ticks[0]!) / (ticks[ticks.length - 1]! - ticks[0]!)) * plotH;
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const monthFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

  const nearest = (clientX: number, el: SVGSVGElement) => {
    const px = clientX - el.getBoundingClientRect().left;
    let best = 0;
    data.forEach((d, i) => (Math.abs(x(d.t) - px) < Math.abs(x(data[best]!.t) - px) ? (best = i) : null));
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => setActive(nearest(e.clientX, e.currentTarget));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(data.length - 1, (a ?? -1) + 1));
    if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? data.length) - 1));
  };
  const a = active != null ? data[active] : null;
  const xTicks = data.length > 1 ? [data[0]!, data[Math.floor((data.length - 1) / 2)]!, data[data.length - 1]!].filter((d, i, arr) => arr.findIndex((z) => z.key === d.key) === i) : data;

  useEffect(() => setActive(null), [data]);

  return (
    <div className="chart" ref={ref}>
      {width > 0 && data.length > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}. Use the arrow keys to step through sessions.`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          className="line-chart"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{fmtTick(t)}</text>
            </g>
          ))}
          {xTicks.map((d) => (
            <text key={d.key} className="tick" x={x(d.t)} y={height - 6} textAnchor={d === data[0] && data.length > 1 ? 'start' : d === data[data.length - 1] && data.length > 1 ? 'end' : 'middle'}>
              {monthFmt.format(new Date(d.t))}
            </text>
          ))}
          <path className="area" d={`${path} L${x(t1)},${pad.t + plotH} L${x(t0)},${pad.t + plotH} Z`} />
          <path className="line" d={path} />
          {a && <line className="crosshair" x1={x(a.t)} x2={x(a.t)} y1={pad.t} y2={pad.t + plotH} />}
          {data.map((d, i) => (
            <circle key={d.key} className={`dot${d.record ? ' record' : ''}${i === active ? ' on' : ''}`} cx={x(d.t)} cy={y(d.value)} r={d.record || i === active ? 5 : 4} />
          ))}
          {/* End label: the latest value */}
          {data.length > 0 && !a && (
            <text className="end-label" x={x(t1)} y={y(data[data.length - 1]!.value) - 12} textAnchor="end">
              {fmtTick(data[data.length - 1]!.value)}{unit ? ` ${unit}` : ''}
            </text>
          )}
        </svg>
      )}
      <Tooltip tip={a ? { x: x(a.t), y: y(a.value) - 12, content: a.tip } : null} width={width} />
    </div>
  );
}

// ── Calendar heatmap ──

/** Weeks as columns, days as rows; one hue, stronger with more sessions. */
export function Heatmap({ weeks, dayLabels, describe }: { weeks: CalendarDay[][]; dayLabels: string[]; describe: (d: CalendarDay) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const labelW = 18;
  const gap = 3;
  const cell = Math.max(8, Math.min(18, Math.floor((width - labelW - gap * weeks.length) / Math.max(1, weeks.length))));
  const h = 7 * (cell + gap);
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const level = (n: number) => (n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3);
  return (
    <div className="chart heatmap" ref={ref} onPointerLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={labelW + weeks.length * (cell + gap)} height={h + 16} role="img" aria-label="Sessions per day, last six months">
          {weeks.map((col, w) => {
            const first = col[0]!.date;
            const newMonth = w === 0 || first.getMonth() !== weeks[w - 1]![0]!.date.getMonth();
            return (
              <g key={col[0]!.key}>
                {newMonth && w < weeks.length - 2 && (
                  <text className="tick" x={labelW + w * (cell + gap)} y={10}>{monthFmt.format(first)}</text>
                )}
                {col.map((d, i) =>
                  d.future ? null : (
                    <rect
                      key={d.key}
                      className={`cell l${level(d.sessions)}`}
                      x={labelW + w * (cell + gap)}
                      y={16 + i * (cell + gap)}
                      width={cell}
                      height={cell}
                      rx={Math.min(3, cell / 4)}
                      tabIndex={-1}
                      aria-label={describe(d)}
                      onPointerEnter={() => setTip({ x: labelW + w * (cell + gap) + cell / 2, y: 16 + i * (cell + gap) - 4, content: describe(d) })}
                      onPointerDown={() => setTip({ x: labelW + w * (cell + gap) + cell / 2, y: 16 + i * (cell + gap) - 4, content: describe(d) })}
                    />
                  ),
                )}
              </g>
            );
          })}
          {dayLabels.map((l, i) =>
            i % 2 === 0 ? (
              <text key={i} className="tick" x={0} y={16 + i * (cell + gap) + cell / 2} dy="0.32em">{l}</text>
            ) : null,
          )}
        </svg>
      )}
      <div className="heat-key" aria-hidden>
        <span>Less</span>
        {[0, 1, 2, 3].map((l) => <i key={l} className={`l${l}`} />)}
        <span>More</span>
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

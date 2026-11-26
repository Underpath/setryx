import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { type PublicUser, type RecordKind, type SessionMetrics, bestsOf, recordTimeline, sessionMetrics } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';
import { type LinePoint, LineChart } from '../components/charts.tsx';
import { FormError } from '../components/ui.tsx';
import { useExerciseHistory } from '../data.ts';

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export const RECORD_LABEL: Record<RecordKind, string> = {
  weight: 'Heaviest weight',
  e1rm: 'Best estimated 1RM',
  reps: 'Most reps',
  durationS: 'Longest hold',
};
const TILE_LABEL: Record<RecordKind, string> = { weight: 'Heaviest', e1rm: 'Est. 1RM', reps: 'Most reps', durationS: 'Longest hold' };
export const recordValue = (kind: RecordKind, v: number) => (kind === 'reps' ? `${v} reps` : kind === 'durationS' ? `${v} s` : `${v} kg`);

type Metric = { id: string; label: string; unit: string; pick: (m: SessionMetrics) => number | null; record?: RecordKind };
const METRICS: Metric[] = [
  { id: 'e1rm', label: 'Est. 1RM', unit: 'kg', pick: (m) => m.e1rm, record: 'e1rm' },
  { id: 'weight', label: 'Top weight', unit: 'kg', pick: (m) => m.topWeight, record: 'weight' },
  { id: 'reps', label: 'Reps', unit: 'reps', pick: (m) => m.maxReps, record: 'reps' },
  { id: 'hold', label: 'Hold', unit: 's', pick: (m) => m.maxDurationS, record: 'durationS' },
  { id: 'volume', label: 'Volume', unit: 'kg', pick: (m) => (m.volumeKg > 0 ? m.volumeKg : null) },
];

export function ExerciseStatsPage({ user }: { user: PublicUser }) {
  const { id } = useParams();
  const q = useExerciseHistory(id);
  const entries = q.data?.entries ?? [];
  const metrics = useMemo(() => entries.map(sessionMetrics), [entries]);
  const records = useMemo(() => recordTimeline(entries), [entries]);
  const bests = useMemo(() => bestsOf(entries.flatMap((e) => e.sets)), [entries]);
  // Only measures this exercise actually has, with at least one value.
  const available = METRICS.filter((m) => metrics.some((x) => m.pick(x) != null));
  const [chosen, setChosen] = useState<string | null>(null);
  const metric = available.find((m) => m.id === chosen) ?? available[0];
  const [table, setTable] = useState(false);

  const points: LinePoint[] = metric
    ? metrics.flatMap((m, i) => {
        const v = metric.pick(m);
        if (v == null) return [];
        const e = entries[i]!;
        const isRecord = !!metric.record && records.some((r) => r.sessionId === m.sessionId && r.kind === metric.record);
        return [
          {
            key: m.sessionId,
            t: Date.parse(m.startedAt),
            value: v,
            record: isRecord,
            tip: (
              <>
                <b>{dayFmt.format(new Date(m.startedAt))}</b>
                {metric.label}: {v} {metric.unit}
                {isRecord && <em>New record</em>}
                <span className="tip-sets">{e.sets.map(setText).join(', ')}</span>
              </>
            ),
          },
        ];
      })
    : [];

  return (
    <>
      <TopBar title={q.data?.name ?? 'Exercise'} user={user} back="/stats" />
      <FormError error={q.error} />
      {q.isSuccess && (
        <>
          <section className="stat-tiles" aria-label="Bests">
            {(['weight', 'e1rm', 'reps', 'durationS'] as const).map((k) =>
              bests[k] != null ? (
                <div className="stat-tile" key={k}>
                  <span className="label">{TILE_LABEL[k]}</span>
                  <span className="value">{bests[k]}<small>{k === 'reps' ? 'reps' : k === 'durationS' ? 's' : 'kg'}</small></span>
                </div>
              ) : null,
            )}
            <div className="stat-tile">
              <span className="label">Sessions</span>
              <span className="value">{entries.length}</span>
            </div>
          </section>

          {metric && (
            <section className="section">
              <div className="section-head">
                <h2 className="h3">{metric.label} over time</h2>
                {available.length > 1 && (
                  <div className="seg seg-sm" role="radiogroup" aria-label="Measure">
                    {available.map((m) => (
                      <button key={m.id} type="button" role="radio" aria-checked={m === metric} className={m === metric ? 'on' : ''} onClick={() => setChosen(m.id)}>{m.label}</button>
                    ))}
                  </div>
                )}
              </div>
              {points.length < 2 && !table ? (
                <p className="muted small">One session so far. The chart starts with your second.</p>
              ) : table ? null : (
                <LineChart data={points} unit={metric.unit} title={`${metric.label} per session`} />
              )}
              {table && (
                <table className="data-table">
                  <thead><tr><th>Date</th><th>{metric.label}</th><th>Sets</th></tr></thead>
                  <tbody>
                    {[...metrics].reverse().map((m) => {
                      const e = entries.find((x) => x.sessionId === m.sessionId)!;
                      const v = metric.pick(m);
                      return <tr key={m.sessionId}><td>{dayFmt.format(new Date(m.startedAt))}</td><td>{v != null ? `${v} ${metric.unit}` : '–'}</td><td>{e.sets.map(setText).join(', ')}</td></tr>;
                    })}
                  </tbody>
                </table>
              )}
              <button className="link-btn small" type="button" onClick={() => setTable(!table)}>{table ? 'Show as chart' : 'Show as table'}</button>
              {metric.id === 'e1rm' && <p className="small muted" style={{ marginTop: 6 }}>Estimated one-rep max from your best set (Epley: weight × (1 + reps ÷ 30)).</p>}
            </section>
          )}

          <section className="section">
            <h2 className="h3">Records</h2>
            {records.length === 0 ? (
              <p className="muted small">Records show here when you beat your earlier bests. Your first session sets the starting point.</p>
            ) : (
              <ul className="rows">
                {[...records].reverse().map((r, i) => (
                  <li className="row" key={`${r.sessionId}-${r.kind}-${i}`}>
                    <span className="record-mark" aria-hidden />
                    <div className="main">
                      <div className="name">{RECORD_LABEL[r.kind]}: {recordValue(r.kind, r.value)}</div>
                      <div className="meta">Up from {recordValue(r.kind, r.previous)}</div>
                    </div>
                    <span className="meta when">{dayFmt.format(new Date(r.startedAt))}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section">
            <h2 className="h3">History</h2>
            <ul className="rows">
              {[...entries].reverse().map((e) => (
                <li className="row" key={e.sessionId}>
                  <div className="main">
                    <div className="name">{e.workoutName}</div>
                    <div className="meta">{e.sets.map(setText).join(', ')}</div>
                  </div>
                  <span className="meta when">{dayFmt.format(new Date(e.startedAt))}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

const setText = (s: { reps: number | null; weight: number | null; durationS: number | null }) =>
  `${s.reps ?? `${s.durationS ?? 0} s`}${s.weight != null && s.weight > 0 ? ` × ${s.weight} kg` : ''}`;

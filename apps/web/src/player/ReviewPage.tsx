import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { type NewRecord, type PlayerState, type SetLog, type TargetSuggestion, adjustLog, elapsedMs, emptyBests, loggedSets, newRecords, stepsOf, targetSuggestions } from '@setryx/shared';
import { useBests } from '../data.ts';
import { RECORD_LABEL, recordValue } from '../pages/ExerciseStatsPage.tsx';
import { useMe } from '../session.ts';
import { Sheet, useToast } from '../components/ui.tsx';
import { useAllowNextNavigation } from '../components/backGuard.tsx';
import { duration } from '../util.ts';
import { flushOutbox, saveFinished } from '../sync/outbox.ts';
import { getFinished, loadTicks, removeFinished, saveTicks, updateFinished } from './storage.ts';

/** /review/:sessionId — check the sets, pick target updates, save. */
export function ReviewRoute() {
  const { sessionId } = useParams();
  const me = useMe();
  const user = me.data!;
  const [initial] = useState(() => (sessionId ? getFinished(user.id, sessionId) : null));
  if (!initial) return <Navigate to="/" replace />;
  return <Review initial={initial} />;
}

const fmtTarget = (t: { reps: number | null; weight: number | null; durationS: number | null }) =>
  [t.reps != null ? `${t.reps} reps` : t.durationS != null ? `${t.durationS} s` : null, t.weight != null ? `${t.weight} kg` : 'bodyweight'].filter(Boolean).join(' at ');

function Review({ initial }: { initial: PlayerState }) {
  const [state, setState] = useState(initial);
  const navigate = useNavigate();
  const allowNext = useAllowNextNavigation();
  const toast = useToast();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const steps = stepsOf(state);
  const sets = loggedSets(state);
  const suggestions = useMemo(() => targetSuggestions(state), [state]);
  const [chosen, setChosenState] = useState<Record<string, boolean>>(
    () => loadTicks(initial.id) ?? Object.fromEntries(targetSuggestions(initial).map((s) => [s.itemId, s.consistent])),
  );
  const setChosen = (update: Record<string, boolean> | ((c: Record<string, boolean>) => Record<string, boolean>)) =>
    setChosenState((c) => {
      const next = typeof update === 'function' ? update(c) : update;
      saveTicks(initial.id, next);
      return next;
    });
  const volume = sets.reduce((t, l) => t + (l.actualReps ?? 0) * (l.actualWeight ?? 0), 0);
  const name = (exerciseId: string) => state.exercises[exerciseId]?.name ?? 'Exercise';

  const edit = (stepIndex: number, patch: Partial<Pick<SetLog, 'actualReps' | 'actualWeight' | 'actualDurationS'>>) => {
    const next = adjustLog(state, stepIndex, patch);
    setState(next);
    updateFinished(next); // keep edits if the app closes before saving
    // Changing a set here is a strong hint the plan should change too: tick it.
    const itemId = next.logs[stepIndex]?.itemId;
    if (itemId) setChosen((c) => ({ ...c, [itemId]: targetSuggestions(next).some((x) => x.itemId === itemId) }));
  };

  // Group the sets by workout step, in the order they appear.
  const groups = useMemo(() => {
    const map = new Map<string, SetLog[]>();
    for (const l of sets) map.set(l.itemId, [...(map.get(l.itemId) ?? []), l]);
    return [...map.entries()];
  }, [sets]);

  const picked = suggestions.filter((s) => chosen[s.itemId]);

  // Records: this session's sets against your bests from every other session.
  const exerciseIds = useMemo(() => [...new Set(sets.map((l) => l.exerciseId))], [sets]);
  const priorBests = useBests(exerciseIds, state.id);
  const records = useMemo(() => {
    if (!priorBests.data) return [] as (NewRecord & { exerciseId: string })[];
    return exerciseIds.flatMap((id) =>
      newRecords(
        sets.filter((l) => l.exerciseId === id).map((l) => ({ reps: l.actualReps, weight: l.actualWeight, durationS: l.actualDurationS })),
        priorBests.data[id] ?? emptyBests(),
      ).map((r) => ({ ...r, exerciseId: id })),
    );
  }, [priorBests.data, exerciseIds, sets]);
  const suggestionFor = (itemId: string) => suggestions.find((s) => s.itemId === itemId);

  const save = async () => {
    saveFinished(state, {
      updates: picked.map((s) => ({
        itemId: s.itemId,
        ...(s.kind === 'reps' ? { targetReps: s.suggested.reps } : { targetDurationS: s.suggested.durationS }),
        targetWeight: s.suggested.weight,
      })),
    });
    const r = await flushOutbox(state.userId);
    toast(r.offline ? 'Saved on this device. It uploads when the server is reachable.' : 'Session saved');
    allowNext();
    navigate('/', { replace: true });
  };

  const discard = () => {
    removeFinished(state.userId, state.id);
    toast('Session discarded');
    allowNext();
    navigate('/', { replace: true });
  };

  return (
    <main className="editor review">
      <header className="topbar editor-bar">
        <h1 className="h2">{state.workoutName} done</h1>
      </header>
      <div className="summary">
        <div><b>{duration(elapsedMs(state, state.finishedAt ?? Date.now()))}</b>duration</div>
        <div><b>{sets.length}</b>sets</div>
        <div><b>{Math.round(volume).toLocaleString()}</b>kg moved</div>
        {records.length > 0 && <div className="records-tile"><b>{records.length}</b>record{records.length === 1 ? '' : 's'}</div>}
      </div>
      {records.length > 0 && (
        <section className="section review-records" aria-label="New records">
          <h2 className="h3">New records</h2>
          <ul className="rows">
            {records.map((r) => (
              <li className="row" key={`${r.exerciseId}-${r.kind}`}>
                <span className="record-mark" aria-hidden />
                <div className="main">
                  <div className="name">{name(r.exerciseId)}</div>
                  <div className="meta">{RECORD_LABEL[r.kind]}: <b>{recordValue(r.kind, r.value)}</b>, up from {recordValue(r.kind, r.previous)}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {sets.length < steps.filter((s) => s.kind === 'exercise').length && (
        <p className="small muted" style={{ marginTop: 10 }}>Ended early: {sets.length} of {steps.filter((s) => s.kind === 'exercise').length} sets done.</p>
      )}

      {suggestions.length > 0 && state.workoutId && (
        <section className="section">
          <h2 className="h3">Update the workout?</h2>
          <p className="small muted" style={{ marginBottom: 6 }}>Some sets differed from the plan. Tick the ones to use as new targets next time.</p>
          <ul className="rows">
            {suggestions.map((s) => (
              <Suggestion key={s.itemId} s={s} name={name(s.exerciseId)} checked={!!chosen[s.itemId]} onChange={(v) => setChosen({ ...chosen, [s.itemId]: v })} />
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <h2 className="h3">All sets</h2>
        {groups.length === 0 && <p className="muted">No sets were logged.</p>}
        {groups.map(([itemId, logs]) => {
          const timed = logs[0]!.plannedDurationS != null;
          return (
            <div className="review-group" key={itemId}>
              <div className="name">{name(logs[0]!.exerciseId)}</div>
              {logs.map((l) => (
                <div className="review-set" key={l.stepIndex}>
                  <span className="muted small">{l.round ? `Round ${l.round}` : 'Set'}</span>
                  {timed ? (
                    <MiniStepper value={l.actualDurationS ?? 0} unit="s" step={5} label="seconds" planned={l.plannedDurationS} onChange={(v) => edit(l.stepIndex, { actualDurationS: v })} />
                  ) : (
                    <MiniStepper value={l.actualReps ?? 0} unit="reps" step={1} label="reps" planned={l.plannedReps} onChange={(v) => edit(l.stepIndex, { actualReps: v })} />
                  )}
                  {(l.plannedWeight != null || l.actualWeight != null) && (
                    <MiniStepper value={l.actualWeight ?? 0} unit="kg" step={1} label="weight" planned={l.plannedWeight} decimals onChange={(v) => edit(l.stepIndex, { actualWeight: v })} />
                  )}
                </div>
              ))}
              {suggestionFor(itemId) && state.workoutId && (
                <label className="inline-update">
                  <input type="checkbox" checked={!!chosen[itemId]} onChange={(e) => setChosen({ ...chosen, [itemId]: e.target.checked })} />
                  <span>Update the workout to <strong>{fmtTarget(suggestionFor(itemId)!.suggested)}</strong> next time</span>
                </label>
              )}
            </div>
          );
        })}
      </section>

      <div className="start-footer review-footer">
        <button className="btn btn-primary btn-block" type="button" onClick={save}>
          {picked.length ? `Save session and update ${picked.length} target${picked.length === 1 ? '' : 's'}` : 'Save session'}
        </button>
        <button className="btn btn-block" type="button" onClick={() => setConfirmDiscard(true)}>Discard session</button>
      </div>

      {confirmDiscard && (
        <Sheet title="Discard this session?" onClose={() => setConfirmDiscard(false)}>
          <p className="muted">The {sets.length} logged set{sets.length === 1 ? '' : 's'} won’t be saved. This can’t be undone.</p>
          <button className="btn btn-primary btn-block" type="button" onClick={discard}>Discard session</button>
          <button className="btn btn-block" type="button" onClick={() => setConfirmDiscard(false)}>Keep it</button>
        </Sheet>
      )}
    </main>
  );
}

function Suggestion({ s, name, checked, onChange }: { s: TargetSuggestion; name: string; checked: boolean; onChange: (v: boolean) => void }) {
  const perRound = s.rounds.map((r) => (s.kind === 'reps' ? r.reps : r.durationS)).join(', ');
  const weights = [...new Set(s.rounds.map((r) => r.weight))];
  return (
    <li>
      <label className="change">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="name">{name}</span>
        <span />
        <span className="delta">
          <s>{fmtTarget(s.planned)}</s> → <strong>{fmtTarget(s.suggested)}</strong>
          <br />
          You did {perRound} {s.kind === 'reps' ? 'reps' : 's'}
          {weights.length > 1 ? ` at ${weights.join(', ')} kg` : ''}
          {!s.consistent ? '. Not every round matched.' : '.'}
        </span>
      </label>
    </li>
  );
}

function MiniStepper({ value, unit, step, label, planned, decimals, onChange }: { value: number; unit: string; step: number; label: string; planned: number | null; decimals?: boolean; onChange: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const changed = planned != null && value !== planned;
  return (
    <div className={`mini-stepper${changed ? ' changed' : ''}`} title={planned != null ? `Planned: ${planned} ${unit}` : undefined}>
      <button type="button" aria-label={`Less ${label}`} onClick={() => onChange(Math.max(0, Math.round((value - step) * 100) / 100))}>−</button>
      <input
        inputMode={decimals ? 'decimal' : 'numeric'}
        aria-label={label}
        value={text ?? String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null) {
            const n = Number(text.replace(',', '.'));
            if (Number.isFinite(n) && n >= 0) onChange(decimals ? Math.round(n * 100) / 100 : Math.round(n));
          }
          setText(null);
        }}
      />
      <span className="unit">{unit}</span>
      <button type="button" aria-label={`More ${label}`} onClick={() => onChange(Math.round((value + step) * 100) / 100)}>+</button>
    </div>
  );
}

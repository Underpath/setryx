import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { type PlayerState, type SetLog, type TargetSuggestion, adjustLog, elapsedMs, loggedSets, sessionUploadOf, stepsOf, targetSuggestions } from '@setryx/shared';
import { useMe } from '../session.ts';
import { Sheet, useToast } from '../components/ui.tsx';
import { useAllowNextNavigation } from '../components/backGuard.tsx';
import { duration } from '../util.ts';
import { enqueue, flushOutbox } from '../sync/outbox.ts';
import { getFinished, removeFinished, updateFinished } from './storage.ts';

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
  const [chosen, setChosen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(targetSuggestions(initial).map((s) => [s.itemId, s.consistent])),
  );
  const volume = sets.reduce((t, l) => t + (l.actualReps ?? 0) * (l.actualWeight ?? 0), 0);
  const name = (exerciseId: string) => state.exercises[exerciseId]?.name ?? 'Exercise';

  const edit = (stepIndex: number, patch: Partial<Pick<SetLog, 'actualReps' | 'actualWeight' | 'actualDurationS'>>) => {
    const next = adjustLog(state, stepIndex, patch);
    setState(next);
    updateFinished(next); // keep edits if the app closes before saving
  };

  // Group the sets by workout step, in the order they appear.
  const groups = useMemo(() => {
    const map = new Map<string, SetLog[]>();
    for (const l of sets) map.set(l.itemId, [...(map.get(l.itemId) ?? []), l]);
    return [...map.entries()];
  }, [sets]);

  const picked = suggestions.filter((s) => chosen[s.itemId]);

  const save = async () => {
    const upload = sessionUploadOf(state);
    enqueue(state.userId, { id: `session:${state.id}`, kind: 'session', sessionId: state.id, label: state.workoutName, body: upload });
    if (picked.length && state.workoutId) {
      enqueue(state.userId, {
        id: `targets:${state.id}`,
        kind: 'targets',
        workoutId: state.workoutId,
        label: state.workoutName,
        body: {
          updates: picked.map((s) => ({
            itemId: s.itemId,
            ...(s.kind === 'reps' ? { targetReps: s.suggested.reps } : { targetDurationS: s.suggested.durationS }),
            targetWeight: s.suggested.weight,
          })),
        },
      });
    }
    removeFinished(state.userId, state.id);
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
      </div>
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
          {!s.consistent ? '. Not every round matched, so this isn’t ticked by default.' : '.'}
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

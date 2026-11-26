import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  type FlatStep,
  type PlayerState,
  type PublicUser,
  type SnapshotExercise,
  correctableLog,
  createPlayer,
  currentStep,
  elapsedMs,
  equipmentChecklist,
  estimateWorkoutSeconds,
  isTimed,
  loggedSets,
  nextBlockPreview,
  routineContextFor,
  remainingMs,
  stepDurationMs,
  stepsOf,
} from '@setryx/shared';
import { useMe } from '../session.ts';
import { ExercisePhotos } from '../components/exercises.tsx';
import { formatMinutes, useRoutines, useWorkout } from '../data.ts';
import { pendingRuns, useOutbox } from '../sync/outbox.ts';
import { FormError, Icon, Sheet, useToast } from '../components/ui.tsx';
import { useAllowNextNavigation } from '../components/backGuard.tsx';
import { clock, duration, uid, useMediaQuery } from '../util.ts';
import { addFinished, announce, clearActive, discardActive, loadActive } from './storage.ts';
import { usePlayer } from './usePlayer.ts';
import { useWakeLock } from './wakeLock.ts';

// ── Routes ──
// /play resumes the session saved on this device. It's a separate component
// from /play/:workoutId on purpose: when a started workout moves to /play,
// React must mount fresh and read the saved session, not reuse stale state.

export function ResumeRoute() {
  const me = useMe();
  const user = me.data!;
  const [active] = useState<PlayerState | null>(() => loadActive(user.id));
  return active ? <Player key={active.id} user={user} initial={active} /> : <Navigate to="/" replace />;
}

/** /play/:workoutId starts a workout, or offers to resume the one in progress. */
export function PlayerRoute() {
  const { workoutId } = useParams();
  const me = useMe();
  const user = me.data!;
  const [active, setActive] = useState<PlayerState | null>(() => loadActive(user.id));
  const [choice, setChoice] = useState<'resume' | 'new' | null>(null);

  if (!workoutId) return <Navigate to="/play" replace />;
  if (active && choice === null) {
    return (
      <div className="player-gate">
        <Sheet title="You have a workout in progress" onClose={() => setChoice('resume')}>
          <p className="muted">
            {active.workoutName} is still open. Resume it, or discard it and start {active.workoutId === workoutId ? 'it again from the beginning' : 'this one'}.
          </p>
          <button className="btn btn-primary btn-block" type="button" onClick={() => setChoice('resume')}>Resume {active.workoutName}</button>
          <button
            className="btn btn-quiet btn-block"
            type="button"
            onClick={() => {
              discardActive(user.id);
              setActive(null);
              setChoice('new');
            }}
          >
            Discard it and start over
          </button>
        </Sheet>
      </div>
    );
  }
  if (active && choice === 'resume') return <Player key={active.id} user={user} initial={active} />;
  return <NewSession user={user} workoutId={workoutId} />;
}

function NewSession({ user, workoutId }: { user: PublicUser; workoutId: string }) {
  const w = useWorkout(workoutId);
  const [params] = useSearchParams();
  const routines = useRoutines();
  const outbox = useOutbox(user.id);
  // Started from a routine's Up next, or else counted for a routine waiting on this workout.
  const picked = params.get('routine') && params.get('entry') ? { routineId: params.get('routine')!, entryId: params.get('entry')! } : null;
  const routinesSettled = !!picked || !routines.isPending;
  const initial = useMemo(() => {
    if (!w.data || !routinesSettled) return null;
    const ctx = picked ?? routineContextFor(workoutId, routines.data ?? [], new Date(), pendingRuns(outbox), user.settings.weekStart);
    const exercises: Record<string, SnapshotExercise> = {};
    for (const [id, e] of Object.entries(w.data.exercises)) exercises[id] = {
      name: e.name, equipment: e.equipment, instructions: e.instructions,
      images: e.images, primaryMuscles: e.primaryMuscles, secondaryMuscles: e.secondaryMuscles,
    };
    const { workout } = w.data;
    return createPlayer({
      id: uid(), userId: user.id, workoutId: workout.id, workoutName: workout.name, icon: workout.icon,
      routineId: ctx?.routineId ?? null, routineEntryId: ctx?.entryId ?? null,
      items: workout.items, exercises, now: Date.now(),
    });
    // Built once: later refetches mustn't restart the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!w.data, routinesSettled, user.id]);
  if (w.isError) {
    return (
      <main className="editor">
        <FormError error={w.error} />
        <Link className="btn btn-quiet" to="/workouts">Back to workouts</Link>
      </main>
    );
  }
  if (!initial) return <div className="center-load">Loading workout…</div>;
  return <Player key={initial.id} user={user} initial={initial} />;
}

// ── The player ──

function Player({ user, initial }: { user: PublicUser; initial: PlayerState }) {
  const settings = user.settings;
  const p = usePlayer(initial, settings);
  const { state, now } = p;
  const running = state.phase === 'running';
  // Keep-screen-on starts from the setting and can be switched for this workout with the chip.
  const [awake, setAwake] = useState(settings.keepAwake);
  const wake = useWakeLock(running && awake);
  const toast = useToast();
  const wide = useMediaQuery('(min-width: 1000px) and (orientation: landscape)');
  const [sheet, setSheet] = useState<'cues' | 'end' | null>(null);
  const navigate = useNavigate();
  const { workoutId } = useParams();

  // Once running, live at /play so a reload resumes straight into the session.
  useEffect(() => {
    if (running && workoutId) navigate('/play', { replace: true });
  }, [running, workoutId, navigate]);

  // Ask before closing the tab mid-workout (progress is saved either way).
  useEffect(() => {
    if (!running) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [running]);

  if (state.phase === 'ready') {
    return (
      <StartScreen
        state={state}
        onStart={() => {
          if (awake) wake.kick();
          p.start();
        }}
      />
    );
  }
  if (state.phase === 'finished') return <FinishedRedirect state={state} />;

  const steps = stepsOf(state);
  const step = currentStep(state)!;
  const timed = isTimed(step);
  const left = remainingMs(state, now) ?? 0;
  const total = timed ? stepDurationMs(step) : 0;
  const warnMs = settings.warnSeconds * 1000;
  const final = timed && left <= warnMs && total > warnMs;
  const nextUp = steps[state.index + 1] ?? null;
  const ex = (s: FlatStep | null) => (s && s.kind === 'exercise' ? state.exercises[s.exerciseId] : undefined);
  const log = correctableLog(state);
  const preview = nextBlockPreview(state);

  // A rest that leads into a new superset: time to set up different equipment.
  const changeover = step.kind === 'rest' && preview ? preview : null;
  const phaseClass = (step.kind === 'rest' ? (final ? 'final' : 'rest') : timed ? (final ? 'final timed' : 'timed') : 'work') + (changeover ? ' changeover' : '');
  const fillPct = timed && total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  const nextLabel = step.kind === 'rest' ? 'Skip rest' : 'Log set';
  const tapToLog = settings.tapToLog;

  const numeral =
    p.countdown !== null ? String(p.countdown) : step.kind === 'exercise' && step.targetType === 'reps' ? String(step.targetReps) : clock(left / 1000);
  const unit = p.countdown !== null ? '' : step.kind === 'exercise' && step.targetType === 'reps' ? 'reps' : left >= 60_000 ? '' : 's';

  const title =
    step.kind === 'rest'
      ? final
        ? 'Get ready'
        : changeover
          ? `Set up ${changeover.label}`
          : (step.label ?? 'Rest')
      : (ex(step)?.name ?? 'Exercise');

  const mainContent = (
    <>
      <span className="ex-name">{title}</span>
      <span
        className={`big${state.paused && p.countdown === null ? ' paused' : ''}`}
        style={{ '--fit': numeral.length <= 2 ? 1 : numeral.length === 3 ? 0.78 : 0.6 } as CSSProperties}
        aria-live="off"
      >
        {numeral}
        {unit && <small>{unit}</small>}
      </span>
      {step.kind === 'exercise' ? (
        <>
          <span className="load">{step.targetWeight != null ? `${step.targetWeight} kg` : 'Bodyweight'}</span>
          {(step.tempo || step.rir) && (
            <span className="cues">
              {step.tempo && <Cue label="Tempo" value={step.tempo} />}
              {step.rir && <Cue label="Reps in reserve" value={step.rir} />}
            </span>
          )}
          {tapToLog && settings.showTapHint && !state.paused && <span className="tap-hint">Tap anywhere to {step.targetType === 'timed' ? 'finish early' : 'log the set'}</span>}
        </>
      ) : changeover ? (
        <>
          <Changeover preview={changeover} />
          <NextLine step={nextUp} name={ex(nextUp)?.name} />
        </>
      ) : (
        <NextLine step={nextUp} name={ex(nextUp)?.name} />
      )}
      {state.paused && p.countdown === null && <span className="paused-label">Paused</span>}
    </>
  );

  const controls = (
    <div className="controls">
      <div className="ctrl-wrap">
        <button className="ctrl" type="button" onClick={p.back} disabled={state.index === 0} aria-label="Previous step">
          <svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
        </button>
        <span>Back</span>
      </div>
      <div className="ctrl-wrap">
        <button className="ctrl" type="button" onClick={p.togglePause} aria-label={state.paused ? 'Resume' : 'Pause'}>
          {state.paused ? <svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" /></svg> : <svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>}
        </button>
        <span>{p.countdown !== null ? 'Cancel' : state.paused ? 'Resume' : 'Pause'}</span>
      </div>
      <div className="ctrl-wrap">
        <button className="ctrl ctrl-next" type="button" onClick={p.next} aria-label={nextLabel}>
          <svg viewBox="0 0 24 24"><path d="M4 5l11 7-11 7zM16 5h2v14h-2z" /></svg>
        </button>
        <span>{nextLabel}</span>
      </div>
    </div>
  );

  const logged = log && (
    <div className="logged">
      <div className="lbl"><b>Logged: {state.exercises[log.exerciseId]?.name ?? 'last set'}</b><span>Change it if you did something different</span></div>
      <div className="steppers">
        {log.plannedDurationS != null ? (
          <Stepper value={log.actualDurationS ?? 0} unit="s" step={5} label="seconds" onChange={(v) => p.adjust(log.stepIndex, { actualDurationS: v })} />
        ) : (
          <Stepper value={log.actualReps ?? 0} unit="reps" step={1} label="reps" onChange={(v) => p.adjust(log.stepIndex, { actualReps: v })} />
        )}
        {log.plannedWeight != null && <Stepper value={log.actualWeight ?? 0} unit="kg" step={1} label="weight" onChange={(v) => p.adjust(log.stepIndex, { actualWeight: v })} />}
      </div>
    </div>
  );

  const topBar = (
    <div className="p-top">
      <button className="icon-btn" type="button" aria-label="End workout" onClick={() => setSheet('end')}><Icon name="close" /></button>
      <div className="where">
        {step.superset ? (
          <>
            <b>{step.superset.label}</b>Round {step.superset.round} of {step.superset.rounds}
          </>
        ) : (
          <>
            <b>{state.workoutName}</b>
            {!wide && <>Step {state.index + 1} of {steps.length}</>}
          </>
        )}
      </div>
      {step.kind === 'exercise' && (
        <button className="icon-btn" type="button" aria-label="Exercise details" onClick={() => setSheet('cues')}>
          <svg className="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
        </button>
      )}
      {wide && (
        <div className="p-mid" aria-live="off">
          <b>{duration(elapsedMs(state, now))}</b>
          <span>Step {state.index + 1} of {steps.length}</span>
        </div>
      )}
      <WakeChip
        wanted={awake}
        status={wake.status}
        onToggle={() => {
          if (awake && wake.status !== 'on') return wake.kick(); // wanted but not working yet: try again
          setAwake(!awake);
          if (!awake) wake.kick();
          toast(awake ? 'The screen can turn off now' : 'The screen stays on during this workout');
        }}
      />
    </div>
  );

  const progress = (
    <div className="progress" role="progressbar" aria-label="Workout progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={state.index}>
      {progressSegments(steps).map((seg) => (
        <span key={seg.start} className={seg.rounds ? 'seg seg-superset' : 'seg'} style={{ flexGrow: seg.count }}>
          <i style={{ width: `${Math.max(0, Math.min(1, (state.index - seg.start) / seg.count)) * 100}%` }} />
          {seg.rounds > 1 &&
            Array.from({ length: seg.rounds - 1 }, (_, k) => <b key={k} style={{ left: `${((k + 1) / seg.rounds) * 100}%` }} />)}
        </span>
      ))}
    </div>
  );

  const tapArea = tapToLog ? (
    <button className="tap-area" type="button" onClick={p.next} aria-label={nextLabel}>{mainContent}</button>
  ) : (
    <div className="tap-area">{mainContent}</div>
  );

  return (
    <div
      className={`player ${phaseClass}${wide ? ' t-player' : ''}`}
      // After a reload the keep-awake video can't start until the next tap; any tap retries it.
      onPointerDown={() => awake && wake.status !== 'on' && wake.kick()}
    >
      {timed && <div className="field-fill" style={{ height: `${fillPct}%`, right: wide ? 360 : 0 }} />}
      {wide ? (
        <>
          <div className="t-main">
            {topBar}
            {progress}
            {tapArea}
          </div>
          <aside className="t-panel">
            <RoundPanel state={state} />
            {logged}
            {step.kind === 'exercise' && <CuesBlock step={step} exercise={ex(step)} compact />}
            {preview && !changeover && <Preview preview={preview} />}
            {controls}
          </aside>
        </>
      ) : (
        <>
          {topBar}
          {progress}
          {tapArea}
          <div className="p-bottom">
            {preview && !changeover && <Preview preview={preview} />}
            {logged}
            {!logged && step.kind === 'exercise' && (
              <div className="next">
                <span>Next</span>
                <span>{nextUp ? <NextSummary step={nextUp} name={ex(nextUp)?.name} /> : 'That’s the last one'}</span>
              </div>
            )}
            {controls}
          </div>
        </>
      )}

      {sheet === 'cues' && step.kind === 'exercise' && (
        <Sheet title={ex(step)?.name ?? 'Exercise'} onClose={() => setSheet(null)}>
          <CuesBlock step={step} exercise={ex(step)} />
        </Sheet>
      )}
      {sheet === 'end' && (
        <Sheet title="End this workout?" onClose={() => setSheet(null)}>
          <p className="muted">
            {loggedSets(state).length
              ? `You’ve logged ${loggedSets(state).length} set${loggedSets(state).length === 1 ? '' : 's'}. Keep them as a shorter session, or throw this session away.`
              : 'Nothing has been logged yet.'}
          </p>
          {loggedSets(state).length > 0 && (
            <button className="btn btn-primary btn-block" type="button" onClick={() => (setSheet(null), p.finishNow())}>End and keep my sets</button>
          )}
          <DiscardButton state={state} />
          <button className="btn btn-block" type="button" onClick={() => setSheet(null)}>Keep going</button>
        </Sheet>
      )}
    </div>
  );
}

function DiscardButton({ state }: { state: PlayerState }) {
  const navigate = useNavigate();
  const allowNext = useAllowNextNavigation();
  return (
    <button
      className="btn btn-quiet btn-block"
      type="button"
      onClick={() => {
        discardActive(state.userId, state.id);
        announce();
        allowNext();
        navigate('/', { replace: true });
      }}
    >
      Discard this session
    </button>
  );
}

function Stepper({ value, unit, step, label, onChange }: { value: number; unit: string; step: number; label: string; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <button type="button" aria-label={`Less ${label}`} onClick={() => onChange(Math.max(0, value - step))}>−</button>
      <span aria-live="polite">{value}<small>{unit}</small></span>
      <button type="button" aria-label={`More ${label}`} onClick={() => onChange(value + step)}>+</button>
    </div>
  );
}

function WakeChip({ wanted, status, onToggle }: { wanted: boolean; status: 'on' | 'off' | 'failed'; onToggle: () => void }) {
  const on = wanted && status === 'on';
  const label = !wanted ? 'Screen off' : on ? 'Screen on' : 'Screen may sleep';
  return (
    <button
      className={`wake${on ? '' : ' wake-off'}`}
      type="button"
      role="switch"
      aria-checked={wanted}
      onClick={onToggle}
      aria-label={`Keep the screen on: ${label}`}
      title={!wanted ? 'Tap to keep the screen on' : on ? 'Tap to let the screen turn off' : 'Tap to try keeping the screen on again'}
    >
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" /></svg>
      <span className="wake-text">{label}</span>
    </button>
  );
}

function NextSummary({ step, name }: { step: FlatStep; name?: string }) {
  if (step.kind === 'rest') return <><b>{step.label ?? 'Rest'} {step.durationS} s</b></>;
  const target = step.targetType === 'reps' ? `${step.targetReps} reps` : `${step.targetDurationS} s`;
  return (
    <>
      <b>{name ?? 'Exercise'}</b>, {target}
      {step.targetWeight != null ? ` at ${step.targetWeight} kg` : ''}
    </>
  );
}

/** On a rest: the next exercise, big enough to read from the bench. */
function NextLine({ step, name }: { step: FlatStep | null; name?: string }) {
  if (!step) return <span className="next-line">That’s the last one.</span>;
  if (step.kind === 'exercise') {
    return (
      <>
        <span className="load">{name}</span>
        <span className="cues">
          <Cue label={step.targetType === 'reps' ? 'Reps' : 'Hold'} value={step.targetType === 'reps' ? String(step.targetReps) : `${step.targetDurationS} s`} />
          {step.targetWeight != null && <Cue label="Weight" value={`${step.targetWeight} kg`} />}
          {step.tempo && <Cue label="Tempo" value={step.tempo} />}
        </span>
      </>
    );
  }
  return (
    <span className="next-line">
      Next: <NextSummary step={step} name={name} />
    </span>
  );
}

function CuesBlock({ step, exercise, compact }: { step: Extract<FlatStep, { kind: 'exercise' }>; exercise?: SnapshotExercise; compact?: boolean }) {
  const equipment = step.equipmentNote ?? exercise?.equipment.map((e) => e[0]!.toUpperCase() + e.slice(1)).join(', ');
  return (
    <div className={`cues-block${compact ? ' compact' : ''}`}>
      {!compact && exercise?.images && exercise.images.length > 0 && <ExercisePhotos images={exercise.images} name={exercise.name} />}
      {!compact && exercise?.primaryMuscles && exercise.primaryMuscles.length > 0 && (
        <p className="small">
          <b>Works:</b> {[...exercise.primaryMuscles, ...(exercise.secondaryMuscles ?? [])].map((m) => m[0]!.toUpperCase() + m.slice(1)).join(', ')}
        </p>
      )}
      {step.notes && <p>{step.notes}</p>}
      {!compact && equipment && <p className="small"><b>Equipment:</b> {equipment}</p>}
      {!compact && exercise && exercise.instructions.length > 0 && (
        <ol className="instructions">{exercise.instructions.map((s, i) => <li key={i}>{s}</li>)}</ol>
      )}
      {!compact && !step.notes && !equipment && !exercise?.instructions.length && !exercise?.images?.length && <p className="muted">No details for this exercise.</p>}
    </div>
  );
}

/** A labelled number: label on top, value below, with a divider before the next one. */
function Cue({ label, value }: { label: string; value: string }) {
  return (
    <span className="cue">
      <small>{label}</small>
      <b>{value}</b>
    </span>
  );
}

/**
 * The progress bar in pieces: each superset is its own piece with a tick per
 * round, and runs of plain steps between them share one.
 */
function progressSegments(steps: FlatStep[]): { start: number; count: number; rounds: number }[] {
  const out: { start: number; count: number; rounds: number; key: string }[] = [];
  steps.forEach((st, i) => {
    const key = st.superset ? `s${st.blockIndex}` : 'plain';
    const last = out[out.length - 1];
    if (last && last.key === key) last.count++;
    else out.push({ start: i, count: 1, rounds: st.superset?.rounds ?? 0, key });
  });
  return out;
}

/** The changeover rest: the next superset's equipment, big enough to read from across the room. */
function Changeover({ preview }: { preview: { label: string; items: string[] } }) {
  return (
    <div className="changeover-card">
      {preview.items.length ? (
        <ul className="gear">
          {preview.items.map((it) => <li key={it}>{it}</li>)}
        </ul>
      ) : (
        <p className="gear-none">No equipment needed</p>
      )}
    </div>
  );
}

function Preview({ preview }: { preview: { label: string; items: string[] } }) {
  return (
    <div className="preview">
      <span>Coming up: <b>{preview.label}</b></span>
      <span>{preview.items.length ? preview.items.join(', ') : 'No equipment'}</span>
    </div>
  );
}

/** Tablet side panel: the current round as a checklist. */
function RoundPanel({ state }: { state: PlayerState }) {
  const steps = stepsOf(state);
  const step = currentStep(state)!;
  const block = state.items[step.blockIndex];
  const list = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.blockIndex === step.blockIndex && (s.superset ? s.superset.round === step.superset?.round : true));
  return (
    <>
      <h2 className="t-h">{block?.kind === 'superset' ? block.label || 'Superset' : state.workoutName}</h2>
      {step.superset && <div className="sub">Round {step.superset.round} of {step.superset.rounds}</div>}
      <ul className="t-steps">
        {list.map(({ s, i }) => {
          const log = state.logs[i];
          const cls = i < state.index ? 'done' : i === state.index ? 'now' : '';
          const name = s.kind === 'rest' ? (s.label ?? 'Rest') : (state.exercises[s.exerciseId]?.name ?? 'Exercise');
          const v =
            s.kind === 'rest'
              ? `${s.durationS} s`
              : log
                ? `${log.actualReps ?? log.actualDurationS + ' s'}${log.actualWeight != null ? ` × ${log.actualWeight} kg` : ''}`
                : `${s.targetType === 'reps' ? s.targetReps : s.targetDurationS + ' s'}${s.targetWeight != null ? ` × ${s.targetWeight} kg` : ''}`;
          return (
            <li key={i} className={cls}>
              <span className="mk" />
              <span>{name}</span>
              <span className="v">{v}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ── Before and after ──

function StartScreen({ state, onStart }: { state: PlayerState; onStart: () => void }) {
  const groups = equipmentChecklist(state);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const est = estimateWorkoutSeconds(state.items);
  return (
    <main className="editor start-screen">
      <header className="topbar editor-bar">
        <Link className="icon-btn" to={`/workouts/${state.workoutId}`} aria-label="Back"><Icon name="back" /></Link>
        <h1 className="h2">{state.icon ? `${state.icon} ` : ''}{state.workoutName}</h1>
      </header>
      <p className="muted">About {formatMinutes(est)}, {stepsOf(state).length} steps.</p>
      {groups.length > 0 ? (
        <section className="section">
          <h2 className="h3">Get your equipment ready</h2>
          <div className="checklist">
            {groups.map((g) => (
              <div key={g.label} className="check-group">
                <div className="check-label">{g.label}</div>
                {g.items.map((item) => {
                  const key = `${g.label}|${item}`;
                  return (
                    <label key={key} className="check-item">
                      <input type="checkbox" checked={!!checked[key]} onChange={(e) => setChecked({ ...checked, [key]: e.target.checked })} />
                      <span>{item}</span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      ) : (
        <p className="section muted">No equipment needed.</p>
      )}
      <div className="start-footer">
        <button className="btn btn-primary btn-block start-btn" type="button" onClick={onStart}>Start workout</button>
      </div>
    </main>
  );
}

/** Hands a finished session to the review screen (saved first, so a reload can't lose it). */
function FinishedRedirect({ state }: { state: PlayerState }) {
  const navigate = useNavigate();
  const allowNext = useAllowNextNavigation();
  useEffect(() => {
    addFinished(state);
    clearActive(state.userId);
    announce();
    allowNext();
    navigate(`/review/${state.id}`, { replace: true });
  }, [state, navigate, allowNext]);
  return <div className="center-load">Saving…</div>;
}

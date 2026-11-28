import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  type BlockStep,
  type Exercise,
  type ExerciseStep,
  type RestStep,
  type Superset,
  type WorkoutItem,
  estimateWorkoutSeconds,
  workoutInputSchema,
} from '@setryx/shared';
import { formatMinutes, useDeleteWorkout, useDuplicateWorkout, useSaveWorkout, useWorkout } from '../data.ts';
import { ExercisePickerSheet } from '../components/exercises.tsx';
import { ExerciseStepSheet, RestStepSheet, SupersetSheet } from '../components/stepSheets.tsx';
import { move, useSortable } from '../components/sortable.ts';
import { FormError, Icon, LeaveDialog, Sheet, useBeforeUnload, useToast } from '../components/ui.tsx';
import { uid } from '../util.ts';
import { type BlockedNav, useAllowNextNavigation, useBackHandler } from '../components/backGuard.tsx';

type Draft = { name: string; icon: string; notes: string | null; items: WorkoutItem[] };
const EMPTY: Draft = { name: '', icon: '', notes: null, items: [] };
// Only emoji old enough that every device can draw them (none newer than 2018).
const ICONS = ['🏃', '🤸', '🤛', '🤜', '💪', '🏋️', '🦵', '🔥', '⚡', '🧘'];


function firstGrapheme(s: string): string {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const it = seg.segment(s.trim())[Symbol.iterator]().next();
  return it.done ? '' : it.value.segment;
}

/** Where a step lives: top level, or inside a superset. */
type Path = { blockId: string | null; stepId: string };

type Editing =
  | { kind: 'exercise'; path: Path; isNew: boolean }
  | { kind: 'rest'; path: Path; isNew: boolean }
  | { kind: 'superset'; id: string; isNew: boolean }
  | { kind: 'pick'; mode: 'add' | 'sets' | 'replace'; blockId: string | null; replace?: Path }
  | { kind: 'delete' }
  | null;

function describeStep(s: ExerciseStep): string {
  const parts = [s.targetType === 'reps' ? `${s.targetReps} reps` : `${s.targetDurationS} s`];
  parts.push(s.targetWeight != null ? `${s.targetWeight} kg` : 'bodyweight');
  if (s.tempo) parts.push(`tempo ${s.tempo}`);
  if (s.rir) parts.push(`RIR ${s.rir}`);
  return parts.join(', ');
}

export function WorkoutEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const loaded = useWorkout(id);
  const save = useSaveWorkout();
  const del = useDeleteWorkout();
  const dup = useDuplicateWorkout();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saved, setSaved] = useState<string>(JSON.stringify(EMPTY));
  const [exercises, setExercises] = useState<Record<string, Exercise>>({});
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const initialised = useRef(false);
  const allowNext = useAllowNextNavigation();
  const [leaving, setLeaving] = useState<BlockedNav | null>(null);

  useEffect(() => {
    if (!loaded.data || initialised.current) return;
    const w = loaded.data.workout;
    const d: Draft = { name: w.name, icon: w.icon, notes: w.notes, items: w.items };
    setDraft(d);
    setSaved(JSON.stringify(d));
    setExercises(loaded.data.exercises);
    initialised.current = true;
  }, [loaded.data]);

  const dirty = JSON.stringify(draft) !== saved;
  useBeforeUnload(dirty);
  useBackHandler(dirty, (nav) => setLeaving(nav));

  // ── Draft helpers ──
  const setItems = (fn: (items: WorkoutItem[]) => WorkoutItem[]) => setDraft((d) => ({ ...d, items: fn(d.items) }));
  const updateBlockSteps = (blockId: string, fn: (steps: BlockStep[]) => BlockStep[]) =>
    setItems((items) => items.map((it) => (it.kind === 'superset' && it.id === blockId ? { ...it, items: fn(it.items) } : it)));

  const findStep = (p: Path): WorkoutItem | BlockStep | undefined => {
    if (!p.blockId) return draft.items.find((i) => i.id === p.stepId);
    const ss = draft.items.find((i) => i.id === p.blockId);
    return ss?.kind === 'superset' ? ss.items.find((s) => s.id === p.stepId) : undefined;
  };
  const replaceStep = (p: Path, next: BlockStep) =>
    p.blockId ? updateBlockSteps(p.blockId, (steps) => steps.map((s) => (s.id === p.stepId ? next : s))) : setItems((items) => items.map((i) => (i.id === p.stepId ? next : i)));
  const removeStep = (p: Path) =>
    p.blockId ? updateBlockSteps(p.blockId, (steps) => steps.filter((s) => s.id !== p.stepId)) : setItems((items) => items.filter((i) => i.id !== p.stepId));
  const insertStep = (blockId: string | null, step: BlockStep) => (blockId ? updateBlockSteps(blockId, (steps) => [...steps, step]) : setItems((items) => [...items, step]));
  const moveStep = (p: Path, delta: number) => {
    const reorder = <T extends { id: string }>(list: T[]) => {
      const i = list.findIndex((x) => x.id === p.stepId);
      const j = i + delta;
      return j < 0 || j >= list.length ? list : move(list, i, j);
    };
    p.blockId ? updateBlockSteps(p.blockId, reorder) : setItems(reorder);
  };
  const duplicateStep = (p: Path) => {
    const copy = <T extends { id: string }>(list: T[]) => {
      const i = list.findIndex((x) => x.id === p.stepId);
      return i < 0 ? list : [...list.slice(0, i + 1), { ...list[i]!, id: uid() }, ...list.slice(i + 1)];
    };
    p.blockId ? updateBlockSteps(p.blockId, copy) : setItems(copy);
  };

  const newExerciseStep = (e: Exercise): ExerciseStep => ({
    kind: 'exercise', id: uid(), exerciseId: e.id, targetType: e.defaultType,
    targetReps: e.defaultType === 'reps' ? 10 : null, targetDurationS: e.defaultType === 'timed' ? 30 : null,
    targetWeight: null, tempo: null, rir: null, notes: null, equipmentNote: e.equipment.length ? e.equipment.join(', ') : null,
  });

  /** The name of the exercise a step is being changed from, for the picker. */
  const replacingName = (p?: Path): string => {
    const cur = p && findStep(p);
    return cur?.kind === 'exercise' ? (exercises[cur.exerciseId]?.name ?? 'this exercise') : 'this exercise';
  };
  const onPick = (e: Exercise) => {
    if (editing?.kind !== 'pick') return;
    setExercises((m) => ({ ...m, [e.id]: e }));
    if (editing.mode === 'replace' && editing.replace) {
      const cur = findStep(editing.replace);
      if (cur?.kind === 'exercise') replaceStep(editing.replace, { ...cur, exerciseId: e.id });
      setEditing({ kind: 'exercise', path: editing.replace, isNew: false });
      return;
    }
    const step = newExerciseStep(e);
    if (editing.mode === 'sets') {
      const ss: Superset = { kind: 'superset', id: uid(), label: e.name, rounds: 3, items: [step, { kind: 'rest', id: uid(), durationS: 60, label: null }] };
      setItems((items) => [...items, ss]);
      setEditing({ kind: 'exercise', path: { blockId: ss.id, stepId: step.id }, isNew: true });
      return;
    }
    insertStep(editing.blockId, step);
    setEditing({ kind: 'exercise', path: { blockId: editing.blockId, stepId: step.id }, isNew: true });
  };

  /** Closing a brand-new step without saving it removes it again. */
  const closeNew = (path: Path, wasNew: boolean) => () => {
    if (wasNew) removeStep(path);
    setEditing(null);
  };

  // ── Save ──
  const doSave = (then?: () => void) => {
    const parsed = workoutInputSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Some steps need fixing.');
      if (leaving) (leaving.reset(), setLeaving(null));
      return;
    }
    setError(null);
    save.mutate(
      { id, input: draft },
      {
        onSuccess: (data) => {
          const d: Draft = { name: data.workout.name, icon: data.workout.icon, notes: data.workout.notes, items: data.workout.items };
          setDraft(d);
          setSaved(JSON.stringify(d));
          setExercises(data.exercises);
          toast('Workout saved');
          if (then) then();
          else if (isNew) {
            allowNext();
            navigate(`/workouts/${data.workout.id}`, { replace: true });
          }
        },
        onError: (err) => {
          setError(err.message);
          if (leaving) (leaving.reset(), setLeaving(null));
        },
      },
    );
  };

  const leaveTo = (to: string) => {
    allowNext();
    navigate(to);
  };

  const topSort = useSortable((from, to) => setItems((items) => move(items, from, to)));
  const estimate = useMemo(() => estimateWorkoutSeconds(draft.items), [draft.items]);

  if (id && loaded.isPending) return <div className="center-load">Loading workout…</div>;
  if (id && loaded.isError) {
    return (
      <main className="editor">
        <FormError error={loaded.error} />
        <Link className="btn btn-quiet" to="/workouts">Back to workouts</Link>
      </main>
    );
  }

  const editingStep = editing && (editing.kind === 'exercise' || editing.kind === 'rest') ? findStep(editing.path) : undefined;
  const editingSuperset = editing?.kind === 'superset' ? draft.items.find((i) => i.id === editing.id) : undefined;

  return (
    <main className="editor">
      <header className="topbar editor-bar">
        <button className="icon-btn" type="button" aria-label="Back to workouts" onClick={() => navigate('/workouts')}><Icon name="back" /></button>
        <h1 className="h2">
          {draft.name || (isNew ? 'New workout' : 'Workout')}
          {dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
        </h1>
        {!isNew && !dirty && <Link className="btn btn-quiet btn-sm" to={`/play/${id}`}>Start workout</Link>}
        <button className="btn btn-primary btn-sm" type="button" onClick={() => doSave()} disabled={save.isPending || (!dirty && !isNew)}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="editor-head">
        <div className="field">
          <label htmlFor="w-name">Workout name</label>
          <input id="w-name" className="input" value={draft.name} placeholder="Push A" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="field">
          <span className="label">Icon</span>
          <div className="chips" role="radiogroup" aria-label="Icon">
            {ICONS.map((ic) => (
              <button key={ic} type="button" role="radio" aria-checked={draft.icon === ic} className={`chip chip-emoji${draft.icon === ic ? ' on' : ''}`} onClick={() => setDraft({ ...draft, icon: draft.icon === ic ? '' : ic })}>{ic}</button>
            ))}
            <input className="input chip-input" aria-label="Other icon" placeholder="Other" value={ICONS.includes(draft.icon) ? '' : draft.icon} onChange={(e) => setDraft({ ...draft, icon: firstGrapheme(e.target.value) })} />
          </div>
        </div>
      </div>

      <div className="add-row">
        <button className="btn btn-quiet btn-sm" type="button" onClick={() => setEditing({ kind: 'pick', mode: 'add', blockId: null })}>Add exercise</button>
        <button className="btn btn-quiet btn-sm" type="button" onClick={() => setEditing({ kind: 'pick', mode: 'sets', blockId: null })}>Add as sets</button>
        <button
          className="btn btn-quiet btn-sm"
          type="button"
          onClick={() => {
            const ss: Superset = { kind: 'superset', id: uid(), label: '', rounds: 3, items: [] };
            setItems((items) => [...items, ss]);
            setEditing({ kind: 'superset', id: ss.id, isNew: true });
          }}
        >
          Add superset
        </button>
        <button
          className="btn btn-quiet btn-sm"
          type="button"
          onClick={() => {
            const r: RestStep = { kind: 'rest', id: uid(), durationS: 60, label: null };
            insertStep(null, r);
            setEditing({ kind: 'rest', path: { blockId: null, stepId: r.id }, isNew: true });
          }}
        >
          Add rest
        </button>
      </div>

      {error && <div className="form-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      {draft.items.length === 0 ? (
        <section className="empty">
          <h2 className="h2">Start with an exercise</h2>
          <p className="muted">“Add as sets” makes the usual pattern in one go: an exercise and a rest, repeated for 3 rounds.</p>
        </section>
      ) : (
        <div className="blocks" ref={(el) => void (topSort.ref.current = el)}>
          {draft.items.map((item, i) =>
            item.kind === 'superset' ? (
              <SupersetBlock
                key={item.id}
                superset={item}
                exercises={exercises}
                handle={topSort.handle(i)}
                onEdit={() => setEditing({ kind: 'superset', id: item.id, isNew: false })}
                onEditStep={(s) => setEditing({ kind: s.kind, path: { blockId: item.id, stepId: s.id }, isNew: false })}
                onReorder={(from, to) => updateBlockSteps(item.id, (steps) => move(steps, from, to))}
                onAddExercise={() => setEditing({ kind: 'pick', mode: 'add', blockId: item.id })}
                onAddRest={() => {
                  const r: RestStep = { kind: 'rest', id: uid(), durationS: 30, label: null };
                  insertStep(item.id, r);
                  setEditing({ kind: 'rest', path: { blockId: item.id, stepId: r.id }, isNew: true });
                }}
              />
            ) : (
              <div key={item.id} data-sort-key={item.id} className="block block-single">
                <StepRow step={item} exercises={exercises} handle={topSort.handle(i)} onEdit={() => setEditing({ kind: item.kind, path: { blockId: null, stepId: item.id }, isNew: false })} />
              </div>
            ),
          )}
        </div>
      )}

      {draft.items.length > 0 && <p className="small muted" style={{ margin: '18px 0' }}>About {formatMinutes(estimate)}. The final rest is skipped automatically.</p>}

      {!isNew && (
        <div className="split-actions" style={{ margin: '8px 0 40px' }}>
          <button
            className="btn btn-strong btn-sm"
            type="button"
            disabled={dirty || dup.isPending}
            title={dirty ? 'Save first to duplicate' : undefined}
            onClick={() => dup.mutate(id!, { onSuccess: (d) => (toast('Workout duplicated'), leaveTo(`/workouts/${d.workout.id}`)) })}
          >
            Duplicate workout
          </button>
          <button className="btn btn-quiet btn-danger btn-sm" type="button" onClick={() => setEditing({ kind: 'delete' })}>Delete workout</button>
        </div>
      )}

      {/* ── Sheets ── */}
      {editing?.kind === 'pick' && <ExercisePickerSheet replacing={editing.mode === 'replace' ? replacingName(editing.replace) : undefined} onPick={onPick} onClose={() => setEditing(editing.replace ? { kind: 'exercise', path: editing.replace, isNew: false } : null)} />}

      {editing?.kind === 'exercise' && editingStep?.kind === 'exercise' && (
        <ExerciseStepSheet
          key={editingStep.id + editingStep.exerciseId}
          step={editingStep}
          exercise={exercises[editingStep.exerciseId]}
          isNew={editing.isNew}
          onSave={(s) => (replaceStep(editing.path, s), setEditing(null))}
          onChangeExercise={() => setEditing({ kind: 'pick', mode: 'replace', blockId: editing.path.blockId, replace: editing.path })}
          onClose={closeNew(editing.path, editing.isNew)}
          onMoveUp={() => moveStep(editing.path, -1)}
          onMoveDown={() => moveStep(editing.path, 1)}
          onDuplicate={() => duplicateStep(editing.path)}
          onRemove={() => removeStep(editing.path)}
          onCuesSaved={(e) => setExercises((m) => ({ ...m, [e.id]: e }))}
        />
      )}

      {editing?.kind === 'rest' && editingStep?.kind === 'rest' && (
        <RestStepSheet
          step={editingStep}
          isNew={editing.isNew}
          onSave={(s) => (replaceStep(editing.path, s), setEditing(null))}
          onClose={closeNew(editing.path, editing.isNew)}
          onMoveUp={() => moveStep(editing.path, -1)}
          onMoveDown={() => moveStep(editing.path, 1)}
          onDuplicate={() => duplicateStep(editing.path)}
          onRemove={() => removeStep(editing.path)}
        />
      )}

      {editing?.kind === 'superset' && editingSuperset?.kind === 'superset' && (
        <SupersetSheet
          superset={editingSuperset}
          isNew={editing.isNew}
          onSave={(s) => (setItems((items) => items.map((it) => (it.id === s.id ? s : it))), setEditing(null))}
          onClose={() => {
            if (editing.isNew) setItems((items) => items.filter((it) => !(it.id === editing.id && it.kind === 'superset' && it.items.length === 0 && !it.label)));
            setEditing(null);
          }}
          onMoveUp={() => moveStep({ blockId: null, stepId: editing.id }, -1)}
          onMoveDown={() => moveStep({ blockId: null, stepId: editing.id }, 1)}
          onDuplicate={() => setItems((items) => items.flatMap((it) => (it.id === editing.id && it.kind === 'superset' ? [it, { ...it, id: uid(), items: it.items.map((c) => ({ ...c, id: uid() })) }] : [it])))}
          onRemove={() => setItems((items) => items.filter((it) => it.id !== editing.id))}
        />
      )}

      {editing?.kind === 'delete' && (
        <Sheet title={`Delete ${draft.name || 'this workout'}?`} onClose={() => setEditing(null)}>
          <p className="muted">It disappears from your workouts. Sessions you already did keep their history.</p>
          <button
            className="btn btn-primary btn-block"
            type="button"
            onClick={() => del.mutate(id!, { onSuccess: () => (toast('Workout deleted'), leaveTo('/workouts')) })}
            disabled={del.isPending}
          >
            Delete workout
          </button>
          <button className="btn btn-block" type="button" onClick={() => setEditing(null)}>Keep it</button>
        </Sheet>
      )}

      {leaving && (
        <LeaveDialog
          message={`You have unsaved changes to ${draft.name || 'this workout'}. If you leave now without saving, those changes are lost.`}
          saveLabel="Save workout"
          saving={save.isPending}
          onSave={() => doSave(() => (leaving.proceed(), setLeaving(null)))}
          onDiscard={() => (leaving.proceed(), setLeaving(null))}
          onKeep={() => (leaving.reset(), setLeaving(null))}
        />
      )}
    </main>
  );
}

function StepRow({ step, exercises, handle, onEdit }: { step: BlockStep; exercises: Record<string, Exercise>; handle: ReturnType<ReturnType<typeof useSortable>['handle']>; onEdit: () => void }) {
  const name = step.kind === 'rest' ? (step.label ? `${step.label} ${step.durationS} s` : `Rest ${step.durationS} s`) : (exercises[step.exerciseId]?.name ?? 'Exercise');
  return (
    <div className={`step${step.kind === 'rest' ? ' rest' : ''}`}>
      <span className="grip" aria-hidden {...handle}><Icon name="grip" /></span>
      <button className="step-main" type="button" onClick={onEdit}>
        <span className="name">{name}</span>
        {step.kind === 'exercise' && <span className="target">{describeStep(step)}</span>}
      </button>
      {step.kind === 'exercise' && step.targetType === 'timed' && <span className="tag">Timed</span>}
    </div>
  );
}

function SupersetBlock({
  superset,
  exercises,
  handle,
  onEdit,
  onEditStep,
  onReorder,
  onAddExercise,
  onAddRest,
}: {
  superset: Superset;
  exercises: Record<string, Exercise>;
  handle: ReturnType<ReturnType<typeof useSortable>['handle']>;
  onEdit: () => void;
  onEditStep: (s: BlockStep) => void;
  onReorder: (from: number, to: number) => void;
  onAddExercise: () => void;
  onAddRest: () => void;
}) {
  const sort = useSortable(onReorder);
  return (
    <section className="block block-superset" data-sort-key={superset.id} aria-label={superset.label || 'Superset'}>
      {/* The thick bar on the left is the handle: press and drag to move the superset. */}
      <span className="block-bar" title="Hold and drag to move this superset" aria-hidden {...handle} />
      <div className="block-head">
        <button className="block-title" type="button" onClick={onEdit}>
          <span className="name">{superset.label || 'Superset'}</span>
          <span className="rounds">{superset.rounds} round{superset.rounds === 1 ? '' : 's'}</span>
        </button>
      </div>
      <div ref={(el) => void (sort.ref.current = el)}>
        {superset.items.map((s, i) => (
          <div key={s.id} data-sort-key={s.id}>
            <StepRow step={s} exercises={exercises} handle={sort.handle(i)} onEdit={() => onEditStep(s)} />
          </div>
        ))}
      </div>
      {superset.items.length === 0 && <p className="small muted" style={{ padding: '8px 0' }}>Add the exercises and rests that repeat each round.</p>}
      <div className="block-add">
        <button className="btn btn-sm" type="button" onClick={onAddExercise}><Icon name="plus" /> Exercise</button>
        <button className="btn btn-sm" type="button" onClick={onAddRest}><Icon name="plus" /> Rest</button>
      </div>
    </section>
  );
}

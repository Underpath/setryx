import { type FormEvent, useMemo, useState } from 'react';
import type { Exercise, ExerciseInput, ExerciseType } from '@setryx/shared';
import { type ExerciseFilters, useDeleteExercise, useExerciseFacets, useExerciseSearch, useSaveExercise } from '../data.ts';
import { Field, FormError, Icon, LeaveDialog, Sheet, fieldErrors, useToast } from './ui.tsx';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function exerciseMeta(e: Exercise): string {
  const parts = [e.primaryMuscles.map(cap).join(', '), e.equipment.map(cap).join(', ')].filter(Boolean);
  return parts.length ? parts.join(' / ') : e.isCustom ? 'Your exercise' : '';
}

/** Search box, filters and a result list. Used by the Library page and the picker. */
export function ExerciseBrowser({ onPick, pickLabel, onInfo }: { onPick: (e: Exercise) => void; pickLabel?: string; onInfo?: (e: Exercise) => void }) {
  const [f, setF] = useState<ExerciseFilters>({ q: '', muscle: '', equipment: '', custom: false });
  const search = useExerciseSearch(f);
  const facets = useExerciseFacets();
  const set = (patch: Partial<ExerciseFilters>) => setF((prev) => ({ ...prev, ...patch }));
  return (
    <div className="browser">
      <div className="search">
        <Icon name="search" />
        <input className="input" type="search" placeholder="Search exercises" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search exercises" />
      </div>
      <div className="filters">
        <select className="input" value={f.muscle} onChange={(e) => set({ muscle: e.target.value })} aria-label="Muscle">
          <option value="">All muscles</option>
          {facets.data?.muscles.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
        </select>
        <select className="input" value={f.equipment} onChange={(e) => set({ equipment: e.target.value })} aria-label="Equipment">
          <option value="">All equipment</option>
          {facets.data?.equipment.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={f.custom} onChange={(e) => set({ custom: e.target.checked })} /> Only mine</label>
      </div>
      <FormError error={search.error} />
      <p className="small muted" aria-live="polite">{search.data ? `${search.data.total} exercise${search.data.total === 1 ? '' : 's'}` : 'Searching…'}</p>
      <ul className="rows">
        {search.data?.exercises.map((e) => (
          <li key={e.id} className={onInfo ? 'pick-row' : undefined}>
            <button className="row row-button" type="button" onClick={() => onPick(e)} aria-label={pickLabel ? `${pickLabel}: ${e.name}` : e.name}>
              <span className="main">
                <span className="name">{e.name}</span>
                <span className="meta">{exerciseMeta(e)}</span>
              </span>
              {e.isCustom && <span className="tag tag-blue">Mine</span>}
            </button>
            {onInfo && (
              <button className="icon-btn" type="button" aria-label={`Details for ${e.name}`} onClick={() => onInfo(e)}>
                <Icon name="info" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {search.data && search.data.total > search.data.exercises.length && (
        <p className="small muted" style={{ marginTop: 10 }}>Showing the first {search.data.exercises.length}. Narrow the search to see others.</p>
      )}
    </div>
  );
}

/** Start and end photos, when they're on the server. Missing ones just don't show. */
export function ExercisePhotos({ images, name }: { images: string[]; name: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const shown = images.filter((p) => !failed.includes(p)).slice(0, 2);
  if (!shown.length) return null;
  return (
    <div className="ex-photos">
      {shown.map((p, i) => (
        <figure key={p}>
          <img src={`/api/v1/exercise-images/${p}?v=2`} alt={`${name}, ${i === 0 ? 'start' : 'end'} position`} loading="lazy" onError={() => setFailed((f) => [...f, p])} />
          <figcaption>{i === 0 ? 'Start' : 'End'}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function ExerciseDetailSheet({ exercise, onClose, onEdit, onDuplicate, action }: { exercise: Exercise; onClose: () => void; onEdit?: () => void; onDuplicate?: () => void; action?: { label: string; onClick: () => void } }) {
  return (
    <Sheet title={exercise.name} onClose={onClose}>
      {exerciseMeta(exercise) && <p className="muted">{exerciseMeta(exercise)}</p>}
      {exercise.secondaryMuscles.length > 0 && <p className="small muted">Also works: {exercise.secondaryMuscles.map(cap).join(', ')}</p>}
      <ExercisePhotos images={exercise.images} name={exercise.name} />
      {exercise.instructions.length > 0 ? (
        <ol className="instructions">{exercise.instructions.map((s, i) => <li key={i}>{s}</li>)}</ol>
      ) : (
        <p className="small muted">No instructions yet.</p>
      )}
      <div className="sheet-actions">
        {action && <button className="btn btn-primary" type="button" onClick={action.onClick}>{action.label}</button>}
        {exercise.isCustom && onEdit && <button className="btn btn-primary" type="button" onClick={onEdit}>Edit exercise</button>}
        {!exercise.isCustom && onDuplicate && <button className="btn btn-quiet" type="button" onClick={onDuplicate}>Make my own copy</button>}
      </div>
    </Sheet>
  );
}

type FormState = { name: string; defaultType: ExerciseType; primaryMuscles: string; equipment: string; instructions: string };
const toForm = (e?: Partial<Exercise>): FormState => ({
  name: e?.name ?? '',
  defaultType: e?.defaultType ?? 'reps',
  primaryMuscles: (e?.primaryMuscles ?? []).join(', '),
  equipment: (e?.equipment ?? []).join(', '),
  instructions: (e?.instructions ?? []).join('\n'),
});
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Create or edit one of your own exercises. Closing with changes asks to save or discard. */
export function CustomExerciseSheet({ exercise, initial, onClose, onSaved }: { exercise?: Exercise; initial?: Partial<Exercise>; onClose: () => void; onSaved?: (e: Exercise) => void }) {
  const start = useMemo(() => toForm(exercise ?? initial), [exercise, initial]);
  const [form, setForm] = useState(start);
  const [leaving, setLeaving] = useState(false);
  const save = useSaveExercise();
  const del = useDeleteExercise();
  const toast = useToast();
  const dirty = JSON.stringify(form) !== JSON.stringify(start) || (!exercise && !!initial);
  const { fields, general } = fieldErrors(save.error);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const input: ExerciseInput = {
      name: form.name,
      defaultType: form.defaultType,
      primaryMuscles: list(form.primaryMuscles),
      equipment: list(form.equipment),
      instructions: form.instructions.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    save.mutate(
      { id: exercise?.id, input },
      {
        onSuccess: ({ exercise: saved }) => {
          toast(exercise ? 'Exercise saved' : 'Exercise added');
          onSaved?.(saved);
          onClose();
        },
        onError: () => setLeaving(false),
      },
    );
  };
  const requestClose = () => (dirty ? setLeaving(true) : onClose());

  if (leaving) {
    return (
      <LeaveDialog
        message={exercise ? `You changed ${exercise.name}. If you close it now, the changes are lost.` : 'This exercise hasn’t been saved yet.'}
        saveLabel="Save exercise"
        saving={save.isPending}
        onSave={() => submit()}
        onDiscard={onClose}
        onKeep={() => setLeaving(false)}
      />
    );
  }

  return (
    <Sheet title={exercise ? 'Edit exercise' : 'New exercise'} onClose={requestClose}>
      <form className="form" onSubmit={submit} noValidate>
        <Field label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields.name} />
        <div className="field">
          <span className="label">Usually done for</span>
          <div className="seg" role="radiogroup" aria-label="Usually done for">
            {(['reps', 'timed'] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={form.defaultType === t} className={form.defaultType === t ? 'on' : ''} onClick={() => setForm({ ...form, defaultType: t })}>
                {t === 'reps' ? 'Reps' : 'Time'}
              </button>
            ))}
          </div>
        </div>
        <Field label="Muscles" value={form.primaryMuscles} onChange={(e) => setForm({ ...form, primaryMuscles: e.target.value })} hint="Separate with commas, e.g. chest, triceps." />
        <Field label="Equipment" value={form.equipment} onChange={(e) => setForm({ ...form, equipment: e.target.value })} hint="Separate with commas, e.g. dumbbells, incline bench." />
        <div className="field">
          <label htmlFor="ex-instr">How to do it</label>
          <textarea id="ex-instr" className="input" rows={4} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
          <div className="hint">One step per line.</div>
        </div>
        <FormError error={general} />
        <button className="btn btn-primary btn-block" type="submit" disabled={save.isPending}>{exercise ? 'Save exercise' : 'Add exercise'}</button>
        {exercise && (
          <button
            className="btn btn-danger btn-block"
            type="button"
            onClick={() =>
              del.mutate(exercise.id, {
                onSuccess: () => {
                  toast('Exercise removed');
                  onClose();
                },
              })
            }
          >
            Remove exercise
          </button>
        )}
      </form>
    </Sheet>
  );
}

/** Pick an exercise for a workout step, or make a new one on the spot. */
export function ExercisePickerSheet({ title, onPick, onClose }: { title: string; onPick: (e: Exercise) => void; onClose: () => void }) {
  const [creating, setCreating] = useState(false);
  const [info, setInfo] = useState<Exercise | null>(null);
  if (creating) return <CustomExerciseSheet onClose={() => setCreating(false)} onSaved={onPick} />;
  // Details replace the list while open; closing them comes back to the list.
  if (info) return <ExerciseDetailSheet exercise={info} onClose={() => setInfo(null)} action={{ label: `${title === 'Change exercise' ? 'Use' : 'Add'} this exercise`, onClick: () => onPick(info) }} />;
  return (
    <Sheet title={title} onClose={onClose}>
      <button className="btn btn-quiet btn-sm" type="button" onClick={() => setCreating(true)} style={{ justifySelf: 'start' }}>
        <Icon name="plus" /> New exercise
      </button>
      <ExerciseBrowser onPick={onPick} pickLabel="Add" onInfo={setInfo} />
    </Sheet>
  );
}

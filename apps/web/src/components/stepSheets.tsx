import { type FormEvent, type ReactNode, useState } from 'react';
import type { Exercise, ExerciseStep, ExerciseType, RestStep, Superset } from '@setryx/shared';
import { Field, LeaveDialog, Sheet } from './ui.tsx';

/**
 * Wraps a step form: closing with changes asks to save the step or discard the changes.
 * onSave applies the change (the parent closes the sheet); onClose means cancel.
 */
function GuardedSheet({ title, dirty, what, onApply, onClose, children }: { title: string; dirty: boolean; what: string; onApply: () => void; onClose: () => void; children: (submit: (e?: FormEvent) => void) => ReactNode }) {
  const [leaving, setLeaving] = useState(false);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    onApply();
  };
  if (leaving) {
    return (
      <LeaveDialog
        message={`You changed this ${what}. Discarding drops only these changes; the rest of the workout stays as it is.`}
        saveLabel={`Save ${what}`}
        onSave={() => submit()}
        onDiscard={onClose}
        onKeep={() => setLeaving(false)}
      />
    );
  }
  return (
    <Sheet title={title} onClose={() => (dirty ? setLeaving(true) : onClose())}>
      {children(submit)}
    </Sheet>
  );
}

const numOrNull = (s: string): number | null => {
  const n = Number(s.replace(',', '.'));
  return s.trim() === '' || !Number.isFinite(n) ? null : n;
};

type StepActions = { onMoveUp?: () => void; onMoveDown?: () => void; onDuplicate?: () => void; onRemove: () => void };

function StepActionsRow({ onMoveUp, onMoveDown, onDuplicate, onRemove, close }: StepActions & { close: () => void }) {
  const run = (fn?: () => void) => () => {
    fn?.();
    close();
  };
  return (
    <div className="sheet-actions">
      {onMoveUp && <button className="btn btn-quiet btn-sm" type="button" onClick={run(onMoveUp)}>Move up</button>}
      {onMoveDown && <button className="btn btn-quiet btn-sm" type="button" onClick={run(onMoveDown)}>Move down</button>}
      {onDuplicate && <button className="btn btn-quiet btn-sm" type="button" onClick={run(onDuplicate)}>Duplicate</button>}
      <button className="btn btn-danger btn-sm" type="button" onClick={run(onRemove)}>Remove</button>
    </div>
  );
}

export function ExerciseStepSheet({
  step,
  exercise,
  isNew,
  onSave,
  onChangeExercise,
  onClose,
  ...actions
}: { step: ExerciseStep; exercise: Exercise | undefined; isNew: boolean; onSave: (s: ExerciseStep) => void; onChangeExercise: () => void; onClose: () => void } & StepActions) {
  const start = {
    targetType: step.targetType,
    reps: step.targetReps?.toString() ?? '',
    duration: step.targetDurationS?.toString() ?? '',
    weight: step.targetWeight?.toString() ?? '',
    tempo: step.tempo ?? '',
    rir: step.rir ?? '',
    notes: step.notes ?? '',
    equipmentNote: step.equipmentNote ?? '',
  };
  const [f, setF] = useState(start);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));
  const dirty = isNew || JSON.stringify(f) !== JSON.stringify(start);

  const apply = () => {
    const reps = numOrNull(f.reps);
    const duration = numOrNull(f.duration);
    const weight = numOrNull(f.weight);
    const errs: Record<string, string> = {};
    if (f.targetType === 'reps' && (!reps || reps < 1 || !Number.isInteger(reps))) errs.reps = 'Enter a whole number of reps.';
    if (f.targetType === 'timed' && (!duration || duration < 1 || !Number.isInteger(duration))) errs.duration = 'Enter the seconds as a whole number.';
    if (weight !== null && (weight < 0 || weight > 2000)) errs.weight = 'Enter a weight between 0 and 2000 kg.';
    if (f.weight.trim() && weight === null) errs.weight = 'Enter a number, like 8 or 22.5.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSave({
      ...step,
      targetType: f.targetType,
      targetReps: f.targetType === 'reps' ? reps : null,
      targetDurationS: f.targetType === 'timed' ? duration : null,
      targetWeight: weight,
      tempo: f.tempo.trim() || null,
      rir: f.rir.trim() || null,
      notes: f.notes.trim() || null,
      equipmentNote: f.equipmentNote.trim() || null,
    });
  };

  return (
    <GuardedSheet title={exercise?.name ?? 'Exercise'} what="step" dirty={dirty} onApply={apply} onClose={onClose}>
      {(submit) => (
        <form className="form" onSubmit={submit} noValidate>
          <button className="btn btn-quiet btn-sm" type="button" onClick={onChangeExercise} style={{ justifySelf: 'start' }}>Change exercise</button>
          <div className="seg" role="radiogroup" aria-label="Target">
            {(['reps', 'timed'] as ExerciseType[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={f.targetType === t} className={f.targetType === t ? 'on' : ''} onClick={() => set({ targetType: t })}>
                {t === 'reps' ? 'Reps' : 'Time'}
              </button>
            ))}
          </div>
          <div className="field-row">
            {f.targetType === 'reps' ? (
              <Field label="Reps" inputMode="numeric" value={f.reps} onChange={(e) => set({ reps: e.target.value })} error={errors.reps} />
            ) : (
              <Field label="Seconds" inputMode="numeric" value={f.duration} onChange={(e) => set({ duration: e.target.value })} error={errors.duration} />
            )}
            <Field label="Weight (kg)" inputMode="decimal" value={f.weight} onChange={(e) => set({ weight: e.target.value })} error={errors.weight} hint="Leave empty for bodyweight." />
          </div>
          <div className="field-row">
            <Field label="Tempo" value={f.tempo} onChange={(e) => set({ tempo: e.target.value })} placeholder="3-1-1-0" />
            <Field label="Reps in reserve" value={f.rir} onChange={(e) => set({ rir: e.target.value })} placeholder="2" />
          </div>
          <Field label="Equipment" value={f.equipmentNote} onChange={(e) => set({ equipmentNote: e.target.value })} placeholder="Dumbbells, incline bench" hint="Shown on the checklist before you start." />
          <div className="field">
            <label htmlFor="step-notes">Form cues</label>
            <textarea id="step-notes" className="input" rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
          </div>
          <button className="btn btn-primary btn-block" type="submit">Save step</button>
          {!isNew && <StepActionsRow {...actions} close={onClose} />}
        </form>
      )}
    </GuardedSheet>
  );
}

export function RestStepSheet({ step, isNew, onSave, onClose, ...actions }: { step: RestStep; isNew: boolean; onSave: (s: RestStep) => void; onClose: () => void } & StepActions) {
  const start = { duration: String(step.durationS), label: step.label ?? '' };
  const [f, setF] = useState(start);
  const [error, setError] = useState<string>();
  const dirty = isNew || JSON.stringify(f) !== JSON.stringify(start);
  const apply = () => {
    const d = numOrNull(f.duration);
    if (!d || d < 1 || d > 3600 || !Number.isInteger(d)) return setError('Enter whole seconds, from 1 to 3600.');
    onSave({ ...step, durationS: d, label: f.label.trim() || null });
  };
  return (
    <GuardedSheet title="Rest" what="rest" dirty={dirty} onApply={apply} onClose={onClose}>
      {(submit) => (
        <form className="form" onSubmit={submit} noValidate>
          <Field label="Seconds" inputMode="numeric" value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} error={error} />
          <div className="chips">
            {[15, 30, 45, 60, 90, 120].map((s) => (
              <button key={s} type="button" className={`chip${f.duration === String(s) ? ' on' : ''}`} onClick={() => setF({ ...f, duration: String(s) })}>{s} s</button>
            ))}
          </div>
          <Field label="Name (optional)" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Rest" hint="For example “Transition” or “Switch sides”." />
          <button className="btn btn-primary btn-block" type="submit">Save rest</button>
          {!isNew && <StepActionsRow {...actions} close={onClose} />}
        </form>
      )}
    </GuardedSheet>
  );
}

export function SupersetSheet({ superset, isNew, onSave, onClose, ...actions }: { superset: Superset; isNew: boolean; onSave: (s: Superset) => void; onClose: () => void } & StepActions) {
  const start = { label: superset.label, rounds: String(superset.rounds) };
  const [f, setF] = useState(start);
  const [error, setError] = useState<string>();
  const dirty = isNew || JSON.stringify(f) !== JSON.stringify(start);
  const apply = () => {
    const r = numOrNull(f.rounds);
    if (!r || r < 1 || r > 20 || !Number.isInteger(r)) return setError('Enter 1 to 20 rounds.');
    onSave({ ...superset, label: f.label.trim(), rounds: r });
  };
  return (
    <GuardedSheet title={isNew ? 'New superset' : 'Superset'} what="superset" dirty={dirty} onApply={apply} onClose={onClose}>
      {(submit) => (
        <form className="form" onSubmit={submit} noValidate>
          <Field label="Name" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Chest press and side delts" />
          <Field label="Rounds" inputMode="numeric" value={f.rounds} onChange={(e) => setF({ ...f, rounds: e.target.value })} error={error} hint="Every step in the superset repeats this many times." />
          <button className="btn btn-primary btn-block" type="submit">Save superset</button>
          {!isNew && <StepActionsRow {...actions} close={onClose} />}
        </form>
      )}
    </GuardedSheet>
  );
}

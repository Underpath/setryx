import { useState } from 'react';
import type { Exercise, PublicUser } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';
import { CustomExerciseSheet, ExerciseBrowser, ExerciseDetailSheet } from '../components/exercises.tsx';

type Open = { kind: 'view'; exercise: Exercise } | { kind: 'edit'; exercise: Exercise } | { kind: 'new'; initial?: Partial<Exercise> } | null;

export function LibraryPage({ user }: { user: PublicUser }) {
  const [open, setOpen] = useState<Open>(null);
  return (
    <>
      <TopBar
        title="Library"
        user={user}
        actions={<button className="btn btn-quiet btn-sm" type="button" onClick={() => setOpen({ kind: 'new' })}>New exercise</button>}
      />
      <ExerciseBrowser onPick={(exercise) => setOpen({ kind: 'view', exercise })} />
      {open?.kind === 'view' && (
        <ExerciseDetailSheet
          exercise={open.exercise}
          onClose={() => setOpen(null)}
          onEdit={() => setOpen({ kind: 'edit', exercise: open.exercise })}
          onDuplicate={() => setOpen({ kind: 'new', initial: { ...open.exercise, name: `${open.exercise.name} (mine)` } })}
        />
      )}
      {open?.kind === 'edit' && <CustomExerciseSheet exercise={open.exercise} onClose={() => setOpen(null)} />}
      {open?.kind === 'new' && <CustomExerciseSheet initial={open.initial} onClose={() => setOpen(null)} />}
    </>
  );
}

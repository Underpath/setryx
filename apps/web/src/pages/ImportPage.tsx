import { type ChangeEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ImportChoice, RoutineImportPreview } from '@setryx/shared';
import { formatMinutes, useImportPreview, useImportRoutines } from '../data.ts';
import { FormError, Icon, useToast } from '../components/ui.tsx';

const choiceValue = (c: ImportChoice) => (c.type === 'custom' ? 'custom' : `${c.type}:${c.id}`);
function parseChoice(v: string): ImportChoice {
  if (v === 'custom') return { type: 'custom' };
  const [type, ...rest] = v.split(':');
  return { type: type as 'library' | 'existing', id: rest.join(':') };
}

export function ImportPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const preview = useImportPreview();
  const doImport = useImportRoutines();
  const [data, setData] = useState<unknown>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({});

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError(null);
    preview.reset();
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setFileError('That file isn’t valid JSON. Pick the .json file you exported.');
      return;
    }
    setData(json);
    preview.mutate(json, {
      onSuccess: (p: RoutineImportPreview) => setChoices(Object.fromEntries(p.exercises.map((x) => [x.key, x.defaultChoice]))),
    });
  };

  const p = preview.data;
  const ownCount = p ? p.exercises.filter((x) => choices[x.key]?.type === 'custom').length : 0;

  return (
    <main className="editor">
      <header className="topbar editor-bar">
        <Link className="icon-btn" to="/workouts" aria-label="Back to workouts"><Icon name="back" /></Link>
        <h1 className="h2">Import routines</h1>
      </header>

      <p className="muted" style={{ maxWidth: '60ch' }}>
        Pick a JSON export from your earlier tracker. Each routine becomes a workout here, with its supersets, rests, tempo, reps in reserve and weights.
      </p>
      <label className="btn btn-primary file-btn" style={{ marginTop: 16 }}>
        {p ? 'Pick a different file' : 'Pick a file'}
        <input type="file" accept="application/json,.json" onChange={onFile} />
      </label>
      {fileError && <div className="form-error" role="alert" style={{ marginTop: 14 }}>{fileError}</div>}
      <div style={{ marginTop: 14 }}><FormError error={preview.error} /></div>
      {preview.isPending && <p className="muted" style={{ marginTop: 14 }}>Reading your file…</p>}

      {p && (
        <>
          <section className="section">
            <h2 className="h3">{p.workouts.length} workout{p.workouts.length === 1 ? '' : 's'}</h2>
            <ul className="rows">
              {p.workouts.map((w, i) => (
                <li className="row" key={i}>
                  <span className="emoji" aria-hidden>{w.icon || '•'}</span>
                  <div className="main">
                    <div className="name">{w.name}</div>
                    <div className="meta">{w.blockCount} block{w.blockCount === 1 ? '' : 's'}, {w.stepCount} steps, about {formatMinutes(w.estimatedS)}</div>
                  </div>
                  {w.existingName && <span className="tag">You already have one with this name</span>}
                </li>
              ))}
            </ul>
          </section>

          <section className="section">
            <h2 className="h3">{p.exercises.length} exercises</h2>
            <p className="small muted" style={{ marginBottom: 10, maxWidth: '62ch' }}>
              By default each exercise keeps your name and becomes one of your own. Where the library has the same exercise, you can use it instead; library exercises come with instructions and muscles.
            </p>
            <ul className="rows">
              {p.exercises.map((x) => (
                <li className="row import-row" key={x.key}>
                  <div className="main">
                    <div className="name">{x.name}</div>
                    <div className="meta">
                      {x.weights.length ? `${x.weights.join(' kg, ')} kg` : 'No weight'}
                      {x.equipment.length ? `; ${x.equipment.join(', ')}` : ''}
                    </div>
                  </div>
                  <select
                    className="input"
                    aria-label={`Use for ${x.name}`}
                    value={choiceValue(choices[x.key] ?? x.defaultChoice)}
                    onChange={(e) => setChoices({ ...choices, [x.key]: parseChoice(e.target.value) })}
                  >
                    {x.existing && <option value={`existing:${x.existing.id}`}>Your exercise: {x.existing.name}</option>}
                    <option value="custom">{x.existing ? 'A new exercise of your own' : 'Your own exercise'}</option>
                    {x.suggestions.map((s) => <option key={s.id} value={`library:${s.id}`}>Library: {s.name}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </section>

          <FormError error={doImport.error} />
          <div className="import-footer">
            <button
              className="btn btn-primary"
              type="button"
              disabled={doImport.isPending}
              onClick={() =>
                doImport.mutate(
                  { data, choices },
                  {
                    onSuccess: (r) => {
                      toast(`Imported ${r.workouts.length} workout${r.workouts.length === 1 ? '' : 's'}`);
                      navigate('/workouts');
                    },
                  },
                )
              }
            >
              {doImport.isPending ? 'Importing…' : `Import ${p.workouts.length} workout${p.workouts.length === 1 ? '' : 's'}`}
            </button>
            <span className="small muted">{ownCount ? `Adds ${ownCount} exercise${ownCount === 1 ? '' : 's'} of your own.` : ''}</span>
          </div>
        </>
      )}
    </main>
  );
}

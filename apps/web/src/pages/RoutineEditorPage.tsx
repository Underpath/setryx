import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { type Routine, type RoutineMode, WEEKDAYS, routineInputSchema, weekOrder } from '@setryx/shared';
import { type BlockedNav, useAllowNextNavigation, useBackHandler } from '../components/backGuard.tsx';
import { MODE_LABEL, RoutineStrip, useRoutineStatuses } from '../components/routines.tsx';
import { move, useSortable } from '../components/sortable.ts';
import { FormError, Icon, LeaveDialog, Sheet, Switch, useBeforeUnload, useToast } from '../components/ui.tsx';
import { useDeleteRoutine, useRestartRoutine, useRoutine, useSaveRoutine, useWorkouts } from '../data.ts';
import { useMe } from '../session.ts';
import { uid } from '../util.ts';

type Entry = { id: string; workoutId: string; weekday: number | null };
type Draft = { name: string; mode: RoutineMode; active: boolean; entries: Entry[] };
const EMPTY: Draft = { name: '', mode: 'repeat', active: true, entries: [] };

const MODE_HELP: Record<RoutineMode, string> = {
  repeat: 'Go through the workouts in order, then start over. Up next is the one after your last.',
  once: 'Go through the workouts in order, once. The routine is complete after the last one.',
  weekly: 'Give each workout a day of the week. Today shows that day’s workout and any you missed this week.',
};

const draftOf = (r: Routine): Draft => ({ name: r.name, mode: r.mode, active: r.active, entries: r.entries.map((e) => ({ id: e.id, workoutId: e.workoutId, weekday: e.weekday })) });

export function RoutineEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const loaded = useRoutine(id);
  const workouts = useWorkouts();
  const save = useSaveRoutine();
  const del = useDeleteRoutine();
  const restart = useRestartRoutine();
  const statuses = useRoutineStatuses(me.data!.id);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saved, setSaved] = useState(JSON.stringify(EMPTY));
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ weekday: number | null } | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'restart' | null>(null);
  const initialised = useRef(false);
  const allowNext = useAllowNextNavigation();
  const [leaving, setLeaving] = useState<BlockedNav | null>(null);

  useEffect(() => {
    if (!loaded.data || initialised.current) return;
    const d = draftOf(loaded.data);
    setDraft(d);
    setSaved(JSON.stringify(d));
    initialised.current = true;
  }, [loaded.data]);

  const dirty = JSON.stringify(draft) !== saved;
  useBeforeUnload(dirty);
  useBackHandler(dirty, (nav) => setLeaving(nav));

  // Names come from the workouts list, or from the saved routine for deleted ones.
  const names = useMemo(() => {
    const m = new Map<string, { name: string; icon: string }>();
    for (const e of loaded.data?.entries ?? []) if (e.workoutName) m.set(e.workoutId, { name: e.workoutName, icon: e.icon });
    for (const w of workouts.data ?? []) m.set(w.id, { name: w.name, icon: w.icon });
    return m;
  }, [workouts.data, loaded.data]);
  const label = (e: Entry) => names.get(e.workoutId);

  const setEntries = (fn: (entries: Entry[]) => Entry[]) => setDraft((d) => ({ ...d, entries: fn(d.entries) }));
  const sort = useSortable((from, to) => setEntries((list) => move(list, from, to)));

  const setMode = (mode: RoutineMode) =>
    setDraft((d) => ({
      ...d,
      mode,
      // Leaving weekly keeps the week's order: Monday first.
      entries: d.mode === 'weekly' && mode !== 'weekly' ? [...d.entries].sort((a, b) => (a.weekday ?? 9) - (b.weekday ?? 9)) : d.entries,
    }));

  // Picked in the order tapped, added in that order.
  const [picked, setPicked] = useState<string[]>([]);
  const openPicker = (weekday: number | null) => (setPicked([]), setPicker({ weekday }));
  const togglePick = (workoutId: string) => setPicked((p) => (p.includes(workoutId) ? p.filter((x) => x !== workoutId) : [...p, workoutId]));
  const addPicked = () => {
    setEntries((list) => [...list, ...picked.map((workoutId) => ({ id: uid(), workoutId, weekday: picker?.weekday ?? null }))]);
    setPicker(null);
  };

  const doSave = (then?: () => void) => {
    const input = { ...draft, entries: draft.entries.map((e) => ({ ...e, weekday: draft.mode === 'weekly' ? e.weekday : null })) };
    const parsed = routineInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Something needs fixing.');
      if (leaving) (leaving.reset(), setLeaving(null));
      return;
    }
    setError(null);
    save.mutate(
      { id, input },
      {
        onSuccess: ({ routine }) => {
          const d = draftOf(routine);
          setDraft(d);
          setSaved(JSON.stringify(d));
          toast('Routine saved');
          if (then) then();
          else if (isNew) {
            allowNext();
            navigate(`/routines/${routine.id}`, { replace: true });
          }
        },
        onError: (err) => {
          setError(err.message);
          if (leaving) (leaving.reset(), setLeaving(null));
        },
      },
    );
  };

  if (id && loaded.isPending) return <div className="center-load">Loading routine…</div>;
  if (id && loaded.isError) {
    return (
      <main className="editor">
        <FormError error={loaded.error} />
        <Link className="btn btn-quiet" to="/routines">Back to routines</Link>
      </main>
    );
  }

  const current = statuses.list.find((s) => s.routine.id === id);
  const unscheduled = draft.entries.filter((e) => e.weekday == null);

  const entryRow = (e: Entry, i: number | null) => {
    const l = label(e);
    return (
      <li key={e.id} className="r-entry" data-sort-key={i != null ? e.id : undefined}>
        {i != null && <span className="grip" aria-hidden {...sort.handle(i)}><Icon name="grip" /></span>}
        {i != null && <span className="r-pos">{i + 1}</span>}
        <span className={`r-name${l ? '' : ' gone'}`}>
          {l?.icon && <span aria-hidden>{l.icon} </span>}
          {l?.name ?? 'Deleted workout'}
        </span>
        {draft.mode === 'weekly' && e.weekday == null && (
          <select className="input r-day" aria-label="Day" value="" onChange={(ev) => setEntries((list) => list.map((x) => (x.id === e.id ? { ...x, weekday: Number(ev.target.value) } : x)))}>
            <option value="" disabled>Pick a day</option>
            {weekOrder(me.data!.settings.weekStart).map((k) => <option key={k} value={k}>{WEEKDAYS[k]}</option>)}
          </select>
        )}
        <button className="icon-btn" type="button" aria-label={`Remove ${l?.name ?? 'workout'}`} onClick={() => setEntries((list) => list.filter((x) => x.id !== e.id))}>
          <Icon name="close" />
        </button>
      </li>
    );
  };

  return (
    <main className="editor">
      <header className="topbar editor-bar">
        <button className="icon-btn" type="button" aria-label="Back to routines" onClick={() => navigate('/routines')}><Icon name="back" /></button>
        <h1 className="h2">
          {draft.name || (isNew ? 'New routine' : 'Routine')}
          {dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
        </h1>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => doSave()} disabled={save.isPending || (!dirty && !isNew)}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="editor-head">
        <div className="field">
          <label htmlFor="r-name">Routine name</label>
          <input id="r-name" className="input" value={draft.name} placeholder="Push Pull" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="field">
          <span className="label">Schedule</span>
          <div className="seg" role="radiogroup" aria-label="Schedule">
            {(['repeat', 'once', 'weekly'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={draft.mode === m} className={draft.mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 6 }}>{MODE_HELP[draft.mode]}</p>
        </div>
      </div>

      <FormError error={error ? new Error(error) : null} />

      {draft.mode === 'weekly' ? (
        <section className="section">
          <h2 className="h3">Week</h2>
          <ul className="week-plan">
            {weekOrder(me.data!.settings.weekStart).map((k) => {
              const day = WEEKDAYS[k]!;
              const list = draft.entries.filter((e) => e.weekday === k);
              return (
                <li key={day} className={list.length ? '' : 'free'}>
                  <span className="wp-day">{day}</span>
                  <span className="wp-list">
                    {list.map((e) => {
                      const l = label(e);
                      return (
                        <span key={e.id} className={`wp-chip${l ? '' : ' gone'}`}>
                          {l?.icon && <span aria-hidden>{l.icon}</span>}
                          {l?.name ?? 'Deleted workout'}
                          <button type="button" aria-label={`Remove ${l?.name ?? 'workout'} from ${day}`} onClick={() => setEntries((all) => all.filter((x) => x.id !== e.id))}>×</button>
                        </span>
                      );
                    })}
                    <button className="wp-add" type="button" onClick={() => openPicker(k)} aria-label={`Add a workout on ${day}`}>
                      {list.length ? '+' : '+ Add'}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {unscheduled.length > 0 && (
            <>
              <h3 className="h3" style={{ marginTop: 18 }}>Needs a day</h3>
              <ul className="r-entries">{unscheduled.map((e) => entryRow(e, null))}</ul>
            </>
          )}
        </section>
      ) : (
        <section className="section">
          <div className="section-head">
            <h2 className="h3">Order</h2>
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => openPicker(null)}>Add workouts</button>
          </div>
          {draft.entries.length === 0 ? (
            <p className="muted">Add the workouts in the order you do them. The same workout can appear more than once.</p>
          ) : (
            <ol className="r-entries" ref={(el) => void (sort.ref.current = el)}>
              {draft.entries.map((e, i) => entryRow(e, i))}
            </ol>
          )}
        </section>
      )}

      {!isNew && current && (
        <section className="section">
          <h2 className="h3">Progress</h2>
          {dirty ? <p className="small muted">Save to see progress with these changes.</p> : <RoutineStrip {...current} />}
          <div style={{ marginTop: 14 }}>
            <Switch label="Active" hint="Paused routines don’t show on Today." checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} />
          </div>
          <div className="split-actions">
            <button className="btn btn-sm" type="button" onClick={() => setConfirm('restart')} disabled={dirty}>Start from the beginning</button>
            <button className="btn btn-danger btn-sm" type="button" onClick={() => setConfirm('delete')}>Delete routine</button>
          </div>
        </section>
      )}

      {picker && (
        <Sheet title={picker.weekday != null ? `Add workouts on ${WEEKDAYS[picker.weekday]}` : 'Add workouts'} onClose={() => setPicker(null)}>
          {workouts.data?.length ? (
            <>
              <p className="small muted">Tap the workouts to add, in the order you want them.</p>
              <ul className="rows pick-list">
                {workouts.data.map((w) => {
                  const n = picked.indexOf(w.id);
                  return (
                    <li key={w.id}>
                      <button className={`row row-button${n >= 0 ? ' picked' : ''}`} type="button" aria-pressed={n >= 0} onClick={() => togglePick(w.id)}>
                        <span className="pick-mark" aria-hidden>{n >= 0 ? n + 1 : ''}</span>
                        <span className="emoji" aria-hidden>{w.icon || '•'}</span>
                        <span className="main"><span className="name">{w.name}</span></span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button className="btn btn-primary btn-block" type="button" disabled={!picked.length} onClick={addPicked}>
                {picked.length ? `Add ${picked.length} workout${picked.length === 1 ? '' : 's'}` : 'Pick workouts to add'}
              </button>
            </>
          ) : (
            <p className="muted">You don’t have any workouts yet. Create one first.</p>
          )}
        </Sheet>
      )}

      {confirm === 'restart' && (
        <Sheet title="Start from the beginning?" onClose={() => setConfirm(null)}>
          <p className="muted">Up next goes back to the first workout. Your past sessions stay in your history.</p>
          <button className="btn btn-primary btn-block" type="button" disabled={restart.isPending} onClick={() => restart.mutate(id!, { onSuccess: () => (toast('Routine restarted'), setConfirm(null)) })}>
            Start from the beginning
          </button>
          <button className="btn btn-block" type="button" onClick={() => setConfirm(null)}>Cancel</button>
        </Sheet>
      )}
      {confirm === 'delete' && (
        <Sheet title="Delete this routine?" onClose={() => setConfirm(null)}>
          <p className="muted">The workouts in it and your past sessions stay. Only the routine goes.</p>
          <button
            className="btn btn-primary btn-block"
            type="button"
            disabled={del.isPending}
            onClick={() => del.mutate(id!, { onSuccess: () => (toast('Routine deleted'), allowNext(), navigate('/routines')) })}
          >
            Delete routine
          </button>
          <button className="btn btn-block" type="button" onClick={() => setConfirm(null)}>Keep it</button>
        </Sheet>
      )}

      {leaving && (
        <LeaveDialog
          message={`You have unsaved changes to ${draft.name || 'this routine'}. If you leave now without saving, those changes are lost.`}
          saveLabel="Save routine"
          saving={save.isPending}
          onSave={() => doSave(() => (leaving.proceed(), setLeaving(null)))}
          onDiscard={() => (leaving.proceed(), setLeaving(null))}
          onKeep={() => (leaving.reset(), setLeaving(null))}
        />
      )}
    </main>
  );
}

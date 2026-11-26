import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Outlet, useNavigate, useParams } from 'react-router';
import { type BackupFile, type BackupSettings, type PublicUser, type UpdateMeRequest, type UserSettings, WEEKDAYS } from '@setryx/shared';
import { api } from '../api.ts';
import { useLogout, useMe, useSetMe } from '../session.ts';
import { Field, FormError, Icon, Sheet, Switch, fieldErrors, useToast } from '../components/ui.tsx';
import { useMediaQuery } from '../util.ts';
import { InvitesSection, UsersSection } from './AdminPage.tsx';
import { ApiTokensSection } from './ApiTokensSection.tsx';

type SectionId = 'account' | 'workouts' | 'general' | 'data' | 'api' | 'people' | 'photos' | 'backups';
const SECTIONS: { id: SectionId; label: string; hint: string; admin?: boolean }[] = [
  { id: 'account', label: 'Account', hint: 'Name and password' },
  { id: 'workouts', label: 'During workouts', hint: 'Tapping, screen, sounds, warning' },
  { id: 'general', label: 'General', hint: 'Theme and start of the week' },
  { id: 'data', label: 'Import and export', hint: 'Bring workouts in, take everything out' },
  { id: 'api', label: 'API and AI agents', hint: 'Tokens, MCP' },
  { id: 'people', label: 'People and invites', hint: 'Accounts on this server', admin: true },
  { id: 'photos', label: 'Exercise photos', hint: 'Allow, download or remove', admin: true },
  { id: 'backups', label: 'Backups', hint: 'Database copies for your volume backups', admin: true },
];
const WIDE = '(min-width: 760px)';

/** Saves one setting at a time, showing the change straight away. */
export function useSetSetting(user: PublicUser) {
  const setMe = useSetMe();
  const toast = useToast();
  const update = useMutation({
    mutationFn: (body: UpdateMeRequest) => api.patch<{ user: PublicUser }>('/me', body),
    onSuccess: ({ user }) => setMe(user),
    onError: (err) => toast(err.message),
  });
  return <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setMe({ ...user, settings: { ...user.settings, [key]: value } }); // optimistic
    update.mutate({ settings: { [key]: value } });
  };
}

/** /settings: vertical tabs beside the open section; on phones, the list first, then one section at a time. */
export function SettingsLayout() {
  const me = useMe();
  const user = me.data!;
  const { section } = useParams();
  const wide = useMediaQuery(WIDE);
  const navigate = useNavigate();
  const logout = useLogout();
  const sections = SECTIONS.filter((x) => !x.admin || user.role === 'admin');
  const current = sections.find((x) => x.id === section);

  if (section && !current) return <Navigate to="/settings" replace />;
  if (wide && !section) return <Navigate to="/settings/account" replace />;

  const showList = wide || !section;
  return (
    <main className={`settings${section ? ' has-section' : ''}`}>
      <header className="topbar editor-bar">
        <button
          className="icon-btn"
          type="button"
          aria-label={!wide && section ? 'Back to settings' : 'Close settings'}
          onClick={() => navigate(!wide && section ? '/settings' : '/')}
        >
          <Icon name="back" />
        </button>
        <h1 className="h2">{!wide && current ? current.label : 'Settings'}</h1>
      </header>
      <div className="settings-body">
        {showList && (
          <nav className="settings-tabs" aria-label="Settings sections">
            {sections.map((x) => (
              <NavLink key={x.id} to={`/settings/${x.id}`} className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
                <span className="name">{x.label}</span>
                <span className="meta">{x.hint}</span>
              </NavLink>
            ))}
            <button className="settings-tab signout" type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
              <span className="name">Sign out</span>
              <span className="meta">Signed in as {user.username}</span>
            </button>
          </nav>
        )}
        {section && (
          <div className="settings-pane">
            {wide && current && <h2 className="h2 settings-title">{current.label}</h2>}
            <Outlet />
          </div>
        )}
      </div>
    </main>
  );
}

export function SettingsSection() {
  const { section } = useParams();
  const me = useMe();
  const user = me.data!;
  switch (section as SectionId) {
    case 'account':
      return <AccountSection user={user} />;
    case 'workouts':
      return <WorkoutPrefs user={user} />;
    case 'general':
      return <GeneralPrefs user={user} />;
    case 'data':
      return <DataSection />;
    case 'api':
      return <ApiTokensSection user={user} />;
    case 'people':
      return user.role === 'admin' ? (
        <>
          <UsersSection me={user} />
          <InvitesSection />
        </>
      ) : null;
    case 'photos':
      return user.role === 'admin' ? <PhotosSection /> : null;
    case 'backups':
      return user.role === 'admin' ? <BackupsSection /> : null;
    default:
      return null;
  }
}

type BackupState = { settings: BackupSettings; defaultDir: string; files: BackupFile[] };
const EVERY: { v: BackupSettings['latestEveryMinutes']; label: string }[] = [
  { v: 0, label: 'Off' },
  { v: 5, label: 'Every 5 minutes' },
  { v: 15, label: 'Every 15 minutes' },
  { v: 60, label: 'Every hour' },
  { v: 360, label: 'Every 6 hours' },
  { v: 1440, label: 'Once a day' },
];
const fileLabel = (f: BackupFile) =>
  f.kind === 'latest' ? 'Up-to-date copy' : f.kind === 'manual' ? 'Made by hand' : `Before the update to database version ${f.name.match(/-v(\d+)-/)?.[1] ?? '?'}`;
const whenFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Admin: where database copies go, how many to keep, and the copies themselves. */
function BackupsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const state = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => api.get<BackupState>('/admin/backups') });
  const [draft, setDraft] = useState<BackupSettings | null>(null);
  const settings = draft ?? state.data?.settings ?? null;
  const save = useMutation({
    mutationFn: (s: BackupSettings) => api.put<BackupState>('/admin/backups', s),
    onSuccess: (d) => (qc.setQueryData(['admin', 'backups'], d), setDraft(null), toast('Backup settings saved')),
  });
  const now = useMutation({
    mutationFn: () => api.post<BackupState>('/admin/backups/now'),
    onSuccess: (d) => (qc.setQueryData(['admin', 'backups'], d), toast('Copy made')),
    onError: (e) => toast(e.message),
  });
  if (!state.data || !settings) return <FormError error={state.error} />;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(state.data.settings);
  const edit = (patch: Partial<BackupSettings>) => setDraft({ ...settings, ...patch });
  const { fields, general } = fieldErrors(save.error);
  return (
    <>
      <p className="muted small" style={{ maxWidth: '62ch', marginBottom: 6 }}>
        setryx keeps complete copies of its database here for your own volume backups to pick up. Every copy is written in one go, so it’s always safe to copy. Exercise
        photos aren’t included; they can be downloaded again.
      </p>
      <ul className="rows">
        <li className="row backup-field">
          <div className="main">
            <label className="name" htmlFor="b-dir">Folder</label>
            <div className="meta">A path inside the container. To keep copies somewhere else, mount another volume and enter its path. Default: {state.data.defaultDir}</div>
            <input id="b-dir" className="input" value={settings.dir} onChange={(e) => edit({ dir: e.target.value })} aria-invalid={fields.dir ? true : undefined} spellCheck={false} />
            {fields.dir && <div className="field-error">{fields.dir}</div>}
          </div>
        </li>
        <li className="row">
          <div className="main">
            <div className="name">Copies before updates</div>
            <div className="meta">Taken just before a new version changes the database. Also how many copies made by hand are kept.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="icon-btn btn-quiet" type="button" aria-label="Keep fewer" disabled={settings.keep <= 1} onClick={() => edit({ keep: settings.keep - 1 })}>−</button>
            <b className="h3" style={{ minWidth: '2ch', textAlign: 'center' }} aria-live="polite">{settings.keep}</b>
            <button className="icon-btn btn-quiet" type="button" aria-label="Keep more" disabled={settings.keep >= 50} onClick={() => edit({ keep: settings.keep + 1 })}>+</button>
          </div>
        </li>
        <li className="row">
          <div className="main">
            <label className="name" htmlFor="b-every">Up-to-date copy</label>
            <div className="meta">setryx-latest.db, refreshed this often when something changed, and when the server stops.</div>
          </div>
          <select id="b-every" className="input select-sm" value={settings.latestEveryMinutes} onChange={(e) => edit({ latestEveryMinutes: Number(e.target.value) as BackupSettings['latestEveryMinutes'] })}>
            {EVERY.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </li>
      </ul>
      <FormError error={general} />
      {dirty && (
        <div className="sheet-actions" style={{ marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" type="button" disabled={save.isPending} onClick={() => save.mutate(draft!)}>Save backup settings</button>
          <button className="btn btn-sm" type="button" onClick={() => (setDraft(null), save.reset())}>Cancel</button>
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <h3 className="h3">Copies</h3>
          <button className="btn btn-strong btn-sm" type="button" disabled={now.isPending || dirty} title={dirty ? 'Save the settings first' : undefined} onClick={() => now.mutate()}>Make a copy now</button>
        </div>
        {state.data.files.length === 0 ? (
          <p className="muted small">No copies in {state.data.settings.dir} yet.</p>
        ) : (
          <ul className="rows">
            {state.data.files.map((f) => (
              <li className="row" key={f.name}>
                <div className="main">
                  <div className="name">{fileLabel(f)}</div>
                  <div className="meta">{f.name}, {mb(f.bytes)}</div>
                </div>
                <span className="meta when">{whenFmt.format(new Date(f.modifiedAt))}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="small muted" style={{ marginTop: 10, maxWidth: '62ch' }}>
          To restore one: stop the container, replace setryx.db in the data folder with the copy (renamed to setryx.db), then start it again.
        </p>
      </section>
    </>
  );
}

type ImagesStatus = {
  allowed: boolean;
  total: number;
  downloaded: number;
  bytes: number;
  estimatedTotalBytes: number;
  job: { running: boolean; total: number; done: number; failed: number; finishedAt: string | null };
};

const mb = (bytes: number) => {
  const v = bytes / 1_000_000;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} MB`;
};

/** Admin: whether exercise photos are allowed, and downloading or removing them. */
function PhotosSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = useQuery({
    queryKey: ['admin', 'images'],
    queryFn: () => api.get<ImagesStatus>('/admin/exercise-images'),
    refetchInterval: (q) => (q.state.data?.job.running ? 1000 : false),
  });
  const set = (data: ImagesStatus) => qc.setQueryData(['admin', 'images'], data);
  const allow = useMutation({ mutationFn: (allowed: boolean) => api.patch<ImagesStatus>('/admin/exercise-images', { allowed }), onSuccess: set, onError: (e) => toast(e.message) });
  const download = useMutation({ mutationFn: () => api.post<ImagesStatus>('/admin/exercise-images/download'), onSuccess: set, onError: (e) => toast(e.message) });
  const remove = useMutation({
    mutationFn: () => api.del<ImagesStatus>('/admin/exercise-images'),
    onSuccess: (d) => (set(d), setConfirmRemove(false), toast('Downloaded photos removed')),
    onError: (e) => toast(e.message),
  });
  const s = status.data;
  if (!s) return <FormError error={status.error} />;
  const job = s.job;
  const all = s.downloaded >= s.total;
  return (
    <>
      <ul className="rows">
        <li className="row">
          <Switch
            label="Allow exercise photos"
            hint={`Start and end photos for library exercises, from the free-exercise-db project on GitHub (public domain). When allowed, each photo downloads the first time someone opens that exercise and then stays on this server. All ${s.total.toLocaleString()} photos come to about ${mb(s.estimatedTotalBytes)}.`}
            checked={s.allowed}
            onChange={(v) => allow.mutate(v)}
          />
        </li>
        {!s.allowed && (
          <li className="row">
            <div className="main">
              <div className="meta">While this is off, nothing is downloaded and no photos are shown.{s.downloaded > 0 ? ` ${s.downloaded.toLocaleString()} photos (${mb(s.bytes)}) are still stored from before.` : ''}</div>
            </div>
          </li>
        )}
        {s.allowed && (
          <li className="row photos-status">
            <div className="main">
              <div className="name">{all ? 'All photos are on this server' : `${s.downloaded.toLocaleString()} of ${s.total.toLocaleString()} photos on this server`}</div>
              <div className="meta">
                {mb(s.bytes)} used.
                {job.running
                  ? ` Downloading: ${job.done + job.failed} of ${job.total}.`
                  : !all
                    ? ' The rest download as people open exercises, or get them all now.'
                    : ''}
                {!job.running && job.failed > 0 && job.finishedAt ? ` ${job.failed} couldn’t be downloaded; try again later.` : ''}
              </div>
              {job.running && (
                <div className="meter" role="progressbar" aria-label="Downloading photos" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.done + job.failed}>
                  <i style={{ width: `${((job.done + job.failed) / Math.max(1, job.total)) * 100}%` }} />
                </div>
              )}
            </div>
            {!all && !job.running && (
              <button className="btn btn-strong btn-sm" type="button" disabled={download.isPending} onClick={() => download.mutate()}>
                Download all (about {mb(Math.max(0, s.estimatedTotalBytes - s.bytes))})
              </button>
            )}
          </li>
        )}
      </ul>
      {s.downloaded > 0 && (
        <div className="split-actions">
          <span />
          <button className="btn btn-quiet btn-danger btn-sm" type="button" onClick={() => setConfirmRemove(true)}>Remove downloaded photos</button>
        </div>
      )}
      {confirmRemove && (
        <Sheet title="Remove downloaded photos?" onClose={() => setConfirmRemove(false)}>
          <p className="muted">
            Deletes the {s.downloaded.toLocaleString()} photos ({mb(s.bytes)}) stored on this server.
            {s.allowed ? ' While photos are allowed, they download again as people open exercises.' : ''}
          </p>
          <button className="btn btn-primary btn-block" type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove photos</button>
          <button className="btn btn-block" type="button" onClick={() => setConfirmRemove(false)}>Keep them</button>
        </Sheet>
      )}
    </>
  );
}

function AccountSection({ user }: { user: PublicUser }) {
  const [editing, setEditing] = useState<'name' | 'password' | null>(null);
  return (
    <>
      <ul className="rows">
        <li className="row">
          <div className="main"><div className="name">{user.displayName}</div><div className="meta">Signed in as {user.username}{user.role === 'admin' ? ', admin' : ''}</div></div>
          <button className="btn btn-quiet btn-sm" type="button" onClick={() => setEditing('name')}>Change name</button>
        </li>
        <li className="row">
          <div className="main"><div className="name">Password</div><div className="meta">Changing it signs you out on your other devices.</div></div>
          <button className="btn btn-quiet btn-sm" type="button" onClick={() => setEditing('password')}>Change password</button>
        </li>
      </ul>
      {editing === 'name' && <NameSheet user={user} onClose={() => setEditing(null)} />}
      {editing === 'password' && <PasswordSheet onClose={() => setEditing(null)} />}
    </>
  );
}

function WorkoutPrefs({ user }: { user: PublicUser }) {
  const setSetting = useSetSetting(user);
  const s = user.settings;
  return (
    <ul className="rows">
      <li className="row"><Switch label="Tap the screen to log a set" hint="When off, only the Log set button logs a set. Stops accidental taps from a towel or knee." checked={s.tapToLog} onChange={(v) => setSetting('tapToLog', v)} /></li>
      {s.tapToLog && (
        <li className="row"><Switch label="Show the “Tap anywhere” hint" hint="The line and circle under the weight that remind you the screen logs the set." checked={s.showTapHint} onChange={(v) => setSetting('showTapHint', v)} /></li>
      )}
      <li className="row"><Switch label="Keep the screen on" hint="During workouts only." checked={s.keepAwake} onChange={(v) => setSetting('keepAwake', v)} /></li>
      <li className="row"><Switch label="Spoken cues" hint="Says what’s next before each rest ends." checked={s.voice} onChange={(v) => setSetting('voice', v)} /></li>
      <li className="row"><Switch label="Sounds" hint="Chimes at the end of timers and the countdown." checked={s.sounds} onChange={(v) => setSetting('sounds', v)} /></li>
      <li className="row">
        <div className="main"><div className="name">Warning before a timer ends</div><div className="meta">When the screen turns purple.</div></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="icon-btn btn-quiet" type="button" aria-label="Fewer seconds" disabled={s.warnSeconds <= 0} onClick={() => setSetting('warnSeconds', Math.max(0, s.warnSeconds - 5))}>−</button>
          <b className="h3" style={{ minWidth: '3ch', textAlign: 'center' }} aria-live="polite">{s.warnSeconds} s</b>
          <button className="icon-btn btn-quiet" type="button" aria-label="More seconds" disabled={s.warnSeconds >= 60} onClick={() => setSetting('warnSeconds', Math.min(60, s.warnSeconds + 5))}>+</button>
        </div>
      </li>
    </ul>
  );
}

function GeneralPrefs({ user }: { user: PublicUser }) {
  const setSetting = useSetSetting(user);
  const s = user.settings;
  return (
    <ul className="rows">
      <li className="row">
        <div className="main"><label className="name" htmlFor="theme">Theme</label></div>
        <select id="theme" className="input select-sm" value={s.theme} onChange={(e) => setSetting('theme', e.target.value as UserSettings['theme'])}>
          <option value="system">Match this device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </li>
      <li className="row">
        <div className="main">
          <label className="name" htmlFor="week-start">Week starts on</label>
          <div className="meta">For weekly routines: which days count as this week, and the order they’re shown in.</div>
        </div>
        <select id="week-start" className="input select-sm" value={s.weekStart} onChange={(e) => setSetting('weekStart', Number(e.target.value))}>
          {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      </li>
    </ul>
  );
}

function DataSection() {
  return (
    <ul className="rows">
      <li className="row">
        <div className="main"><div className="name">Import routines</div><div className="meta">From a JSON export of your earlier tracker. Each routine becomes a workout.</div></div>
        <Link className="btn btn-quiet btn-sm" to="/workouts/import">Import</Link>
      </li>
      <li className="row">
        <div className="main"><div className="name">Export everything</div><div className="meta">Your workouts, routines and your own exercises, as a JSON file.</div></div>
        <a className="btn btn-quiet btn-sm" href="/api/v1/export" download>Export</a>
      </li>
    </ul>
  );
}

function NameSheet({ user, onClose }: { user: PublicUser; onClose: () => void }) {
  const setMe = useSetMe();
  const toast = useToast();
  const m = useMutation({
    mutationFn: (displayName: string) => api.patch<{ user: PublicUser }>('/me', { displayName }),
    onSuccess: ({ user }) => {
      setMe(user);
      toast('Name changed');
      onClose();
    },
  });
  const { fields, general } = fieldErrors(m.error);
  return (
    <Sheet title="Change name" onClose={onClose}>
      <form className="form" onSubmit={(e: FormEvent<HTMLFormElement>) => (e.preventDefault(), m.mutate(String(new FormData(e.currentTarget).get('displayName'))))}>
        <Field label="Your name" name="displayName" defaultValue={user.displayName} autoComplete="name" error={fields.displayName} />
        <FormError error={general} />
        <button className="btn btn-primary btn-block" type="submit" disabled={m.isPending}>Save name</button>
      </form>
    </Sheet>
  );
}

function PasswordSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const m = useMutation({
    mutationFn: (body: Record<string, string>) => api.post('/me/password', body),
    onSuccess: () => {
      toast('Password changed');
      onClose();
    },
  });
  const { fields, general } = fieldErrors(m.error);
  return (
    <Sheet title="Change password" onClose={onClose}>
      <form className="form" onSubmit={(e: FormEvent<HTMLFormElement>) => (e.preventDefault(), m.mutate(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>))}>
        <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" error={fields.currentPassword} />
        <Field label="New password" name="newPassword" type="password" autoComplete="new-password" error={fields.newPassword} hint="At least 10 characters." />
        <FormError error={general} />
        <button className="btn btn-primary btn-block" type="submit" disabled={m.isPending}>Change password</button>
      </form>
    </Sheet>
  );
}

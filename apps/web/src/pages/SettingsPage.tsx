import { type FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Outlet, useNavigate, useParams } from 'react-router';
import { type PublicUser, type UpdateMeRequest, type UserSettings, WEEKDAYS } from '@setryx/shared';
import { api } from '../api.ts';
import { useLogout, useMe, useSetMe } from '../session.ts';
import { Field, FormError, Icon, Sheet, Switch, fieldErrors, useToast } from '../components/ui.tsx';
import { useMediaQuery } from '../util.ts';
import { InvitesSection, UsersSection } from './AdminPage.tsx';

type SectionId = 'account' | 'workouts' | 'general' | 'data' | 'people';
const SECTIONS: { id: SectionId; label: string; hint: string; admin?: boolean }[] = [
  { id: 'account', label: 'Account', hint: 'Name and password' },
  { id: 'workouts', label: 'During workouts', hint: 'Tapping, screen, sounds, warning' },
  { id: 'general', label: 'General', hint: 'Theme and start of the week' },
  { id: 'data', label: 'Import and export', hint: 'Bring workouts in, take everything out' },
  { id: 'people', label: 'People and invites', hint: 'Accounts on this server', admin: true },
];
const WIDE = '(min-width: 760px)';

/** Saves one setting at a time, showing the change straight away. */
function useSetSetting(user: PublicUser) {
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
    case 'people':
      return user.role === 'admin' ? (
        <>
          <UsersSection me={user} />
          <InvitesSection />
        </>
      ) : null;
    default:
      return null;
  }
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

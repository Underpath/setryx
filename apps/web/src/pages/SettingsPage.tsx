import { type FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { PublicUser, UpdateMeRequest, UserSettings } from '@setryx/shared';
import { api } from '../api.ts';
import { useSetMe } from '../session.ts';
import { TopBar } from '../components/Shell.tsx';
import { Field, FormError, Sheet, Switch, fieldErrors, useToast } from '../components/ui.tsx';

export function SettingsPage({ user }: { user: PublicUser }) {
  const setMe = useSetMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [editing, setEditing] = useState<'name' | 'password' | null>(null);

  const update = useMutation({
    mutationFn: (body: UpdateMeRequest) => api.patch<{ user: PublicUser }>('/me', body),
    onSuccess: ({ user }) => setMe(user),
    onError: (err) => toast(err.message),
  });
  const setSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setMe({ ...user, settings: { ...user.settings, [key]: value } }); // optimistic
    update.mutate({ settings: { [key]: value } });
  };

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      qc.clear();
      setMe(null);
      navigate('/login', { replace: true });
    },
  });

  const s = user.settings;
  return (
    <>
      <TopBar title="Settings" back="/" />

      <section className="section">
        <h2 className="h3">Account</h2>
        <ul className="rows">
          <li className="row">
            <div className="main"><div className="name">{user.displayName}</div><div className="meta">Signed in as {user.username}{user.role === 'admin' ? ', admin' : ''}</div></div>
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => setEditing('name')}>Change name</button>
          </li>
          <li className="row">
            <div className="main"><div className="name">Password</div><div className="meta">Changing it signs you out on your other devices.</div></div>
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => setEditing('password')}>Change password</button>
          </li>
          {user.role === 'admin' && (
            <li className="row">
              <div className="main"><div className="name">People and invites</div><div className="meta">Add people, send invite links, reset passwords.</div></div>
              <Link className="btn btn-quiet btn-sm" to="/settings/admin">Manage</Link>
            </li>
          )}
        </ul>
      </section>

      <section className="section">
        <h2 className="h3">During workouts</h2>
        <ul className="rows">
          <li className="row"><Switch label="Tap the screen to log a set" hint="When off, only the Log set button logs a set. Stops accidental taps from a towel or knee." checked={s.tapToLog} onChange={(v) => setSetting('tapToLog', v)} /></li>
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
      </section>

      <section className="section">
        <h2 className="h3">Appearance</h2>
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="theme">Theme</label>
          <select id="theme" className="input" value={s.theme} onChange={(e) => setSetting('theme', e.target.value as UserSettings['theme'])}>
            <option value="system">Match this device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>

      <section className="section">
        <button className="btn btn-quiet" type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>Sign out</button>
      </section>

      {editing === 'name' && <NameSheet user={user} onClose={() => setEditing(null)} />}
      {editing === 'password' && <PasswordSheet onClose={() => setEditing(null)} />}
    </>
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

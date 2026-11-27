import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminUpdateUserRequest, AppSettings, Invite, PublicUser, SignInAlert } from '@setryx/shared';
import { Link } from 'react-router';
import { ago } from '../util.ts';
import { api } from '../api.ts';
import { useSetMe } from '../session.ts';
import { Field, FormError, Icon, Sheet, Switch, fieldErrors, useNewPassword, useToast } from '../components/ui.tsx';

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const formData = (e: FormEvent<HTMLFormElement>) => (e.preventDefault(), Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);

// ── Password guessing ──
/** Admins: accounts somebody keeps guessing passwords for. Checks every minute. */
export function SignInAlerts({ linkToPeople = false }: { linkToPeople?: boolean }) {
  const alerts = useQuery({
    queryKey: ['admin', 'sign-in-alerts'],
    queryFn: () => api.get<{ alerts: SignInAlert[] }>('/admin/sign-in-alerts'),
    refetchInterval: 60_000,
  });
  return (
    <>
      {alerts.data?.alerts.map((a) => (
        <div className="notice" role="status" key={a.userId}>
          <p>
            <strong>Someone is guessing the password for {a.displayName} ({a.username})</strong>
            It started {ago(a.since)}; {a.refused === 1 ? 'one try has' : `${a.refused} tries have`} been turned away. Devices that have signed in to this
            account before can still sign in; a new device has to wait until the guessing stops. A strong password keeps the account safe meanwhile.
          </p>
          {linkToPeople && <Link className="btn" to="/settings/people">See people</Link>}
        </div>
      ))}
    </>
  );
}

// ── People ──
export function UsersSection({ me }: { me: PublicUser }) {
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.get<{ users: PublicUser[] }>('/admin/users') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PublicUser | null>(null);
  return (
    <section className="section">
      <SignInAlerts />
      <div className="section-head">
        <h2 className="h3">People</h2>
        <button className="btn btn-quiet btn-sm" type="button" onClick={() => setAdding(true)}>Add person</button>
      </div>
      <FormError error={users.error} />
      <ul className="rows">
        {users.data?.users.map((u) => (
          <li className="row" key={u.id}>
            <div className="main">
              <div className="name">{u.displayName}{u.id === me.id ? ' (you)' : ''}</div>
              <div className="meta">{u.username}, joined {dateFmt.format(new Date(u.createdAt))}</div>
            </div>
            {u.role === 'admin' && <span className="tag tag-blue">Admin</span>}
            {u.disabled && <span className="tag tag-off">Turned off</span>}
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => setEditing(u)}>Manage</button>
          </li>
        ))}
      </ul>
      {adding && <AddUserSheet onClose={() => setAdding(false)} />}
      {editing && <ManageUserSheet me={me} user={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function AddUserSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: (body: Record<string, string>) => api.post<{ user: PublicUser }>('/admin/users', { ...body, role: body.role === 'on' ? 'admin' : 'user' }),
    onSuccess: ({ user }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast(`Added ${user.displayName}`);
      onClose();
    },
  });
  const { fields, general } = fieldErrors(m.error);
  const pw = useNewPassword({ name: 'password', label: 'Password', hint: 'At least 10 characters.', error: fields.password });
  return (
    <Sheet title="Add a person" onClose={onClose}>
      <p className="muted small">Give them the username and password yourself. They can change the password after signing in. To let them choose their own, send an invite link instead.</p>
      <form className="form" onSubmit={(e) => { const v = formData(e); if (pw.check()) m.mutate(v); }} noValidate>
        <Field label="Name" name="displayName" error={fields.displayName} />
        <Field label="Username" name="username" autoCapitalize="none" spellCheck={false} error={fields.username} />
        {pw.field}
        <label className="setting"><span className="main"><span className="name">Make them an admin</span><span className="meta">Admins can add and manage people.</span></span><input type="checkbox" role="switch" className="switch" name="role" /></label>
        <FormError error={general} />
        <button className="btn btn-primary btn-block" type="submit" disabled={m.isPending}>Add person</button>
      </form>
    </Sheet>
  );
}

function ManageUserSheet({ me, user, onClose }: { me: PublicUser; user: PublicUser; onClose: () => void }) {
  const qc = useQueryClient();
  const setMe = useSetMe();
  const toast = useToast();
  const [current, setCurrent] = useState(user);
  const update = useMutation({
    mutationFn: (body: AdminUpdateUserRequest) => api.patch<{ user: PublicUser }>(`/admin/users/${user.id}`, body),
    onSuccess: ({ user: updated }) => {
      setCurrent(updated);
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      if (updated.id === me.id) setMe(updated);
    },
  });
  const reset = useMutation({
    mutationFn: (password: string) => api.post(`/admin/users/${user.id}/password`, { password }),
    onSuccess: () => {
      toast(`Password reset for ${user.displayName}`);
      onClose();
    },
  });
  const isMe = user.id === me.id;
  const resetErrors = fieldErrors(reset.error);
  const resetPw = useNewPassword({ name: 'password', label: 'Set a new password', error: resetErrors.fields.password, hint: isMe ? 'At least 10 characters.' : 'At least 10 characters. They’ll be signed out everywhere.' });
  const [confirmOff, setConfirmOff] = useState(false);
  if (confirmOff) {
    return (
      <Sheet title={`Turn off ${current.displayName}’s account?`} onClose={() => setConfirmOff(false)}>
        <p className="muted">They’ll be signed out everywhere and can’t sign in. Their API tokens are deleted for good, so scripts and agents using them stop working, and turning the account back on doesn’t bring them back. Their workouts and history are kept.</p>
        <FormError error={update.error} />
        <button className="btn btn-primary btn-block" type="button" disabled={update.isPending} onClick={() => update.mutate({ disabled: true }, { onSuccess: () => setConfirmOff(false) })}>Turn off account</button>
        <button className="btn btn-block" type="button" onClick={() => setConfirmOff(false)}>Keep it on</button>
      </Sheet>
    );
  }
  return (
    <Sheet title={current.displayName} onClose={onClose}>
      <ul className="rows">
        <li className="row"><Switch label="Admin" hint="Can add and manage people." checked={current.role === 'admin'} onChange={(v) => update.mutate({ role: v ? 'admin' : 'user' })} /></li>
        {!isMe && (
          <li className="row"><Switch label="Account turned on" hint="Turning it off signs them out, stops them signing in and deletes their API tokens. Their data is kept." checked={!current.disabled} onChange={(v) => (v ? update.mutate({ disabled: false }) : setConfirmOff(true))} /></li>
        )}
      </ul>
      <FormError error={update.error} />
      <form className="form" onSubmit={(e) => { const v = formData(e).password ?? ''; if (resetPw.check()) reset.mutate(v); }} noValidate>
        {resetPw.field}
        <FormError error={resetErrors.general} />
        <button className="btn btn-quiet btn-block" type="submit" disabled={reset.isPending}>Reset password</button>
      </form>
    </Sheet>
  );
}

// ── Invites and sign-up ──
export function InvitesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => api.get<{ invites: Invite[] }>('/admin/invites') });
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<AppSettings>('/admin/settings') });
  const [newLink, setNewLink] = useState<{ url: string; fromBaseUrl: boolean } | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ invite: Invite; url: string; fromBaseUrl: boolean }>('/admin/invites', { expiresInDays: 7 }),
    onSuccess: ({ url, fromBaseUrl }) => {
      setNewLink({ url, fromBaseUrl });
      qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
    onError: (err) => toast(err.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/admin/invites/${id}`),
    onSuccess: () => {
      toast('Invite link cancelled');
      qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
  });
  const toggleSignup = useMutation({
    mutationFn: (openSignup: boolean) => api.patch<AppSettings>('/admin/settings', { openSignup }),
    onSuccess: (data) => qc.setQueryData(['admin', 'settings'], data),
  });

  const statusText = (i: Invite) =>
    i.status === 'used' ? `Used by ${i.usedBy}` : i.status === 'expired' ? 'Expired' : `Open until ${dateFmt.format(new Date(i.expiresAt))}`;

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="h3">Invite links</h2>
          <button className="btn btn-quiet btn-sm" type="button" onClick={() => create.mutate()} disabled={create.isPending}>New invite link</button>
        </div>
        <p className="muted small" style={{ marginBottom: 10 }}>Each link creates one account and works for 7 days. Send it however you like; Setryx doesn’t send email.</p>
        <ul className="rows">
          {invites.data?.invites.length === 0 && <li className="row"><span className="muted">No invite links yet.</span></li>}
          {invites.data?.invites.map((i) => (
            <li className="row" key={i.id}>
              <div className="main"><div className="name">Made {dateFmt.format(new Date(i.createdAt))} by {i.createdBy}</div><div className="meta">{statusText(i)}</div></div>
              {i.status === 'open' && (
                <button className="btn btn-danger btn-sm" type="button" onClick={() => revoke.mutate(i.id)}>Cancel link</button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2 className="h3">Sign-up</h2>
        <ul className="rows">
          <li className="row">
            <Switch
              label="Anyone can create an account"
              hint="Anyone who can reach this server gets a Create account link on the sign-in page. Leave off unless the server is private."
              checked={settings.data?.openSignup ?? false}
              onChange={(v) => toggleSignup.mutate(v)}
            />
          </li>
        </ul>
      </section>

      {newLink && <InviteLinkSheet url={newLink.url} fromBaseUrl={newLink.fromBaseUrl} onClose={() => setNewLink(null)} />}
    </>
  );
}

function InviteLinkSheet({ url, fromBaseUrl, onClose }: { url: string; fromBaseUrl: boolean; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      // Clipboard API needs HTTPS on most browsers; fall back to selecting the text.
      (document.getElementById('invite-url') as HTMLInputElement | null)?.select();
      toast('Select the link and copy it');
    }
  };
  return (
    <Sheet title="Invite link ready" onClose={onClose}>
      <p className="muted">Send this link to the person you’re inviting. It’s shown only once, so copy it now.</p>
      <div className="copy-box">
        <input id="invite-url" className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
        <button className="icon-btn btn-quiet" type="button" onClick={copy} aria-label="Copy link"><Icon name="copy" /></button>
      </div>
      {!fromBaseUrl && (
        <p className="small muted">
          The link uses the address you’re on now, <b>{new URL(url).host}</b>. Check it’s the one they should use. To always use your server’s public
          address, set BASE_URL.
        </p>
      )}
      <button className="btn btn-primary btn-block" type="button" onClick={onClose}>Done</button>
    </Sheet>
  );
}

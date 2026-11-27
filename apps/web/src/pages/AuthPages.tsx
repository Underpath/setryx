import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import type { PublicUser } from '@setryx/shared';
import { api } from '../api.ts';
import { useSetMe } from '../session.ts';
import { Field, FormError, fieldErrors, useNewPassword } from '../components/ui.tsx';

function AuthLayout({ tagline, children }: { tagline: string; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-band">
        <div className="wordmark">Setryx</div>
        <p>{tagline}</p>
      </div>
      <main className="auth-body">{children}</main>
    </div>
  );
}

function formValues(e: FormEvent<HTMLFormElement>): Record<string, string> {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
}

// ── First run ──
export function SetupPage() {
  const setMe = useSetMe();
  const navigate = useNavigate();
  const m = useMutation({
    mutationFn: (body: Record<string, string>) => api.post<{ user: PublicUser }>('/setup', body),
    onSuccess: ({ user }) => {
      setMe(user);
      navigate('/', { replace: true });
    },
  });
  const { fields, general } = fieldErrors(m.error);
  const pw = useNewPassword({ name: 'password', label: 'Password', hint: 'At least 10 characters.', error: fields.password, required: true });
  return (
    <AuthLayout tagline="Your workouts, on your own server.">
      <h1 className="h2">Create the admin account</h1>
      <p className="muted">This is the first account on this server, so it becomes the admin. You can add other people afterwards.</p>
      <form className="form" onSubmit={(e) => { const v = formValues(e); if (pw.check()) m.mutate(v); }} noValidate>
        <Field label="Your name" name="displayName" autoComplete="name" required error={fields.displayName} />
        <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required error={fields.username} hint="Letters, numbers, dots, dashes and underscores." />
        {pw.field}
        <FormError error={general} />
        <button className="btn btn-primary btn-block" type="submit" disabled={m.isPending}>
          {m.isPending ? 'Creating account…' : 'Create admin account'}
        </button>
      </form>
    </AuthLayout>
  );
}

// ── Sign in ──
export function LoginPage() {
  const setMe = useSetMe();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['signup-info'], queryFn: () => api.get<{ openSignup: boolean }>('/auth/signup-info') });
  const m = useMutation({
    mutationFn: (body: Record<string, string>) => api.post<{ user: PublicUser }>('/auth/login', body),
    onSuccess: ({ user }) => {
      setMe(user);
      navigate('/', { replace: true });
    },
  });
  return (
    <AuthLayout tagline="Your workouts, on your own server.">
      <h1 className="h2">Sign in</h1>
      <p className="muted">Forgot your password? Ask your admin to reset it.</p>
      <form className="form" onSubmit={(e) => m.mutate(formValues(e))} noValidate>
        <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <FormError error={m.error} />
        <button className="btn btn-primary btn-block" type="submit" disabled={m.isPending}>
          {m.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {info.data?.openSignup && (
        <p className="small" style={{ marginTop: 20 }}>
          New here? <Link to="/signup">Create an account</Link>
        </p>
      )}
    </AuthLayout>
  );
}

// ── Sign up (invite link or open signup) ──
export function SignupPage() {
  const { token } = useParams();
  const setMe = useSetMe();
  const navigate = useNavigate();
  const info = useQuery({
    queryKey: ['signup-info', token],
    queryFn: () => api.get<{ openSignup: boolean; invite: 'valid' | 'invalid' | null }>(`/auth/signup-info${token ? `?invite=${encodeURIComponent(token)}` : ''}`),
  });
  const m = useMutation({
    mutationFn: (body: Record<string, string>) => api.post<{ user: PublicUser }>('/auth/register', { ...body, inviteToken: token }),
    onSuccess: ({ user }) => {
      setMe(user);
      navigate('/', { replace: true });
    },
  });
  const { fields, general } = fieldErrors(m.error);
  const pw = useNewPassword({ name: 'password', label: 'Password', hint: 'At least 10 characters.', error: fields.password, required: true });

  if (info.isPending) return <div className="center-load">Checking your link…</div>;
  if (!token && !info.data?.openSignup) return <Navigate to="/login" replace />;
  if (token && info.data?.invite !== 'valid') {
    return (
      <AuthLayout tagline="Your workouts, on your own server.">
        <h1 className="h2">This invite link doesn’t work</h1>
        <p className="muted">It has expired or was already used. Ask your admin for a new link.</p>
        <Link className="btn btn-quiet" to="/login">Go to sign in</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout tagline={token ? 'You’ve been invited to train here.' : 'Your workouts, on your own server.'}>
      <h1 className="h2">Create your account</h1>
      <p className="muted">Your workouts and history are private to you.</p>
      <form className="form" onSubmit={(e) => { const v = formValues(e); if (pw.check()) m.mutate(v); }} noValidate>
        <Field label="Your name" name="displayName" autoComplete="name" required error={fields.displayName} />
        <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required error={fields.username} hint="Letters, numbers, dots, dashes and underscores." />
        {pw.field}
        <FormError error={general} />
        <button className="btn btn-primary btn-block" type="submit" disabled={m.isPending}>
          {m.isPending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="small" style={{ marginTop: 20 }}>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthLayout>
  );
}

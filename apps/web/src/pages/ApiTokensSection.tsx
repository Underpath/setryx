import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiToken, ApiTokenScope, CreateApiTokenRequest } from '@setryx/shared';
import { api } from '../api.ts';
import { Field, FormError, Icon, Sheet, fieldErrors, useToast } from '../components/ui.tsx';

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const SCOPE_LABEL: Record<ApiTokenScope, string> = { read: 'Read only', write: 'Read and write' };
const EXPIRY: { v: CreateApiTokenRequest['expiresInDays']; label: string }[] = [
  { v: 30, label: '30 days' },
  { v: 90, label: '90 days' },
  { v: 365, label: '1 year' },
  { v: null, label: 'Never' },
];

const metaOf = (t: ApiToken) =>
  [
    SCOPE_LABEL[t.scope],
    t.lastUsedAt ? `Last used ${dateFmt.format(new Date(t.lastUsedAt))}` : 'Not used yet',
    t.expiresAt ? `Expires ${dateFmt.format(new Date(t.expiresAt))}` : 'Doesn’t expire',
  ].join('. ') + '.';

/** Settings → API tokens: personal tokens for scripts and AI agents. */
export function ApiTokensSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<{ tokens: ApiToken[] }>('/tokens') });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/tokens/${id}`),
    onSuccess: () => {
      toast('Token revoked');
      setRevoking(null);
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: (err) => toast(err.message),
  });

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="h3">Your tokens</h2>
          <button className="btn btn-quiet btn-sm" type="button" onClick={() => setCreating(true)}>New token</button>
        </div>
        <p className="muted small" style={{ marginBottom: 10 }}>
          Let a script or an AI agent use your setryx data. A token can read your exercises, workouts, routines, sessions and stats; with write access it can also
          create, change and delete them. It can’t change your account or password, other people’s data, or server settings.{' '}
          <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">What the API can do</a>
        </p>
        <FormError error={tokens.error} />
        <ul className="rows">
          {tokens.data?.tokens.length === 0 && <li className="row"><span className="muted">No tokens yet.</span></li>}
          {tokens.data?.tokens.map((t) => (
            <li className="row" key={t.id}>
              <div className="main"><div className="name">{t.name} <span className="token-hint">{t.hint}</span></div><div className="meta">{metaOf(t)}</div></div>
              <button className="btn btn-quiet btn-danger btn-sm" type="button" onClick={() => setRevoking(t)}>Revoke</button>
            </li>
          ))}
        </ul>
      </section>

      {creating && (
        <NewTokenSheet
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSecret(s);
            qc.invalidateQueries({ queryKey: ['tokens'] });
          }}
        />
      )}
      {secret && <TokenReadySheet secret={secret} onClose={() => setSecret(null)} />}
      {revoking && (
        <Sheet title={`Revoke “${revoking.name}”?`} onClose={() => setRevoking(null)}>
          <p className="muted">Anything using this token stops working straight away. This can’t be undone; you can make a new token instead.</p>
          <FormError error={revoke.error} />
          <button className="btn btn-primary btn-block" type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(revoking.id)}>Revoke token</button>
          <button className="btn btn-block" type="button" onClick={() => setRevoking(null)}>Keep it</button>
        </Sheet>
      )}
    </>
  );
}

function NewTokenSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const [scope, setScope] = useState<ApiTokenScope>('read');
  const [expires, setExpires] = useState<CreateApiTokenRequest['expiresInDays']>(90);
  const m = useMutation({
    mutationFn: (body: CreateApiTokenRequest) => api.post<{ token: ApiToken; secret: string }>('/tokens', body),
    onSuccess: ({ secret }) => onCreated(secret),
  });
  const { fields, general } = fieldErrors(m.error);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    m.mutate({ name: String(new FormData(e.currentTarget).get('name') ?? ''), scope, expiresInDays: expires });
  };
  return (
    <Sheet title="New API token" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Name" name="name" placeholder="What will use it, e.g. Claude" maxLength={60} error={fields.name} />
        <div className="field">
          <span className="label" id="token-scope">Access</span>
          <div className="seg" role="radiogroup" aria-labelledby="token-scope">
            {(['read', 'write'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scope === s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>{SCOPE_LABEL[s]}</button>
            ))}
          </div>
          <div className="hint">
            {scope === 'read'
              ? 'Can look at your exercises, workouts, routines, sessions and stats.'
              : 'Can also create, change and delete your exercises, workouts, routines and sessions.'}
          </div>
        </div>
        <div className="field">
          <span className="label" id="token-expiry">Expires after</span>
          <div className="seg" role="radiogroup" aria-labelledby="token-expiry">
            {EXPIRY.map((x) => (
              <button key={x.label} type="button" role="radio" aria-checked={expires === x.v} className={expires === x.v ? 'on' : ''} onClick={() => setExpires(x.v)}>{x.label}</button>
            ))}
          </div>
        </div>
        <FormError error={general} />
        <button className="btn btn-primary btn-block" type="submit" disabled={m.isPending}>Create token</button>
      </form>
    </Sheet>
  );
}

function TokenReadySheet({ secret, onClose }: { secret: string; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toast('Token copied');
    } catch {
      // The clipboard needs HTTPS on most browsers; select the text instead.
      (document.getElementById('token-secret') as HTMLInputElement | null)?.select();
      toast('Select the token and copy it');
    }
  };
  return (
    <Sheet title="Token ready" onClose={onClose}>
      <p className="muted">Copy it now: it’s shown only once. Keep it somewhere safe, like a password manager; anyone with it can use your data.</p>
      <div className="copy-box">
        <input id="token-secret" className="input mono" readOnly value={secret} onFocus={(e) => e.currentTarget.select()} aria-label="API token" />
        <button className="icon-btn btn-quiet" type="button" onClick={copy} aria-label="Copy token"><Icon name="copy" /></button>
      </div>
      <p className="small muted">Send it with each request as the header <code>Authorization: Bearer</code> followed by the token.</p>
      <button className="btn btn-primary btn-block" type="button" onClick={onClose}>Done</button>
    </Sheet>
  );
}

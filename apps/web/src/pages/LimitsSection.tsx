import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type LimitSettings, defaultLimitSettings } from '@setryx/shared';
import { api } from '../api.ts';
import { Field, FormError, fieldErrors, useToast } from '../components/ui.tsx';

type Draft = Record<keyof LimitSettings, string>;
const FIELDS: { key: keyof LimitSettings; label: string; hint: string; optional?: boolean }[] = [
  {
    key: 'tokenPerMinute',
    label: 'Requests a minute for each token',
    hint: 'Over the API and MCP together. An agent working normally stays well under the default of 120. Leave empty for no limit.',
    optional: true,
  },
  {
    key: 'appPerMinute',
    label: 'Requests a minute for each person in the app',
    hint: 'Everything the app asks the server for, apart from exercise photos. The default of 600 leaves plenty of room. Leave empty for no limit.',
    optional: true,
  },
  { key: 'signInPerMinute', label: 'Sign-in attempts a minute from one address', hint: 'Signing in, signing up and changing a password. Slows down password guessing.' },
  { key: 'maxTokensPerUser', label: 'Tokens each person can have', hint: 'Lowering it doesn’t remove tokens people already have; they just can’t add more.' },
];

const toDraft = (s: LimitSettings): Draft =>
  Object.fromEntries(FIELDS.map(({ key }) => [key, s[key] === null ? '' : String(s[key])])) as Draft;
const fromDraft = (d: Draft): LimitSettings =>
  Object.fromEntries(FIELDS.map(({ key, optional }) => [key, d[key].trim() === '' && optional ? null : Number(d[key])])) as LimitSettings;

/** Admin: how many requests tokens and people may make, sign-in attempts, and tokens per person. */
export function LimitsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const state = useQuery({ queryKey: ['admin', 'limits'], queryFn: () => api.get<LimitSettings>('/admin/limits') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({
    mutationFn: (s: LimitSettings) => api.put<LimitSettings>('/admin/limits', s),
    onSuccess: (d) => {
      qc.setQueryData(['admin', 'limits'], d);
      qc.invalidateQueries({ queryKey: ['tokens'] });
      setDraft(null);
      toast('Limits saved');
    },
  });
  if (!state.data) return <FormError error={state.error} />;
  const values = draft ?? toDraft(state.data);
  const saved = toDraft(state.data);
  const dirty = FIELDS.some(({ key }) => values[key] !== saved[key]);
  const isDefault = FIELDS.every(({ key }) => values[key] === toDraft(defaultLimitSettings)[key]);
  const { fields, general } = fieldErrors(save.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(fromDraft(values));
  };
  return (
    <>
      <p className="muted small" style={{ maxWidth: '62ch', marginBottom: 12 }}>
        Limits stop one person, script or agent from slowing the server down for everyone. A burst up to the limit is fine; going over it gets a short wait,
        and the app and agents are told how long. Changes apply straight away.
      </p>
      <form className="form" onSubmit={submit} noValidate>
        {FIELDS.map(({ key, label, hint, optional }) => (
          <Field
            key={key}
            label={label}
            name={key}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            placeholder={optional ? 'No limit' : undefined}
            value={values[key]}
            onChange={(e) => setDraft({ ...values, [key]: e.target.value })}
            hint={hint}
            error={fields[key]}
          />
        ))}
        <FormError error={general} />
        <div className="sheet-actions">
          {dirty && (
            <>
              <button className="btn btn-primary btn-sm" type="submit" disabled={save.isPending}>Save limits</button>
              <button className="btn btn-sm" type="button" onClick={() => (setDraft(null), save.reset())}>Cancel</button>
            </>
          )}
          {!isDefault && (
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => setDraft(toDraft(defaultLimitSettings))}>Use the defaults</button>
          )}
        </div>
      </form>
    </>
  );
}

import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type LimitSettings, defaultLimitSettings } from '@setryx/shared';
import { api } from '../api.ts';
import { Field, FormError, fieldErrors, useToast } from '../components/ui.tsx';

type Draft = Record<keyof LimitSettings, string>;
type FieldDef = { key: keyof LimitSettings; label: string; hint: string; optional?: boolean };
const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Signing in',
    fields: [
      {
        key: 'signInPerMinute',
        label: 'Wrong passwords a minute for each account',
        hint: 'Counted per account, whoever is trying. Past it, signing in waits a few seconds between tries, even with the right password, except on devices that have signed in to that account before: each of those has its own count. Changing a password or making a token counts per signed-in session.',
      },
      { key: 'sessionIdleDays', label: 'Days a sign-in lasts without use', hint: 'Someone who doesn’t open Setryx for this long is signed out on that device.' },
      {
        key: 'sessionMaxDays',
        label: 'Days a sign-in lasts at most',
        hint: 'Everyone signs in again this long after signing in, however often they use it, so a stolen sign-in can’t last for ever. Leave empty for no maximum.',
        optional: true,
      },
      { key: 'maxSessionsPerUser', label: 'Devices each person can be signed in on', hint: 'Signing in on one more signs out the device used longest ago.' },
    ],
  },
  {
    title: 'API and AI agents',
    fields: [
      {
        key: 'tokenPerMinute',
        label: 'Requests a minute for each token',
        hint: 'Over the API and MCP together. An agent working normally stays well under the default of 120. Leave empty for no limit.',
        optional: true,
      },
      { key: 'maxTokensPerUser', label: 'Tokens each person can have', hint: 'Lowering it doesn’t remove tokens people already have; they just can’t add more.' },
    ],
  },
  {
    title: 'Storage',
    fields: [
      {
        key: 'storageMbPerUser',
        label: 'Storage for each person, in MB',
        hint: 'Workouts, routines, own exercises and logged sessions. When it’s full, nothing new can be saved until something is deleted; a session logged offline waits on the device. Leave empty for no limit.',
        optional: true,
      },
    ],
  },
];
const FIELDS = GROUPS.flatMap((g) => g.fields);

const toDraft = (s: LimitSettings): Draft =>
  Object.fromEntries(FIELDS.map(({ key }) => [key, s[key] === null ? '' : String(s[key])])) as Draft;
const fromDraft = (d: Draft): LimitSettings =>
  Object.fromEntries(FIELDS.map(({ key, optional }) => [key, d[key].trim() === '' && optional ? null : Number(d[key])])) as LimitSettings;

/** Admin: sign-in attempts and lifetimes, requests per token, tokens and storage per person. */
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
        Limits slow down password guessing, keep sign-ins from lasting for ever, and stop a script or agent from slowing the server down or filling the disk.
        Using the app isn’t rate limited. Changes apply straight away, to existing sign-ins too.
      </p>
      <form className="form" onSubmit={submit} noValidate>
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="limits-group">
            <legend className="h3">{g.title}</legend>
            {g.fields.map(({ key, label, hint, optional }) => (
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
          </fieldset>
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

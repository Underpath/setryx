import { type InputHTMLAttributes, type ReactNode, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { ApiRequestError } from '../api.ts';
import { useBackHandler } from './backGuard.tsx';

// ── Icons ──
const paths = {
  today: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  workouts: <path d="M4 6h16M4 12h16M4 18h10" />,
  library: <path d="M6 4v16M18 4v16M3 8h6M15 8h6M3 16h6M15 16h6M9 12h6" />,
  stats: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  routines: <><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
};
export function Icon({ name, label }: { name: keyof typeof paths; label?: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}>
      {paths[name]}
    </svg>
  );
}

// ── Fields ──
type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string };
export function Field({ label, error, hint, id, ...input }: FieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const describedBy = error ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      <input className="input" id={fieldId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {error ? <div className="field-error" id={`${fieldId}-err`}>{error}</div> : hint ? <div className="hint" id={`${fieldId}-hint`}>{hint}</div> : null}
    </div>
  );
}

/**
 * A field for choosing a new password. Hidden, it's typed twice; "Show" makes
 * it readable and drops the second box, since you can see what you typed.
 * Call check() before submitting: it shows any mismatch and says whether to go on.
 * The second box has no name, so it isn't sent.
 */
export function useNewPassword({ name, label, hint, error, required }: { name: string; label: string; hint?: string; error?: string; required?: boolean }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const [tried, setTried] = useState(false);
  const problem = shown || value === '' ? null : again === '' ? 'Type the password again.' : again !== value ? 'The two passwords don’t match.' : null;
  const check = () => {
    setTried(true);
    return !problem;
  };
  const reset = () => (setValue(''), setAgain(''), setTried(false));
  const shownHint = shown ? `${hint ? `${hint} ` : ''}It’s shown, so you only type it once.` : hint;
  const describedBy = error ? `${id}-err` : shownHint ? `${id}-hint` : undefined;
  const field = (
    <>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <div className="password-wrap">
          <input
            className="input"
            id={id}
            name={name}
            type={shown ? 'text' : 'password'}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required={required}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
          <button className="password-toggle" type="button" aria-controls={id} aria-pressed={shown} onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
            <span className="visually-hidden"> password</span>
          </button>
        </div>
        {error ? <div className="field-error" id={`${id}-err`}>{error}</div> : shownHint ? <div className="hint" id={`${id}-hint`}>{shownHint}</div> : null}
      </div>
      {!shown && (
        <Field
          label="Type it again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          error={tried && problem ? problem : undefined}
        />
      )}
    </>
  );
  return { field, check, reset };
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return <div className="form-error" role="alert">{message}</div>;
}

/** Splits an API error into per-field messages and a top-level message for anything left over. */
export function fieldErrors(error: unknown): { fields: Record<string, string>; general: Error | null } {
  if (error instanceof ApiRequestError) {
    const hasFields = Object.keys(error.fields).length > 0;
    return { fields: error.fields, general: hasFields ? null : error };
  }
  return { fields: {}, general: error instanceof Error ? error : null };
}

export function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <label className="setting" htmlFor={id}>
      <span className="main">
        <span className="name">{label}</span>
        {hint && <span className="meta">{hint}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ── Sheet dialog ──
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Callers often pass a new onClose on every render; keep the latest without re-running effects.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Phone back gesture / browser back closes the sheet instead of leaving the page.
  useBackHandler(
    true,
    (nav) => {
      nav.reset();
      onClose();
    },
    { backOnly: true },
  );
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Focus the first field (or else the first action), not the close button in the header.
    const body = ref.current;
    const target =
      body?.querySelector<HTMLElement>('[data-autofocus]') ??
      body?.querySelector<HTMLElement>(':scope > :not(.sheet-head) input:not([type=checkbox]):not([type=hidden]), :scope > :not(.sheet-head) textarea, :scope > :not(.sheet-head) select, :scope > input, :scope > form input') ??
      body?.querySelector<HTMLElement>(':scope > button, :scope > :not(.sheet-head) button');
    // Without scrolling: a long sheet should still open at the top.
    target?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
    // Once, when the sheet opens: re-focusing on every render would steal focus while typing.
  }, []);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sheet-head">
          <h2 className="h2" id={titleId}>{title}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Toast ──
const ToastContext = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2400);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite">{msg && <div className="toast">{msg}</div>}</div>
    </ToastContext.Provider>
  );
}

// ── Unsaved-changes dialog ──
export function LeaveDialog({
  message,
  saveLabel,
  saving,
  onSave,
  onDiscard,
  onKeep,
}: {
  message: string;
  saveLabel: string;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  return (
    <Sheet title="Save your changes?" onClose={onKeep}>
      <p className="muted">{message}</p>
      <button className="btn btn-primary btn-block" type="button" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : saveLabel}</button>
      <button className="btn btn-quiet btn-block" type="button" onClick={onDiscard}>Discard changes</button>
      <button className="btn btn-block" type="button" onClick={onKeep}>Keep editing</button>
    </Sheet>
  );
}

/** Asks the browser to warn before closing or reloading the tab while there are unsaved changes. */
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}

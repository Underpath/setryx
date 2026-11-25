import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useBlocker } from 'react-router';

/**
 * One place that intercepts leaving a page (phone back gesture, browser back,
 * links). React Router allows only one blocker at a time, so sheets and editors
 * register handlers here instead; the most recently opened one decides.
 *
 * - An open sheet closes itself on back (and asks Save / Discard first if it
 *   has changes), instead of the whole page going away.
 * - An editor with unsaved changes shows its Save / Discard / Keep editing dialog.
 */
export type BlockedNav = { proceed: () => void; reset: () => void };
type Handler = (nav: BlockedNav) => void;

const Ctx = createContext<{ register: (h: Handler) => () => void; allowNext: () => void }>({
  register: () => () => {},
  allowNext: () => {},
});

export function BackGuardProvider({ children }: { children: ReactNode }) {
  const stack = useRef<Handler[]>([]);
  const skip = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (skip.current) {
      skip.current = false;
      return false;
    }
    return stack.current.length > 0 && currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const top = stack.current[stack.current.length - 1];
    const nav: BlockedNav = { proceed: () => blocker.proceed(), reset: () => blocker.reset() };
    if (top) top(nav);
    else nav.proceed();
  }, [blocker]);

  const register = useCallback((h: Handler) => {
    stack.current.push(h);
    return () => {
      stack.current = stack.current.filter((x) => x !== h);
    };
  }, []);
  /** Let the next navigation through (e.g. right after saving). */
  const allowNext = useCallback(() => {
    skip.current = true;
  }, []);
  const value = useMemo(() => ({ register, allowNext }), [register, allowNext]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** While `active`, a back navigation calls `handler` instead of leaving. */
export function useBackHandler(active: boolean, handler: Handler) {
  const { register } = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return register((nav) => ref.current(nav));
  }, [active, register]);
}

export function useAllowNextNavigation() {
  return useContext(Ctx).allowNext;
}

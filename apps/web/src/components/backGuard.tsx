import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useBlocker } from 'react-router';

/**
 * One place that intercepts leaving a page. React Router allows only one
 * blocker at a time, so sheets and editors register handlers here instead;
 * the most recently registered one that applies decides.
 *
 * - An open sheet only catches the back gesture / browser back (a "pop"): it
 *   closes itself (asking Save / Discard first if it has changes) instead of
 *   the whole page going away. The app's own navigation, like a button that
 *   goes to Today, passes straight through.
 * - An editor with unsaved changes catches every way of leaving and shows its
 *   Save / Discard / Keep editing dialog.
 */
export type BlockedNav = { proceed: () => void; reset: () => void };
type Handler = (nav: BlockedNav) => void;
type Entry = { handler: Handler; backOnly: boolean };
type Action = 'POP' | 'PUSH' | 'REPLACE';

const Ctx = createContext<{ register: (e: Entry) => () => void; allowNext: () => void }>({
  register: () => () => {},
  allowNext: () => {},
});

const applies = (e: Entry, action: Action) => !e.backOnly || action === 'POP';

export function BackGuardProvider({ children }: { children: ReactNode }) {
  const stack = useRef<Entry[]>([]);
  const skip = useRef(false);
  const lastAction = useRef<Action>('POP');
  const blocker = useBlocker(({ currentLocation, nextLocation, historyAction }) => {
    if (skip.current) {
      skip.current = false;
      return false;
    }
    if (currentLocation.pathname === nextLocation.pathname) return false;
    lastAction.current = historyAction as Action;
    return stack.current.some((e) => applies(e, lastAction.current));
  });

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const top = [...stack.current].reverse().find((e) => applies(e, lastAction.current));
    const nav: BlockedNav = { proceed: () => blocker.proceed(), reset: () => blocker.reset() };
    if (top) top.handler(nav);
    else nav.proceed();
  }, [blocker]);

  const register = useCallback((e: Entry) => {
    stack.current.push(e);
    return () => {
      stack.current = stack.current.filter((x) => x !== e);
    };
  }, []);
  /** Let the next navigation through (e.g. right after saving). */
  const allowNext = useCallback(() => {
    skip.current = true;
  }, []);
  const value = useMemo(() => ({ register, allowNext }), [register, allowNext]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * While `active`, leaving the page calls `handler` instead.
 * With `backOnly`, only the back gesture / browser back is caught.
 */
export function useBackHandler(active: boolean, handler: Handler, opts: { backOnly?: boolean } = {}) {
  const { register } = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  const backOnly = !!opts.backOnly;
  useEffect(() => {
    if (!active) return;
    return register({ handler: (nav) => ref.current(nav), backOnly });
  }, [active, register, backOnly]);
}

export function useAllowNextNavigation() {
  return useContext(Ctx).allowNext;
}

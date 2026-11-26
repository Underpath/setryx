import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import type { PublicUser } from '@setryx/shared';
import { useSignOut } from './SignOut.tsx';
import { Icon } from './ui.tsx';

const tabs = [
  { to: '/', label: 'Today', icon: 'today' },
  { to: '/workouts', label: 'Workouts', icon: 'workouts' },
  { to: '/routines', label: 'Routines', icon: 'routines' },
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/stats', label: 'Stats', icon: 'stats' },
] as const;

export function initials(user: PublicUser): string {
  return (user.displayName.trim()[0] ?? user.username[0] ?? '?').toUpperCase();
}

/** The avatar button and its short menu: settings and sign out. */
export function AvatarMenu({ user, placement = 'below' }: { user: PublicUser; placement?: 'below' | 'beside' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const signOut = useSignOut(user);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`avatar-wrap ${placement}`} ref={wrap}>
      <button className="avatar" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`${user.displayName}: account menu`} onClick={() => setOpen(!open)}>
        {initials(user)}
      </button>
      {open && (
        <div className="avatar-menu" role="menu">
          <div className="am-who">
            <b>{user.displayName}</b>
            <span>{user.username}</span>
          </div>
          <Link role="menuitem" className="am-item" to="/settings">Settings</Link>
          <button role="menuitem" className="am-item" type="button" onClick={() => (setOpen(false), signOut.start())} disabled={signOut.pending}>Sign out</button>
        </div>
      )}
      {signOut.sheet}
    </div>
  );
}

export function Shell({ user }: { user: PublicUser }) {
  return (
    <div className="shell">
      <nav className="tabbar" aria-label="Main">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === '/'} className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
            <Icon name={t.icon} />
            {t.label}
          </NavLink>
        ))}
        <div className="rail-avatar">
          <AvatarMenu user={user} placement="beside" />
        </div>
      </nav>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}

/** Screen title row. On phones the avatar menu sits here; on wide screens it moves to the rail. */
export function TopBar({ title, user, back, actions }: { title: string; user?: PublicUser; back?: string; actions?: ReactNode }) {
  return (
    <header className="topbar">
      {back && (
        <Link className="icon-btn" to={back} aria-label="Back"><Icon name="back" /></Link>
      )}
      <h1 className="h2">{title}</h1>
      {actions}
      {user && <div className="topbar-avatar"><AvatarMenu user={user} /></div>}
    </header>
  );
}

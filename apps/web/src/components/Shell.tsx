import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import type { PublicUser } from '@setryx/shared';
import { Icon } from './ui.tsx';

const tabs = [
  { to: '/', label: 'Today', icon: 'today' },
  { to: '/workouts', label: 'Workouts', icon: 'workouts' },
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/stats', label: 'Stats', icon: 'stats' },
] as const;

export function initials(user: PublicUser): string {
  return (user.displayName.trim()[0] ?? user.username[0] ?? '?').toUpperCase();
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
        <Link className="avatar rail-avatar" to="/settings" aria-label="Settings">{initials(user)}</Link>
      </nav>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}

/** Screen title row. On phones the avatar (settings) sits here; on wide screens it moves to the rail. */
export function TopBar({ title, user, back, actions }: { title: string; user?: PublicUser; back?: string; actions?: ReactNode }) {
  return (
    <header className="topbar">
      {back && (
        <Link className="icon-btn" to={back} aria-label="Back"><Icon name="back" /></Link>
      )}
      <h1 className="h2">{title}</h1>
      {actions}
      {user && <Link className="avatar" to="/settings" aria-label="Settings">{initials(user)}</Link>}
    </header>
  );
}

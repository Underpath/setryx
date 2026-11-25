import type { ComponentType } from 'react';
import { Navigate, Outlet, createBrowserRouter, useLocation } from 'react-router';
import type { PublicUser } from '@setryx/shared';
import { useMe, useSetupStatus, useThemeFromSettings } from './session.ts';
import { BackGuardProvider } from './components/backGuard.tsx';
import { Shell } from './components/Shell.tsx';
import { LoginPage, SetupPage, SignupPage } from './pages/AuthPages.tsx';
import { TodayPage } from './pages/TodayPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';
import { WorkoutsPage } from './pages/WorkoutsPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { WorkoutEditorPage } from './pages/WorkoutEditorPage.tsx';
import { ImportPage } from './pages/ImportPage.tsx';
import { StatsPage } from './pages/StatsPage.tsx';
import { PlayerRoute, ResumeRoute } from './player/PlayerPage.tsx';
import { ReviewRoute } from './player/ReviewPage.tsx';
import { RoutineEditorPage } from './pages/RoutineEditorPage.tsx';
import { SyncRunner } from './sync/outbox.ts';

const PUBLIC_PATHS = ['/login', '/signup', '/invite/'];

/** Loads setup state and the signed-in user, and sends people to the right place. */
function Root() {
  const setup = useSetupStatus();
  const me = useMe();
  const { pathname } = useLocation();
  useThemeFromSettings(me.data);

  if (setup.isPending || me.isPending) return <div className="center-load">Loading…</div>;
  if (setup.isError || me.isError) {
    return (
      <div className="center-load" role="alert">
        <div style={{ padding: 20, maxWidth: 420 }}>
          <h1 className="h2">Can’t reach the server</h1>
          <p className="muted">Check that the setryx container is running, then reload this page.</p>
        </div>
      </div>
    );
  }
  if (setup.data.needsSetup) return pathname === '/setup' ? <SetupPage /> : <Navigate to="/setup" replace />;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  if (!me.data) return isPublic ? <Outlet /> : <Navigate to="/login" replace />;
  if (isPublic || pathname === '/setup') return <Navigate to="/" replace />;
  return (
    <BackGuardProvider>
      <SyncRunner userId={me.data.id} />
      <Outlet context={me.data} />
    </BackGuardProvider>
  );
}

function SignedIn() {
  const me = useMe();
  return <Shell user={me.data!} />;
}

/** Hands the signed-in user to pages that take it as a prop. */
function withUser(Page: ComponentType<{ user: PublicUser }>) {
  return function WithUser() {
    const me = useMe();
    return <Page user={me.data!} />;
  };
}

const Today = withUser(TodayPage);
const Settings = withUser(SettingsPage);
const Admin = withUser(AdminPage);
const Workouts = withUser(WorkoutsPage);
const Library = withUser(LibraryPage);
const Stats = withUser(StatsPage);

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/setup', element: <SetupPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/invite/:token', element: <SignupPage /> },
      // Full-screen pages without the tab bar
      { path: '/workouts/new', element: <WorkoutEditorPage /> },
      { path: '/workouts/import', element: <ImportPage /> },
      { path: '/workouts/:id', element: <WorkoutEditorPage /> },
      { path: '/routines/new', element: <RoutineEditorPage /> },
      { path: '/routines/:id', element: <RoutineEditorPage /> },
      { path: '/play', element: <ResumeRoute /> },
      { path: '/play/:workoutId', element: <PlayerRoute /> },
      { path: '/review/:sessionId', element: <ReviewRoute /> },
      {
        element: <SignedIn />,
        children: [
          { index: true, element: <Today /> },
          { path: '/workouts', element: <Workouts /> },
          { path: '/library', element: <Library /> },
          { path: '/stats', element: <Stats /> },
          { path: '/settings', element: <Settings /> },
          { path: '/settings/admin', element: <Admin /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

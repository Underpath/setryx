import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useMe, useSetupStatus, useThemeFromSettings } from './session.ts';
import { Shell } from './components/Shell.tsx';
import { LoginPage, SetupPage, SignupPage } from './pages/AuthPages.tsx';
import { ComingSoonPage, TodayPage } from './pages/TodayPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';

export function App() {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();
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

  const needsSetup = setup.data.needsSetup;
  const user = me.data;

  if (needsSetup) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/invite/:token" element={<SignupPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Shell user={user} />}>
        <Route index element={<TodayPage user={user} />} />
        <Route path="workouts" element={<ComingSoonPage title="Workouts" user={user} text="Building workouts and importing your routines comes in the next update." />} />
        <Route path="library" element={<ComingSoonPage title="Library" user={user} text="The exercise library, with about 870 exercises and your own custom ones, is on its way." />} />
        <Route path="stats" element={<ComingSoonPage title="Stats" user={user} text="Charts and records appear once you’ve logged some workouts." />} />
        <Route path="settings" element={<SettingsPage user={user} />} />
        <Route path="settings/admin" element={<AdminPage user={user} />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

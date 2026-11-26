import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useEffect } from 'react';
import type { PublicUser } from '@setryx/shared';
import { api, ApiRequestError } from './api.ts';

export function useSetupStatus() {
  return useQuery({ queryKey: ['setup'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup'), staleTime: Infinity });
}

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api.get<{ user: PublicUser }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function useSetMe() {
  const qc = useQueryClient();
  return (user: PublicUser | null) => {
    qc.setQueryData(['me'], user);
    if (user) qc.setQueryData(['setup'], { needsSetup: false });
  };
}

/** Applies the user's theme choice to <html data-theme>. */
export function useThemeFromSettings(user: PublicUser | null | undefined) {
  const theme = user?.settings.theme ?? 'system';
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}

/** Signs out and drops everything this account left on the device. */
export function useLogout() {
  const qc = useQueryClient();
  const setMe = useSetMe();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      qc.clear();
      // Offline copies of workouts belong to this account; drop them on sign-out.
      if ('caches' in window) void caches.delete('setryx-api').catch(() => {});
      setMe(null);
      navigate('/login', { replace: true });
    },
  });
}

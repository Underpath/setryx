import { useQuery, useQueryClient } from '@tanstack/react-query';
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

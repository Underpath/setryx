import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Bests,
  Exercise,
  ExerciseHistoryEntry,
  ExerciseStat,
  SessionPoint,
  ExerciseInput,
  ImportChoice,
  Routine,
  RoutineImportPreview,
  RoutineInput,
  SessionDetail,
  SessionSummary,
  WorkoutInput,
  WorkoutSummary,
  WorkoutWithExercises,
} from '@setryx/shared';
import { api } from './api.ts';

// ── Exercises ──
export type ExerciseFilters = { q: string; muscle: string; equipment: string; custom: boolean };

export function useExerciseSearch(f: ExerciseFilters, limit = 60) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (f.q.trim()) params.set('q', f.q.trim());
  if (f.muscle) params.set('muscle', f.muscle);
  if (f.equipment) params.set('equipment', f.equipment);
  if (f.custom) params.set('custom', '1');
  return useQuery({
    queryKey: ['exercises', 'search', params.toString()],
    queryFn: () => api.get<{ exercises: Exercise[]; total: number }>(`/exercises?${params}`),
    placeholderData: keepPreviousData,
  });
}

export function useExerciseFacets() {
  return useQuery({ queryKey: ['exercises', 'facets'], queryFn: () => api.get<{ muscles: string[]; equipment: string[] }>('/exercises/facets'), staleTime: 5 * 60_000 });
}

export function useSaveExercise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: ExerciseInput }) =>
      id ? api.put<{ exercise: Exercise }>(`/exercises/${id}`, input) : api.post<{ exercise: Exercise }>('/exercises', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exercises'] }),
  });
}

/** Saves your form cues for an exercise; they show in every workout that uses it. */
export function useSaveCues() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cues }: { id: string; cues: string | null }) => api.put<{ exercise: Exercise }>(`/exercises/${id}/cues`, { cues }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exercises'] });
      qc.invalidateQueries({ queryKey: ['workout'] });
    },
  });
}

export function useDeleteExercise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/exercises/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exercises'] }),
  });
}

// ── Workouts ──
export function useWorkouts() {
  return useQuery({ queryKey: ['workouts'], queryFn: async () => (await api.get<{ workouts: WorkoutSummary[] }>('/workouts')).workouts });
}

export function useWorkout(id: string | undefined) {
  return useQuery({
    queryKey: ['workout', id],
    queryFn: () => api.get<WorkoutWithExercises>(`/workouts/${id}`),
    enabled: !!id,
    staleTime: Infinity, // the editor owns this while open
  });
}

export function useSaveWorkout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: WorkoutInput }) =>
      id ? api.put<WorkoutWithExercises>(`/workouts/${id}`, input) : api.post<WorkoutWithExercises>('/workouts', input),
    onSuccess: (data) => {
      qc.setQueryData(['workout', data.workout.id], data);
      qc.invalidateQueries({ queryKey: ['workouts'] });
    },
  });
}

export function useDeleteWorkout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workouts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workouts'] }),
  });
}

export function useDuplicateWorkout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<WorkoutWithExercises>(`/workouts/${id}/duplicate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workouts'] }),
  });
}

// ── Routine import ──
export function useImportPreview() {
  return useMutation({ mutationFn: (data: unknown) => api.post<RoutineImportPreview>('/import/routines/preview', { data }) });
}

export function useImportRoutines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { data: unknown; choices: Record<string, ImportChoice> }) =>
      api.post<{ workouts: { id: string; name: string }[] }>('/import/routines', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workouts'] });
      qc.invalidateQueries({ queryKey: ['exercises'] });
    },
  });
}

export function formatMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ── Sessions ──
export function useSessions(limit = 20) {
  return useQuery({
    queryKey: ['sessions', limit],
    queryFn: async () => (await api.get<{ sessions: SessionSummary[] }>(`/sessions?limit=${limit}`)).sessions,
  });
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: ['sessions', 'one', id],
    queryFn: async () => (await api.get<{ session: SessionDetail }>(`/sessions/${id}`)).session,
    enabled: !!id,
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/sessions/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

// ── Stats ──
export function useStatSessions(days = 400) {
  return useQuery({ queryKey: ['stats', 'sessions', days], queryFn: async () => (await api.get<{ sessions: SessionPoint[] }>(`/stats/sessions?days=${days}`)).sessions });
}

export function useExerciseStats() {
  return useQuery({ queryKey: ['stats', 'exercises'], queryFn: async () => (await api.get<{ exercises: ExerciseStat[] }>('/stats/exercises')).exercises });
}

export function useExerciseHistory(id: string | undefined) {
  return useQuery({
    queryKey: ['stats', 'exercise', id],
    queryFn: () => api.get<{ exerciseId: string; name: string; entries: ExerciseHistoryEntry[] }>(`/stats/exercises/${id}`),
    enabled: !!id,
  });
}

/** Bests before a session, for spotting records on its review. Offline it just fails and no records show. */
export function useBests(ids: string[], excludeSessionId: string) {
  const key = [...ids].sort().join(',');
  return useQuery({
    queryKey: ['stats', 'bests', key, excludeSessionId],
    queryFn: async () => (await api.get<{ bests: Record<string, Bests> }>(`/stats/bests?ids=${encodeURIComponent(key)}&exclude=${excludeSessionId}`)).bests,
    enabled: ids.length > 0,
    retry: false,
    staleTime: Infinity,
  });
}

// ── Routines ──
export function useRoutines() {
  return useQuery({ queryKey: ['routines'], queryFn: async () => (await api.get<{ routines: Routine[] }>('/routines')).routines });
}

export function useRoutine(id: string | undefined) {
  return useQuery({
    queryKey: ['routine', id],
    queryFn: async () => (await api.get<{ routine: Routine }>(`/routines/${id}`)).routine,
    enabled: !!id,
    staleTime: Infinity, // the editor owns this while open
  });
}

function useRoutineMutation<V>(fn: (v: V) => Promise<{ routine: Routine }>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(['routine', data.routine.id], data.routine);
      void qc.invalidateQueries({ queryKey: ['routines'] });
    },
  });
}

export const useSaveRoutine = () =>
  useRoutineMutation(({ id, input }: { id?: string; input: RoutineInput }) =>
    id ? api.put<{ routine: Routine }>(`/routines/${id}`, input) : api.post<{ routine: Routine }>('/routines', input),
  );
export const useSetRoutineActive = () => useRoutineMutation(({ id, active }: { id: string; active: boolean }) => api.patch<{ routine: Routine }>(`/routines/${id}`, { active }));
export const useRestartRoutine = () => useRoutineMutation((id: string) => api.post<{ routine: Routine }>(`/routines/${id}/restart`));

export function useDeleteRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/routines/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines'] }),
  });
}

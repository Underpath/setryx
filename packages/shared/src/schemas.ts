import { z } from 'zod';

// ── Accounts ──────────────────────────────────────────────

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters.')
  .max(32, 'Use at most 32 characters.')
  .regex(/^[a-z0-9._-]+$/, 'Use only letters, numbers, dots, dashes and underscores.');

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(256, 'Use at most 256 characters.');

export const displayNameSchema = z.string().trim().min(1, 'Enter a name.').max(60, 'Use at most 60 characters.');

export const userSettingsSchema = z.object({
  voice: z.boolean().default(true),
  sounds: z.boolean().default(true),
  keepAwake: z.boolean().default(true),
  tapToLog: z.boolean().default(true),
  showTapHint: z.boolean().default(true),
  warnSeconds: z.number().int().min(0).max(60).default(10),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /** First day of the week: 0 = Monday … 6 = Sunday. */
  weekStart: z.number().int().min(0).max(6).default(0),
  /** Count the streak on Stats in days or weeks. */
  streakUnit: z.enum(['weeks', 'days']).default('weeks'),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;
export const defaultUserSettings: UserSettings = userSettingsSchema.parse({});

export const roleSchema = z.enum(['admin', 'user']);
export type Role = z.infer<typeof roleSchema>;

export const publicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: roleSchema,
  disabled: z.boolean(),
  createdAt: z.string(),
  settings: userSettingsSchema,
});
export type PublicUser = z.infer<typeof publicUserSchema>;

// ── Requests ──────────────────────────────────────────────

export const setupRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const loginRequestSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const registerRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  inviteToken: z.string().min(10).max(200).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const updateMeRequestSchema = z.object({
  displayName: displayNameSchema.optional(),
  settings: userSettingsSchema.partial().optional(),
});
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const adminCreateUserRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  role: roleSchema.default('user'),
});
export type AdminCreateUserRequest = z.input<typeof adminCreateUserRequestSchema>;

export const adminUpdateUserRequestSchema = z.object({
  displayName: displayNameSchema.optional(),
  role: roleSchema.optional(),
  disabled: z.boolean().optional(),
});
export type AdminUpdateUserRequest = z.infer<typeof adminUpdateUserRequestSchema>;

export const adminResetPasswordRequestSchema = z.object({ password: passwordSchema });
export type AdminResetPasswordRequest = z.infer<typeof adminResetPasswordRequestSchema>;

export const createInviteRequestSchema = z.object({
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export const inviteSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  createdBy: z.string(),
  usedBy: z.string().nullable(),
  usedAt: z.string().nullable(),
  status: z.enum(['open', 'used', 'expired']),
});
export type Invite = z.infer<typeof inviteSchema>;

export const appSettingsSchema = z.object({ openSignup: z.boolean() });
export type AppSettings = z.infer<typeof appSettingsSchema>;

/** Where database copies go and how many are kept. Paths are inside the container. */
export const backupSettingsSchema = z.object({
  dir: z
    .string()
    .trim()
    .min(1, 'Enter a folder.')
    .max(300)
    .refine((p) => p.startsWith('/') && !p.split('/').includes('..'), 'Use a full path inside the container, like /data/backups.'),
  /** Copies taken before an update changes the database. */
  keep: z.number().int().min(1, 'Keep at least one.').max(50),
  /** Refresh setryx-latest.db this often when something changed; 0 turns it off. */
  latestEveryMinutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(60), z.literal(360), z.literal(1440)]),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export const defaultBackupSettings = (dataDir: string): BackupSettings => ({ dir: `${dataDir.replace(/\/$/, '')}/backups`, keep: 3, latestEveryMinutes: 15 });

export type BackupFile = { name: string; kind: 'latest' | 'before-update' | 'manual'; bytes: number; modifiedAt: string };

// ── Errors ────────────────────────────────────────────────

export type ApiError = {
  error: string;
  message: string;
  fields?: Record<string, string>;
};

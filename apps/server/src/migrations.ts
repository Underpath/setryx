// Append-only. Never edit a migration that has shipped; add a new one.
export const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        disabled      INTEGER NOT NULL DEFAULT 0,
        settings      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE auth_sessions (
        id_hash     TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_agent  TEXT,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

      CREATE TABLE invites (
        id          TEXT PRIMARY KEY,
        token_hash  TEXT NOT NULL UNIQUE,
        created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
        used_at     TEXT
      );

      CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO app_settings (key, value) VALUES ('open_signup', 'false');
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE exercises (
        id                TEXT PRIMARY KEY,
        owner_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        name_norm         TEXT NOT NULL,
        category          TEXT,
        default_type      TEXT NOT NULL CHECK (default_type IN ('reps', 'timed')),
        primary_muscles   TEXT NOT NULL DEFAULT '[]',
        secondary_muscles TEXT NOT NULL DEFAULT '[]',
        equipment         TEXT NOT NULL DEFAULT '[]',
        instructions      TEXT NOT NULL DEFAULT '[]',
        images            TEXT NOT NULL DEFAULT '[]',
        source            TEXT,
        source_id         TEXT,
        archived          INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        UNIQUE (source, source_id)
      );
      CREATE INDEX exercises_owner ON exercises(owner_id);
      CREATE INDEX exercises_name ON exercises(name_norm);

      CREATE TABLE workouts (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        icon        TEXT NOT NULL DEFAULT '',
        notes       TEXT,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX workouts_user ON workouts(user_id);

      -- Steps of a workout. Superset children point at their superset with parent_id.
      CREATE TABLE workout_items (
        workout_id   TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        id           TEXT NOT NULL,
        parent_id    TEXT,
        position     INTEGER NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('exercise', 'rest', 'superset')),
        exercise_id  TEXT REFERENCES exercises(id),
        data         TEXT NOT NULL,
        PRIMARY KEY (workout_id, id)
      );
      CREATE INDEX workout_items_exercise ON workout_items(exercise_id);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workout_id    TEXT,
        workout_name  TEXT NOT NULL,
        icon          TEXT NOT NULL DEFAULT '',
        started_at    TEXT NOT NULL,
        ended_at      TEXT NOT NULL,
        duration_ms   INTEGER NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('completed', 'ended_early')),
        notes         TEXT,
        snapshot      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX sessions_user_started ON sessions(user_id, started_at);

      CREATE TABLE set_logs (
        session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        step_index         INTEGER NOT NULL,
        item_id            TEXT NOT NULL,
        exercise_id        TEXT NOT NULL,
        round              INTEGER,
        planned_reps       INTEGER,
        actual_reps        INTEGER,
        planned_weight     REAL,
        actual_weight      REAL,
        planned_duration_s INTEGER,
        actual_duration_s  INTEGER,
        completed_at       TEXT NOT NULL,
        PRIMARY KEY (session_id, step_index)
      );
      CREATE INDEX set_logs_exercise ON set_logs(exercise_id);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE routines (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        mode        TEXT NOT NULL CHECK (mode IN ('repeat', 'once', 'weekly')),
        active      INTEGER NOT NULL DEFAULT 1,
        started_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX routines_user ON routines(user_id);

      -- Weekday: 0 = Monday … 6 = Sunday, weekly routines only.
      CREATE TABLE routine_entries (
        routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        id          TEXT NOT NULL,
        workout_id  TEXT NOT NULL,
        position    INTEGER NOT NULL,
        weekday     INTEGER CHECK (weekday BETWEEN 0 AND 6),
        PRIMARY KEY (routine_id, id)
      );

      ALTER TABLE sessions ADD COLUMN routine_id TEXT;
      ALTER TABLE sessions ADD COLUMN routine_entry_id TEXT;
      CREATE INDEX sessions_routine ON sessions(routine_id, started_at);
    `,
  },
];

-- M2a: per-user notification & availability preferences (Notifications §7, Platform §14).
-- Missing rows mean defaults; growable enums are validated with Zod in packages/shared (no SQL CHECK).
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_delay TEXT NOT NULL DEFAULT '10m',
  email_include_private_text INTEGER NOT NULL DEFAULT 0,
  dnd_until INTEGER,
  dnd_schedule TEXT,
  ring_sound INTEGER NOT NULL DEFAULT 1,
  notification_sound INTEGER NOT NULL DEFAULT 1,
  reminder_defaults TEXT NOT NULL DEFAULT '{"timed":[10],"allDay":["-1d@09:00"],"email":false}',
  shortcuts TEXT NOT NULL DEFAULT '{"singleKey":true}',
  offline_cache INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

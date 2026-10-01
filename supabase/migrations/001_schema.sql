CREATE TABLE IF NOT EXISTS organizations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS yemot_systems (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  system_number TEXT NOT NULL,
  api_key_encrypted TEXT,
  api_status TEXT NOT NULL DEFAULT 'pending_api' CHECK (api_status IN ('pending_api','configured','error')),
  api_last_checked_at TIMESTAMPTZ,
  api_last_error TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, system_number)
);
CREATE INDEX IF NOT EXISTS idx_yemot_systems_org ON yemot_systems(organization_id);

CREATE TABLE IF NOT EXISTS classes (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  yemot_system_id BIGINT REFERENCES yemot_systems(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  extension_path TEXT NOT NULL DEFAULT '',
  weekdays INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
  start_time TIME NOT NULL DEFAULT '09:00',
  end_time TIME NOT NULL DEFAULT '10:00',
  late_after_minutes INTEGER NOT NULL DEFAULT 10,
  min_present_minutes INTEGER NOT NULL DEFAULT 20,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_classes_org ON classes(organization_id);
CREATE INDEX IF NOT EXISTS idx_classes_system ON classes(yemot_system_id);

CREATE TABLE IF NOT EXISTS organization_members (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','secretary','class_teacher','viewer')),
  class_id BIGINT REFERENCES classes(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_org ON organization_members(organization_id);

CREATE TABLE IF NOT EXISTS students (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  class_id BIGINT REFERENCES classes(id) ON DELETE SET NULL,
  external_id TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_students_org ON students(organization_id);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_phone ON students(phone);

CREATE TABLE IF NOT EXISTS call_sessions (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  yemot_system_id BIGINT REFERENCES yemot_systems(id) ON DELETE SET NULL,
  call_id TEXT,
  phone TEXT NOT NULL,
  extension_path TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL,
  exited_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_calls_org_phone_time ON call_sessions(organization_id, phone, entered_at);
CREATE INDEX IF NOT EXISTS idx_calls_org_ext_time ON call_sessions(organization_id, extension_path, entered_at);
CREATE INDEX IF NOT EXISTS idx_calls_live ON call_sessions(organization_id, exited_at) WHERE exited_at IS NULL;

CREATE TABLE IF NOT EXISTS attendance_overrides (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','excused','late')),
  note TEXT,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(student_id, day)
);
CREATE INDEX IF NOT EXISTS idx_attendance_overrides_org_day ON attendance_overrides(organization_id, day);

CREATE TABLE IF NOT EXISTS settings (
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(organization_id, key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log(organization_id, created_at DESC);

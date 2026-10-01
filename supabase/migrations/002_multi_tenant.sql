-- Safe migration from NACHLAS Attendance v4.x to v5 multi-tenant / multi-system.
-- It is intentionally idempotent and can also run after the fresh v5 schema.

CREATE TABLE IF NOT EXISTS organizations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO organizations(name,slug)
SELECT 'ארגון ראשי','main'
WHERE NOT EXISTS (SELECT 1 FROM organizations);

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

-- Add tenant/system columns to v4 tables when they are missing.
ALTER TABLE classes ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS yemot_system_id BIGINT REFERENCES yemot_systems(id) ON DELETE SET NULL;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE students ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS yemot_system_id BIGINT REFERENCES yemot_systems(id) ON DELETE SET NULL;
ALTER TABLE attendance_overrides ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE;

DO $$
DECLARE oid BIGINT;
BEGIN
  SELECT id INTO oid FROM organizations ORDER BY id LIMIT 1;
  UPDATE classes SET organization_id=oid WHERE organization_id IS NULL;
  UPDATE students SET organization_id=oid WHERE organization_id IS NULL;
  UPDATE call_sessions SET organization_id=oid WHERE organization_id IS NULL;
  UPDATE attendance_overrides SET organization_id=oid WHERE organization_id IS NULL;
  UPDATE audit_log SET organization_id=oid WHERE organization_id IS NULL;
END $$;

ALTER TABLE classes ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE students ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE call_sessions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE attendance_overrides ALTER COLUMN organization_id SET NOT NULL;

-- Replace old global uniqueness with per-organization uniqueness.
ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_name_key;
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_phone_key;
ALTER TABLE call_sessions DROP CONSTRAINT IF EXISTS call_sessions_call_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_classes_org_name ON classes(organization_id,name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_org_phone ON students(organization_id,phone);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_org_call_id ON call_sessions(organization_id,call_id) WHERE call_id IS NOT NULL;

-- v4 settings used key as the primary key. Convert it to a tenant-scoped key.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE;
DO $$
DECLARE oid BIGINT;
BEGIN
  SELECT id INTO oid FROM organizations ORDER BY id LIMIT 1;
  UPDATE settings SET organization_id=oid WHERE organization_id IS NULL;
END $$;
ALTER TABLE settings ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
DO $$ BEGIN
  ALTER TABLE settings ADD CONSTRAINT settings_pkey PRIMARY KEY (organization_id,key);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Create memberships and copy v4 roles/class restrictions into the default organization.
CREATE TABLE IF NOT EXISTS organization_members (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','secretary','class_teacher','viewer')),
  class_id BIGINT REFERENCES classes(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,user_id)
);

DO $$
DECLARE oid BIGINT;
DECLARE has_role BOOLEAN;
DECLARE has_class BOOLEAN;
BEGIN
  SELECT id INTO oid FROM organizations ORDER BY id LIMIT 1;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='role') INTO has_role;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='class_id') INTO has_class;
  IF has_role AND has_class THEN
    EXECUTE format('INSERT INTO organization_members(organization_id,user_id,role,class_id,active) SELECT %s,id,role,class_id,active FROM users ON CONFLICT(organization_id,user_id) DO NOTHING', oid);
  ELSIF has_role THEN
    EXECUTE format('INSERT INTO organization_members(organization_id,user_id,role,active) SELECT %s,id,role,active FROM users ON CONFLICT(organization_id,user_id) DO NOTHING', oid);
  ELSE
    EXECUTE format('INSERT INTO organization_members(organization_id,user_id,role,active) SELECT %s,id,''viewer'',active FROM users ON CONFLICT(organization_id,user_id) DO NOTHING', oid);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_yemot_systems_org ON yemot_systems(organization_id);
CREATE INDEX IF NOT EXISTS idx_classes_org ON classes(organization_id);
CREATE INDEX IF NOT EXISTS idx_students_org ON students(organization_id);
CREATE INDEX IF NOT EXISTS idx_calls_org_phone_time ON call_sessions(organization_id,phone,entered_at);
CREATE INDEX IF NOT EXISTS idx_attendance_overrides_org_day ON attendance_overrides(organization_id,day);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log(organization_id,created_at DESC);

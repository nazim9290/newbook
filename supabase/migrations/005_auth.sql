-- ================================================================
-- AgencyOS — Auth Setup
-- Migration 005: triggers to sync auth.users with public.users
-- ================================================================

-- Function: on new auth signup, create or link user record
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agency_id UUID;
  v_role TEXT;
  v_name TEXT;
BEGIN
  -- Check if user was invited (agency_id in metadata)
  v_agency_id := (NEW.raw_user_meta_data->>'agency_id')::UUID;
  v_role := COALESCE(NEW.raw_user_meta_data->>'role', 'counselor');
  v_name := COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1));

  IF v_agency_id IS NOT NULL THEN
    -- Invited user: create user record under existing agency
    INSERT INTO users (auth_user_id, agency_id, name, email, role, branch)
    VALUES (NEW.id, v_agency_id, v_name, NEW.email, v_role, 'Main')
    ON CONFLICT (auth_user_id) DO UPDATE SET email = NEW.email;
  ELSE
    -- New agency signup: create agency + owner user
    INSERT INTO agencies (subdomain, name, email)
    VALUES (
      LOWER(REPLACE(split_part(NEW.email, '@', 1), '.', '-')) || '-' || SUBSTRING(NEW.id::text, 1, 4),
      v_name || '''s Agency',
      NEW.email
    )
    RETURNING id INTO v_agency_id;

    INSERT INTO users (auth_user_id, agency_id, name, email, role, branch)
    VALUES (NEW.id, v_agency_id, v_name, NEW.email, 'owner', 'Main');
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger: fire on new auth user
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Function: on auth user delete, deactivate (not hard delete)
CREATE OR REPLACE FUNCTION handle_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE users SET is_active = false WHERE auth_user_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER on_auth_user_deleted
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_user_delete();

-- Function: updated_at auto-trigger for any table
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Apply updated_at trigger to tables that have the column
CREATE TRIGGER set_agencies_updated_at BEFORE UPDATE ON agencies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_visitors_updated_at BEFORE UPDATE ON visitors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_sponsors_updated_at BEFORE UPDATE ON sponsors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_documents_updated_at BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

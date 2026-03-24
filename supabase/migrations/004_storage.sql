-- ================================================================
-- AgencyOS — Storage Buckets with RLS
-- Migration 004
-- ================================================================

-- Create storage buckets
INSERT INTO storage.buckets (id, name, public) VALUES
  ('templates', 'templates', false),       -- Excel school forms
  ('documents', 'documents', false),       -- Student documents (passport, NID, certs)
  ('generated', 'generated', false),       -- Auto-filled output files
  ('photos', 'photos', true);             -- Student photos (public for display)

-- ================================================================
-- Storage RLS: agency_id folder isolation
-- File paths follow: {agency_id}/{student_id}/{filename}
-- ================================================================

-- TEMPLATES bucket
CREATE POLICY templates_select ON storage.objects FOR SELECT
  USING (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY templates_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY templates_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY templates_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

-- DOCUMENTS bucket
CREATE POLICY documents_storage_select ON storage.objects FOR SELECT
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY documents_storage_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY documents_storage_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY documents_storage_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

-- GENERATED bucket
CREATE POLICY generated_select ON storage.objects FOR SELECT
  USING (bucket_id = 'generated' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY generated_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'generated' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY generated_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'generated' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

-- PHOTOS bucket (public read, agency-scoped write)
CREATE POLICY photos_select ON storage.objects FOR SELECT
  USING (bucket_id = 'photos');  -- public read

CREATE POLICY photos_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'photos' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY photos_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY photos_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

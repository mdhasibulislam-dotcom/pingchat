-- ============================================================
-- PingChat fix: voice-messages bucket + reaction updates
-- Run this whole file ONCE in the Supabase SQL Editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).
--
-- It does two things:
--   1. Creates the missing 'voice-messages' storage bucket (with its
--      read/insert/update/delete policies) so voice messages can be
--      recorded, uploaded and played. Without it, sending a voice
--      message fails with a bucket error.
--   2. Allows changing a reaction: PostgREST upsert (toggle reaction)
--      needs the UPDATE privilege plus an UPDATE policy on
--      message_reactions. Without it, tapping a different emoji fails.
--
-- Safe to re-run: every statement is guarded
-- (ON CONFLICT ... DO UPDATE / DROP POLICY IF EXISTS).
-- ============================================================

-- ---- 1. Reactions: UPDATE grant + update policy ----
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_reactions TO authenticated;

-- PostgREST upsert (toggle reaction) needs UPDATE privilege + policy:
-- without it, changing your reaction to a different emoji fails.
DROP POLICY IF EXISTS "reactions_update_own" ON public.message_reactions;
CREATE POLICY "reactions_update_own" ON public.message_reactions
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---- 2. Storage bucket 'voice-messages' + policies ----

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('voice-messages', 'voice-messages', true, 5242880,
        ARRAY['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-m4a'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;


DROP POLICY IF EXISTS "voice_public_read" ON storage.objects;
CREATE POLICY "voice_public_read" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'voice-messages');
-- Only the owner can upload into their own folder.
DROP POLICY IF EXISTS "voice_insert_own" ON storage.objects;
CREATE POLICY "voice_insert_own" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'voice-messages' AND (storage.foldername(name))[1] = auth.uid()::text
  );
-- Only the owner can replace their own voice file.
DROP POLICY IF EXISTS "voice_update_own" ON storage.objects;
CREATE POLICY "voice_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'voice-messages' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'voice-messages' AND (storage.foldername(name))[1] = auth.uid()::text);
-- Only the owner can delete their own voice file (view-once consume
-- and delete-for-everyone remove the file after deleting the row).
DROP POLICY IF EXISTS "voice_delete_own" ON storage.objects;
CREATE POLICY "voice_delete_own" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'voice-messages' AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- PingChat v2 — fix reactions failing with:
--   "Could not react: there is no unique or exclusion constraint
--    matching the ON CONFLICT specification"
--
-- Cause: the live public.message_reactions table is missing the
-- PRIMARY KEY (message_id, user_id) that database/schema.sql defines.
-- The app upserts with onConflict 'message_id,user_id', and Postgres
-- rejects that when no matching unique constraint exists. (The table
-- was created before the PK was in the schema, and
-- CREATE TABLE IF NOT EXISTS never adds it later.)
--
-- This file is IDEMPOTENT: safe to run again. Run it once in the
-- Supabase Dashboard > SQL Editor > New query.
--
-- What it does:
-- 1. Deletes duplicate reactions (same user + message), keeping one,
--    so the PRIMARY KEY can be created. One reaction per user per
--    message is the app's rule anyway.
-- 2. Adds PRIMARY KEY (message_id, user_id) — but only if the table
--    does not already have a primary key.

-- 1. Drop duplicates, keeping the newest row per (message_id, user_id).
DELETE FROM public.message_reactions a
USING public.message_reactions b
WHERE a.message_id = b.message_id
  AND a.user_id = b.user_id
  AND a.ctid < b.ctid;

-- 2. Add the PRIMARY KEY if the table has none yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.message_reactions'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.message_reactions
      ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (message_id, user_id);
  END IF;
END $$;

-- PingChat v2 — complete database schema for Supabase.
-- Run this in the Supabase Dashboard > SQL Editor > New query.
-- It is IDEMPOTENT: safe to run again on the same project (existing users,
-- conversations and messages are kept). Works on the existing project
-- (https://fonkaiopgphesajcweej.supabase.co) or on a fresh one.
--
-- Tables: profiles, conversations, conversation_participants, messages, calls
-- Functions: get_or_create_conversation, is_username_available
-- Triggers: profiles updated_at, messages -> conversations.last_message_at,
--           auth.users -> auto-create profile row on signup

-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  full_name text NOT NULL DEFAULT '',
  bio text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.conversation_participants (
  conversation_id uuid NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  last_read_at timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES public.conversations (id) ON DELETE SET NULL,
  caller_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  callee_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'video')),
  status text NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing', 'accepted', 'declined', 'missed', 'ended')),
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Helpful indexes (idempotent).
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_participants_user
  ON public.conversation_participants (user_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller_created
  ON public.calls (caller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_callee_created
  ON public.calls (callee_id, created_at DESC);

-- ============================================================
-- 2. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

-- profiles: readable by any signed-in user; only self can insert/update.
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "profiles_insert_self" ON public.profiles;
CREATE POLICY "profiles_insert_self" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;
CREATE POLICY "profiles_update_self" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- conversations: readable by participants.
DROP POLICY IF EXISTS "conversations_select_participant" ON public.conversations;
CREATE POLICY "conversations_select_participant" ON public.conversations
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.conversation_participants p
            WHERE p.conversation_id = conversations.id AND p.user_id = auth.uid())
  );
DROP POLICY IF EXISTS "conversations_insert_auth" ON public.conversations;
CREATE POLICY "conversations_insert_auth" ON public.conversations
  FOR INSERT TO authenticated WITH CHECK (true);

-- conversation_participants: readable by self + other participants;
-- insertable by self (used when creating a conversation).
DROP POLICY IF EXISTS "participants_select" ON public.conversation_participants;
CREATE POLICY "participants_select" ON public.conversation_participants
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.conversation_participants p2
               WHERE p2.conversation_id = conversation_participants.conversation_id
               AND p2.user_id = auth.uid())
  );
DROP POLICY IF EXISTS "participants_insert_self" ON public.conversation_participants;
CREATE POLICY "participants_insert_self" ON public.conversation_participants
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "participants_update_self" ON public.conversation_participants;
CREATE POLICY "participants_update_self" ON public.conversation_participants
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- messages: readable by conversation participants; insertable by participants.
DROP POLICY IF EXISTS "messages_select_participant" ON public.messages;
CREATE POLICY "messages_select_participant" ON public.messages
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.conversation_participants p
            WHERE p.conversation_id = messages.conversation_id AND p.user_id = auth.uid())
  );
DROP POLICY IF EXISTS "messages_insert_participant" ON public.messages;
CREATE POLICY "messages_insert_participant" ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.conversation_participants p
                WHERE p.conversation_id = messages.conversation_id AND p.user_id = auth.uid())
  );

-- calls: readable / insertable / updatable by caller or callee only.
DROP POLICY IF EXISTS "calls_select_party" ON public.calls;
CREATE POLICY "calls_select_party" ON public.calls
  FOR SELECT TO authenticated USING (caller_id = auth.uid() OR callee_id = auth.uid());
DROP POLICY IF EXISTS "calls_insert_caller" ON public.calls;
CREATE POLICY "calls_insert_caller" ON public.calls
  FOR INSERT TO authenticated WITH CHECK (caller_id = auth.uid());
DROP POLICY IF EXISTS "calls_update_party" ON public.calls;
CREATE POLICY "calls_update_party" ON public.calls
  FOR UPDATE TO authenticated USING (caller_id = auth.uid() OR callee_id = auth.uid())
  WITH CHECK (caller_id = auth.uid() OR callee_id = auth.uid());

-- ============================================================
-- 3. FUNCTIONS
-- ============================================================

-- Find the 1-to-1 conversation with another user, or create it.
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv_id uuid;
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_user_id = v_me THEN RAISE EXCEPTION 'cannot start a conversation with yourself'; END IF;

  SELECT c.id INTO v_conv_id
  FROM conversations c
  WHERE EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = c.id AND p.user_id = v_me)
    AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = c.id AND p.user_id = p_user_id)
    AND (SELECT count(*) FROM conversation_participants p WHERE p.conversation_id = c.id) = 2
  LIMIT 1;

  IF v_conv_id IS NULL THEN
    INSERT INTO conversations DEFAULT VALUES RETURNING id INTO v_conv_id;
    INSERT INTO conversation_participants (conversation_id, user_id)
    VALUES (v_conv_id, v_me), (v_conv_id, p_user_id);
  END IF;
  RETURN v_conv_id;
END;
$$;

-- Username availability check. SECURITY DEFINER so it also works before
-- signup (when the caller is still anonymous).
CREATE OR REPLACE FUNCTION public.is_username_available(p_username text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM profiles WHERE username = lower(p_username));
$$;

-- ============================================================
-- 4. TRIGGERS
-- ============================================================

-- Keep profiles.updated_at fresh.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Keep conversations.last_message_at fresh on every new message.
CREATE OR REPLACE FUNCTION public.on_message_created()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_last_message_at ON public.messages;
CREATE TRIGGER messages_last_message_at
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.on_message_created();

-- Auto-create a profile row when a user signs up (the app also creates one
-- as a fallback in js/auth.js ensureProfile(), so a failure here is not fatal).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username text;
BEGIN
  v_username := lower(coalesce(NEW.raw_user_meta_data ->> 'username', ''));
  IF v_username = '' OR v_username !~ '^[a-z0-9_]{3,20}$' THEN
    v_username := 'user_' || substr(replace(NEW.id::text, '-', ''), 1, 10);
  END IF;
  BEGIN
    INSERT INTO public.profiles (id, username, full_name)
    VALUES (NEW.id, v_username, coalesce(NEW.raw_user_meta_data ->> 'full_name', ''))
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO public.profiles (id, username, full_name)
    VALUES (NEW.id, 'user_' || substr(replace(NEW.id::text, '-', ''), 1, 10),
            coalesce(NEW.raw_user_meta_data ->> 'full_name', ''))
    ON CONFLICT (id) DO NOTHING;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 5. REALTIME (guarded: safe if the table is already added)
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.messages';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'calls'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.calls';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversation_participants'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_participants';
  END IF;
END $$;

-- ============================================================
-- 6. MIGRATION FROM THE OLD PINGCHAT SCHEMA (v1)
-- The first PingChat used different names: conversation_members
-- (not conversation_participants), messages.content (not body),
-- conversations.pair_key (NOT NULL) and no last_message_at.
-- If this file runs on the existing project, this section adapts that
-- schema so the new app works AND old users, conversations, messages
-- and read positions carry over. On a fresh project every block is
-- safely skipped (the objects do not exist there).
-- ============================================================

-- conversations: add the new column; allow pair_key to be NULL so the
-- new get_or_create_conversation (INSERT ... DEFAULT VALUES) works.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'pair_key') THEN
    EXECUTE 'ALTER TABLE public.conversations ALTER COLUMN pair_key DROP NOT NULL';
  END IF;
END $$;

-- messages: the new app uses "body"; the old app used "content"
-- (NOT NULL) with a length check. Add body, copy old text over,
-- relax content, drop the old length check, then keep the two
-- columns in sync for any client, old or new.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_content_len;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'content') THEN
    EXECUTE 'UPDATE public.messages SET body = content WHERE body IS NULL AND content IS NOT NULL';
    EXECUTE 'ALTER TABLE public.messages ALTER COLUMN content DROP NOT NULL';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.sync_message_body()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS NULL THEN NEW.body := NEW.content; END IF;
  IF NEW.content IS NULL THEN NEW.content := NEW.body; END IF;
  IF NEW.body IS NULL THEN NEW.body := ''; END IF;
  IF NEW.content IS NULL THEN NEW.content := ''; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_sync_body ON public.messages;
CREATE TRIGGER messages_sync_body
  BEFORE INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.sync_message_body();

-- conversation_participants: copy memberships from the old table so
-- old conversations keep working in the new app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'conversation_members') THEN
    EXECUTE 'INSERT INTO public.conversation_participants (conversation_id, user_id)
             SELECT conversation_id, user_id FROM public.conversation_members
             ON CONFLICT (conversation_id, user_id) DO NOTHING';
  END IF;
END $$;

-- Read positions: restore last_read_at from the old conversation_reads table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'conversation_reads') THEN
    EXECUTE 'UPDATE public.conversation_participants p SET last_read_at = r.last_read_at
             FROM public.conversation_reads r
             WHERE r.conversation_id = p.conversation_id AND r.user_id = p.user_id';
  END IF;
END $$;

-- Backfill last_message_at from the latest message in each conversation.
UPDATE public.conversations c SET last_message_at = m.max_created
FROM (SELECT conversation_id, max(created_at) AS max_created FROM public.messages GROUP BY conversation_id) m
WHERE m.conversation_id = c.id AND c.last_message_at IS NULL;

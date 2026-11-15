-- PingChat v2 — complete database schema for Supabase.
-- Run this in the Supabase Dashboard > SQL Editor > New query.
-- It is IDEMPOTENT: safe to run again on the same project (existing users,
-- conversations and messages are kept). Works on the existing project
-- (https://fonkaiopgphesajcweej.supabase.co) or on a fresh one.
--
-- Tables: profiles, conversations, conversation_participants, messages, calls,
--         friendships
-- Functions: get_or_create_conversation, is_username_available,
--            send_friend_request, respond_friend_request, friendship_status
-- Triggers: profiles updated_at, messages -> conversations.last_message_at,
--           auth.users -> auto-create profile row on signup
-- Storage: 'avatars' bucket (public, 2 MB, images only) for profile photos

-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  full_name text NOT NULL DEFAULT '',
  bio text,
  avatar_url text,
  is_public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Existing projects created before is_public existed get the column here.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;

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

  -- Friend system: you can only chat with someone after a friend request
  -- has been accepted. (The §6/§7 migration auto-creates accepted
  -- friendships for pairs who already had a conversation, so old chats
  -- keep working.)
  IF NOT EXISTS (SELECT 1 FROM friendships
                 WHERE status = 'accepted'
                   AND ((requester_id = v_me AND addressee_id = p_user_id)
                     OR (requester_id = p_user_id AND addressee_id = v_me))) THEN
    RAISE EXCEPTION 'not friends yet — send a friend request first';
  END IF;

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

-- Friendships for old chats: every pair that already shares a 1-to-1
-- conversation becomes friends automatically, so their chats keep working
-- under the friend system. Guarded: on the very first run of this file the
-- friendships table is only created in §7 (below), so this block is skipped
-- then and §7 runs the same backfill right after creating the table. On
-- later runs both blocks are no-ops thanks to the NOT EXISTS check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'friendships') THEN
    EXECUTE $q$
      WITH pairs AS (
        SELECT a.user_id AS u1, b.user_id AS u2
        FROM public.conversation_participants a
        JOIN public.conversation_participants b
          ON b.conversation_id = a.conversation_id AND b.user_id > a.user_id
        WHERE (SELECT count(*) FROM public.conversation_participants p
               WHERE p.conversation_id = a.conversation_id) = 2
      )
      INSERT INTO public.friendships (requester_id, addressee_id, status)
      SELECT LEAST(u1, u2), GREATEST(u1, u2), 'accepted' FROM pairs
      WHERE NOT EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE LEAST(f.requester_id, f.addressee_id) = LEAST(u1, u2)
          AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(u1, u2)
      )
    $q$;
  END IF;
END $$;

-- ============================================================
-- 7. FRIEND SYSTEM + PRIVACY + PROFILE PHOTO STORAGE
-- Nobody can message or call anyone until a friend request is sent and
-- accepted. get_or_create_conversation (§3) enforces this.
-- profiles.is_public: public profiles show full info to everyone;
-- private profiles show full info only to friends or while a friend
-- request is pending (either direction) — the app enforces this when
-- rendering. The directory list always shows avatar + name + username.
-- Profile photos live in the public 'avatars' Storage bucket (free tier).
-- ============================================================

-- profiles.is_public for projects created before this column existed.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;

-- ---- friendships table ----
CREATE TABLE IF NOT EXISTS public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_id <> addressee_id)
);
-- One friendship row per pair, in either direction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair
  ON public.friendships ((LEAST(requester_id, addressee_id)), (GREATEST(requester_id, addressee_id)));
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON public.friendships (requester_id);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON public.friendships (addressee_id);

-- Keep friendships.updated_at fresh.
DROP TRIGGER IF EXISTS friendships_updated_at ON public.friendships;
CREATE TRIGGER friendships_updated_at
  BEFORE UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---- friendships RLS ----
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
-- Either side of the friendship can read the row.
DROP POLICY IF EXISTS "friendships_select_party" ON public.friendships;
CREATE POLICY "friendships_select_party" ON public.friendships
  FOR SELECT TO authenticated USING (requester_id = auth.uid() OR addressee_id = auth.uid());
-- Only the requester can create a row, and only as themselves.
DROP POLICY IF EXISTS "friendships_insert_requester" ON public.friendships;
CREATE POLICY "friendships_insert_requester" ON public.friendships
  FOR INSERT TO authenticated WITH CHECK (requester_id = auth.uid());
-- Only the addressee can accept/decline a pending row.
DROP POLICY IF EXISTS "friendships_update_addressee" ON public.friendships;
CREATE POLICY "friendships_update_addressee" ON public.friendships
  FOR UPDATE TO authenticated
  USING (addressee_id = auth.uid() AND status = 'pending')
  WITH CHECK (addressee_id = auth.uid());
-- Only the requester can delete their own pending row (cancel request).
DROP POLICY IF EXISTS "friendships_delete_requester" ON public.friendships;
CREATE POLICY "friendships_delete_requester" ON public.friendships
  FOR DELETE TO authenticated USING (requester_id = auth.uid() AND status = 'pending');

-- ---- friendship functions ----
-- Send a friend request. Rejects self-requests and duplicate rows; a
-- previous 'declined' row is removed first so a fresh request is allowed.
CREATE OR REPLACE FUNCTION public.send_friend_request(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_user_id = v_me THEN RAISE EXCEPTION 'cannot send a friend request to yourself'; END IF;
  DELETE FROM friendships
  WHERE status = 'declined'
    AND ((requester_id = v_me AND addressee_id = p_user_id)
      OR (requester_id = p_user_id AND addressee_id = v_me));
  IF EXISTS (SELECT 1 FROM friendships
             WHERE (requester_id = v_me AND addressee_id = p_user_id)
                OR (requester_id = p_user_id AND addressee_id = v_me)) THEN
    RAISE EXCEPTION 'a friend request already exists for this person';
  END IF;
  INSERT INTO friendships (requester_id, addressee_id, status)
  VALUES (v_me, p_user_id, 'pending');
END;
$$;

-- Accept (p_accept = true) or decline a pending request. Only the
-- addressee of the request can call this, and only on a pending row.
CREATE OR REPLACE FUNCTION public.respond_friend_request(p_requester_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  UPDATE friendships
  SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END
  WHERE requester_id = p_requester_id AND addressee_id = v_me AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'no pending friend request from this person'; END IF;
END;
$$;

-- 'none' | 'pending_out' | 'pending_in' | 'friends' | 'declined'
-- from the caller's point of view.
CREATE OR REPLACE FUNCTION public.friendship_status(p_user_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN f.status = 'accepted' THEN 'friends'
      WHEN f.status = 'pending' AND f.requester_id = auth.uid() THEN 'pending_out'
      WHEN f.status = 'pending' AND f.addressee_id = auth.uid() THEN 'pending_in'
      WHEN f.status = 'declined' THEN 'declined'
      ELSE 'none'
    END
    FROM friendships f
    WHERE (f.requester_id = auth.uid() AND f.addressee_id = p_user_id)
       OR (f.requester_id = p_user_id AND f.addressee_id = auth.uid())
    LIMIT 1
  ), 'none');
$$;

-- ---- friendships realtime (for the live People badge) ----
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'friendships'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships';
  END IF;
END $$;

-- ---- backfill accepted friendships for existing 1-to-1 conversations ----
-- Same backfill as §6 (which runs first and skips when the table does not
-- exist yet). Here the table exists, so this covers the first run too.
WITH pairs AS (
  SELECT a.user_id AS u1, b.user_id AS u2
  FROM public.conversation_participants a
  JOIN public.conversation_participants b
    ON b.conversation_id = a.conversation_id AND b.user_id > a.user_id
  WHERE (SELECT count(*) FROM public.conversation_participants p
         WHERE p.conversation_id = a.conversation_id) = 2
)
INSERT INTO public.friendships (requester_id, addressee_id, status)
SELECT LEAST(u1, u2), GREATEST(u1, u2), 'accepted' FROM pairs
WHERE NOT EXISTS (
  SELECT 1 FROM public.friendships f
  WHERE LEAST(f.requester_id, f.addressee_id) = LEAST(u1, u2)
    AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(u1, u2)
);

-- ============================================================
-- 8. STORAGE BUCKET 'avatars' — profile photos
-- Public bucket, 2 MB limit, images only. Files live at
-- <userId>/<timestamp>.<ext>; each user can only write inside their
-- own folder. Re-running is safe (ON CONFLICT ... DO UPDATE).
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 2097152,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Anyone can read profile photos.
DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
CREATE POLICY "avatars_public_read" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'avatars');
-- Only the owner can upload into their own folder.
DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
CREATE POLICY "avatars_insert_own" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text
  );
-- Only the owner can replace their own photo.
DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
CREATE POLICY "avatars_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
-- Only the owner can delete their own photo.
DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;
CREATE POLICY "avatars_delete_own" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text
  );

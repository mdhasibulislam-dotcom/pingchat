-- PingChat v2 — automatic push notifications via OneSignal.
-- Run this in the Supabase Dashboard > SQL Editor > New query.
-- It is IDEMPOTENT: safe to run again on the same project.
--
-- WHAT IT DOES
-- 1. New chat message  -> the other participant's phone gets a push
--    notification ("<sender name>" / message preview, or "Voice message").
--    Style: the sender's profile photo is the notification icon, and the
--    notification has two buttons — Reply (opens the chat with the
--    composer focused) and Open chat.
-- 2. New call (status 'ringing') -> the callee's phone gets a push
--    notification ("Incoming audio/video call from <caller name>"),
--    with the caller's profile photo as the icon.
-- The push is sent from the database itself (Postgres trigger + pg_net),
-- so it works even when the recipient's app is closed. No server needed.
--
-- SETUP — FRESH INSTALL ONLY (first time ever)
-- 1. OneSignal dashboard > Settings > Keys & IDs > API keys > "Add key"
--    (create an APP API key). Copy the key value — it starts with
--    "os_v2_app_" and is shown ONLY ONCE. (The "Key ID" column is NOT
--    the key; using it gives a 401 error.)
-- 2. Run this line once in the SQL Editor (put your key in place of ...):
--      INSERT INTO public.onesignal_config(api_key) VALUES ('os_v2_app_...');
-- 3. Then run this WHOLE file once.
-- ALREADY RUN BEFORE? Just paste this whole file and click Run. The key
-- is saved in the database and carried over automatically — you do NOT
-- have to paste the key again.
-- NEVER commit the real key to git. If the key leaks, rotate it in
-- OneSignal (Settings > Keys & IDs), delete the saved key with
--   DELETE FROM public.onesignal_config;
-- and save the new key with the INSERT line above, then re-run this file.
--
-- HOW TO CHECK IT WORKED
-- Send a test message from one account to another, wait a few seconds,
-- then run:  SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
-- A 200 response with a OneSignal notification id in the body = it worked.
-- 401 = wrong API key. 400 = bad request body.
--
-- HOW TO TURN IT OFF (run these lines in the SQL Editor):
--   DROP TRIGGER IF EXISTS messages_notify_push ON public.messages;
--   DROP TRIGGER IF EXISTS calls_notify_push ON public.calls;
--   DROP FUNCTION IF EXISTS public.notify_message_push();
--   DROP FUNCTION IF EXISTS public.notify_call_push();
--   DROP FUNCTION IF EXISTS public.onesignal_send_push(text, text, text, jsonb, text, text, jsonb);
--
-- API verified against the official OneSignal docs (2026-11-16):
--   Endpoint: POST https://api.onesignal.com/notifications?c=push
--   Auth:     Authorization: Key <App API key>  (new os_v2_app_ keys)
--             Authorization: Basic <key>         (legacy REST API keys)
--   Body:     app_id, include_aliases.external_id, target_channel "push",
--             headings {"en": ...}, contents {"en": ...}, data {...}, web_url
-- Docs: https://documentation.onesignal.com/reference/push-notification
--       https://documentation.onesignal.com/docs/keys-and-ids

-- ============================================================
-- 1. pg_net — lets Postgres make HTTP calls (free Supabase extension)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ============================================================
-- 0. API KEY STORAGE — the key lives in a tiny table, not in this file.
-- Re-running this file never needs the key pasted again.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.onesignal_config (api_key text);
-- Nobody may read the key through the app API: RLS on, no policies.
-- The push functions below run as the database owner, so they can read it.
ALTER TABLE public.onesignal_config ENABLE ROW LEVEL SECURITY;

-- One-time migration: if this table is empty, copy the key out of the
-- helper function you already ran before (it is stored inside it), so you
-- never have to paste the key again. Safe to run repeatedly.
DO $$
DECLARE
  v_def text;
  v_key text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.onesignal_config) THEN
    RETURN;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'onesignal_send_push'
  ORDER BY p.oid DESC LIMIT 1;
  IF v_def IS NULL THEN
    RETURN;
  END IF;
  v_key := substring(v_def from 'v_api_key[^'']*''([^'']+)''');
  IF v_key IS NOT NULL AND v_key <> '' AND v_key <> 'PASTE_YOUR_ONESIGNAL_REST_API_KEY_HERE' THEN
    INSERT INTO public.onesignal_config(api_key) VALUES (v_key);
  END IF;
END $$;

-- ============================================================
-- 2. HELPER — send one push to one user (by Supabase user id)
-- The app logs each user into OneSignal with their Supabase user id as
-- the external_id (OneSignal.login), so include_aliases.external_id
-- targets exactly that user. The API key is read from
-- public.onesignal_config; if no key is saved yet, this does nothing
-- instead of sending failing requests.
-- A push failure can never break anything: every error is swallowed.
-- ============================================================

-- Drop the old 5-argument helper first: CREATE OR REPLACE cannot change
-- the argument list, so the old version must go before the new one lands.
DROP FUNCTION IF EXISTS public.onesignal_send_push(text, text, text, jsonb, text);

CREATE OR REPLACE FUNCTION public.onesignal_send_push(
  p_external_user_id text,
  p_heading text,
  p_body text,
  p_data jsonb,
  p_web_url text,
  p_icon text DEFAULT NULL,
  p_buttons jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  -- The key is read from public.onesignal_config (saved once, survives
  -- re-runs of this file). The value below is only a fresh-install
  -- fallback and is never used once the table has the key.
  v_api_key text := 'PASTE_YOUR_ONESIGNAL_REST_API_KEY_HERE';
  v_app_id  constant text := 'da3c98f6-d518-41d1-807e-0e8b77c702d6';
  v_auth    text;
  v_payload jsonb;
  v_headers jsonb;
BEGIN
  -- Read the saved key (if any). With no rows SELECT INTO leaves NULL.
  SELECT api_key INTO v_api_key FROM public.onesignal_config LIMIT 1;
  -- Not configured yet: do nothing.
  IF v_api_key IS NULL OR v_api_key = 'PASTE_YOUR_ONESIGNAL_REST_API_KEY_HERE' OR v_api_key = '' THEN
    RETURN;
  END IF;

  -- New keys (os_v2_app_...) use "Key", legacy REST API keys use "Basic".
  v_auth := CASE WHEN v_api_key LIKE 'os_v2_%' THEN 'Key ' || v_api_key
                 ELSE 'Basic ' || v_api_key END;

  v_payload := jsonb_build_object(
    'app_id', v_app_id,
    'include_aliases', jsonb_build_object('external_id', jsonb_build_array(p_external_user_id)),
    'target_channel', 'push',
    'name', 'PingChat',
    'headings', jsonb_build_object('en', p_heading),
    'contents', jsonb_build_object('en', p_body),
    'data', COALESCE(p_data, '{}'::jsonb)
  );
  -- Tapping the notification opens the app (chat, or calls list).
  IF p_web_url IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object('web_url', p_web_url);
  END IF;
  -- Style 1: the sender's photo as the notification icon (Chrome web push).
  -- Only a real https URL is sent; otherwise OneSignal uses the default icon.
  IF p_icon IS NOT NULL AND p_icon <> '' THEN
    v_payload := v_payload || jsonb_build_object('chrome_web_icon', p_icon);
  END IF;
  -- Style 3: action buttons (Chrome web push supports up to 2).
  IF p_buttons IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object('web_buttons', p_buttons);
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', v_auth
  );

  -- pg_net is async: this only queues the request, it never waits for
  -- OneSignal, so it cannot slow down the message/call insert.
  -- NOTE: pg_net's functions live in the `net` schema (not `extensions`),
  -- even when the extension is installed WITH SCHEMA extensions.
  PERFORM net.http_post(
    'https://api.onesignal.com/notifications?c=push',
    v_payload,
    '{}'::jsonb,
    v_headers
  );
EXCEPTION WHEN OTHERS THEN
  -- Never let a push failure surface: the caller must not fail.
  NULL;
END;
$$;

-- ============================================================
-- 3. NEW MESSAGE -> push the other participant(s)
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_message_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_sender_name text;
  v_sender_icon text;
  v_preview text;
  v_chat_url text;
  v_buttons jsonb;
  r record;
BEGIN
  -- Sender display name + photo: full name, else username, else "Someone".
  SELECT COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(username), ''), 'Someone'),
         NULLIF(btrim(avatar_url), '')
    INTO v_sender_name, v_sender_icon
    FROM public.profiles WHERE id = NEW.sender_id;
  -- If the sender has no profile row at all (should not happen), fall back.
  v_sender_name := COALESCE(v_sender_name, 'Someone');
  -- Only a public https photo can be a notification icon.
  IF v_sender_icon IS NOT NULL AND v_sender_icon NOT LIKE 'https://%' THEN
    v_sender_icon := NULL;
  END IF;

  v_preview := CASE WHEN NEW.kind = 'voice' THEN 'Voice message'
                    ELSE left(COALESCE(NEW.body, ''), 100) END;
  IF v_preview = '' THEN
    v_preview := 'New message';
  END IF;

  v_chat_url := 'https://mdhasibulislam-dotcom.github.io/pingchat/#/chat/' || NEW.conversation_id::text;
  -- Reply opens the chat with the composer focused; Open chat just opens it.
  v_buttons := jsonb_build_array(
    jsonb_build_object('id', 'reply', 'text', 'Reply', 'url', 'https://mdhasibulislam-dotcom.github.io/pingchat/?reply=1#/chat/' || NEW.conversation_id::text),
    jsonb_build_object('id', 'open', 'text', 'Open chat', 'url', v_chat_url)
  );

  -- Every other participant of the conversation (1-to-1 chats have one).
  FOR r IN
    SELECT user_id FROM public.conversation_participants
    WHERE conversation_id = NEW.conversation_id
      AND user_id <> NEW.sender_id
  LOOP
    PERFORM public.onesignal_send_push(
      r.user_id::text,
      v_sender_name,
      v_preview,
      jsonb_build_object(
        'type', 'message',
        'conversation_id', NEW.conversation_id::text,
        'sender_id', NEW.sender_id::text
      ),
      v_chat_url,
      v_sender_icon,
      v_buttons
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A push failure must NEVER block or roll back the message insert.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_notify_push ON public.messages;
CREATE TRIGGER messages_notify_push
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_message_push();

-- ============================================================
-- 4. NEW CALL (ringing) -> push the callee
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_call_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_name text;
  v_caller_icon text;
  v_text text;
BEGIN
  -- Only the initial ringing row notifies. Status changes afterwards
  -- (accepted / declined / missed / ended) do not send another push.
  IF NEW.status <> 'ringing' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(username), ''), 'Someone'),
         NULLIF(btrim(avatar_url), '')
    INTO v_caller_name, v_caller_icon
    FROM public.profiles WHERE id = NEW.caller_id;
  -- If the caller has no profile row at all (should not happen), fall back.
  v_caller_name := COALESCE(v_caller_name, 'Someone');
  -- Only a public https photo can be a notification icon.
  IF v_caller_icon IS NOT NULL AND v_caller_icon NOT LIKE 'https://%' THEN
    v_caller_icon := NULL;
  END IF;

  v_text := CASE WHEN NEW.kind = 'video'
                 THEN 'Incoming video call from ' || v_caller_name
                 ELSE 'Incoming audio call from ' || v_caller_name END;

  PERFORM public.onesignal_send_push(
    NEW.callee_id::text,
    v_caller_name,
    v_text,
    jsonb_build_object(
      'type', 'call',
      'call_id', NEW.id::text,
      'kind', NEW.kind
    ),
    'https://mdhasibulislam-dotcom.github.io/pingchat/#/calls',
    v_caller_icon,
    NULL
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A push failure must NEVER block or roll back the call insert.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calls_notify_push ON public.calls;
CREATE TRIGGER calls_notify_push
  AFTER INSERT ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.notify_call_push();

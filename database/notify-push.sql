-- PingChat v2 — automatic push notifications via OneSignal.
-- Run this in the Supabase Dashboard > SQL Editor > New query.
-- It is IDEMPOTENT: safe to run again on the same project.
--
-- WHAT IT DOES
-- 1. New chat message  -> the other participant's phone gets a push
--    notification ("<sender name>" / message preview, or "Voice message").
-- 2. New call (status 'ringing') -> the callee's phone gets a push
--    notification ("Incoming audio/video call from <caller name>").
-- The push is sent from the database itself (Postgres trigger + pg_net),
-- so it works even when the recipient's app is closed. No server needed.
--
-- SETUP — DO THIS ONCE, BEFORE RUNNING THE FILE
-- 1. OneSignal dashboard > Settings > Keys & IDs > API keys > "Add key"
--    (create an APP API key). Copy the key value — it starts with
--    "os_v2_app_" and is shown ONLY ONCE. (The "Key ID" column is NOT
--    the key; using it gives a 401 error.)
-- 2. Replace ONLY the placeholder 'PASTE_YOUR_ONESIGNAL_REST_API_KEY_HERE'
--    in the function below with that key value.
-- 3. Run this WHOLE file once in the Supabase SQL Editor.
-- NEVER commit the real key to git. If the key leaks, rotate it in
-- OneSignal (Settings > Keys & IDs) and re-run this file with the new key.
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
--   DROP FUNCTION IF EXISTS public.onesignal_send_push(text, text, text, jsonb, text);
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
-- 2. HELPER — send one push to one user (by Supabase user id)
-- The app logs each user into OneSignal with their Supabase user id as
-- the external_id (OneSignal.login), so include_aliases.external_id
-- targets exactly that user. If the API key placeholder was never
-- replaced, this does nothing instead of sending failing requests.
-- A push failure can never break anything: every error is swallowed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.onesignal_send_push(
  p_external_user_id text,
  p_heading text,
  p_body text,
  p_data jsonb,
  p_web_url text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  -- >>>>>> REPLACE ONLY THIS PLACEHOLDER with your OneSignal App API key <<<<<<
  v_api_key constant text := 'PASTE_YOUR_ONESIGNAL_REST_API_KEY_HERE';
  v_app_id  constant text := 'da3c98f6-d518-41d1-807e-0e8b77c702d6';
  v_auth    text;
  v_payload jsonb;
  v_headers jsonb;
BEGIN
  -- Not configured yet: do nothing.
  IF v_api_key = 'PASTE_YOUR_ONESIGNAL_REST_API_KEY_HERE' OR v_api_key = '' THEN
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
  v_preview text;
  r record;
BEGIN
  -- Sender display name: full name, else username, else "Someone".
  SELECT COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(username), ''), 'Someone')
    INTO v_sender_name
    FROM public.profiles WHERE id = NEW.sender_id;
  -- If the sender has no profile row at all (should not happen), fall back.
  v_sender_name := COALESCE(v_sender_name, 'Someone');

  v_preview := CASE WHEN NEW.kind = 'voice' THEN 'Voice message'
                    ELSE left(COALESCE(NEW.body, ''), 100) END;
  IF v_preview = '' THEN
    v_preview := 'New message';
  END IF;

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
      'https://mdhasibulislam-dotcom.github.io/pingchat/#/chat/' || NEW.conversation_id::text
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
  v_text text;
BEGIN
  -- Only the initial ringing row notifies. Status changes afterwards
  -- (accepted / declined / missed / ended) do not send another push.
  IF NEW.status <> 'ringing' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(username), ''), 'Someone')
    INTO v_caller_name
    FROM public.profiles WHERE id = NEW.caller_id;
  -- If the caller has no profile row at all (should not happen), fall back.
  v_caller_name := COALESCE(v_caller_name, 'Someone');

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
    'https://mdhasibulislam-dotcom.github.io/pingchat/#/calls'
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

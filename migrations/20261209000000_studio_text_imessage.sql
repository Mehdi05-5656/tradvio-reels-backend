-- Clone8 Studio: Text Clone8 on iMessage (a Sendblue line; src/text-bot/sendblue.ts). The chats table, inbox, codes and
-- log already carry a channel; only the links table limited it to Telegram. Additive: Telegram rows are unchanged, and
-- nothing writes an iMessage row until STUDIO_TEXT_IMESSAGE_ENABLED=true is set.
BEGIN;
ALTER TABLE public.studio_text_links DROP CONSTRAINT IF EXISTS studio_text_links_channel_check;
ALTER TABLE public.studio_text_links ADD CONSTRAINT studio_text_links_channel_check CHECK (channel IN ('telegram', 'imessage'));
COMMIT;

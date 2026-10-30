-- Clone8 Studio: audio instruments. Job outputs may now be sound files (MP3) and transcripts (text, SRT); the outputs
-- bucket accepts those types. Uploads are unchanged (video and pictures only).
BEGIN;
UPDATE storage.buckets SET allowed_mime_types = ARRAY['video/mp4', 'image/jpeg', 'application/zip', 'audio/mpeg', 'text/plain']
WHERE id = 'studio-outputs';
COMMIT;

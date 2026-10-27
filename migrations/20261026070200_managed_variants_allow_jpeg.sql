-- The archive step (src/library-archive.ts) stores a poster frame and a 4-frame strip as JPEG under
-- archive/<variant>/ in the managed-variants bucket before it deletes the rendered MP4. The bucket only
-- allowed video/mp4, so every archive attempt failed with "mime type image/jpeg is not supported" and
-- (by design) nothing was deleted. Allow JPEG alongside MP4.
update storage.buckets
   set allowed_mime_types = array['video/mp4', 'image/jpeg']
 where id = 'managed-variants';

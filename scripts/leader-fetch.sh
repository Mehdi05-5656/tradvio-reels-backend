#!/usr/bin/env bash
# Fetch @tradvio full IG history via ScrapeCreators.
# Outputs newline-delimited JSON where each line is one enriched post.
# Uses x-api-key: dummy (proxy injects the real key).
set -euo pipefail
HANDLE="${1:-tradvio}"
OUT="${2:-/tmp/leader_tradvio_posts.jsonl}"
: > "$OUT"

CURSOR=""
declare -a ALL_SHORTCODES=()

# Paginate listing
for i in 1 2 3 4 5 6 7 8 9 10; do
  URL="https://api.scrapecreators.com/v1/instagram/user/posts?handle=${HANDLE}"
  if [ -n "$CURSOR" ]; then URL="${URL}&cursor=${CURSOR}"; fi
  RESP=$(curl -sS "$URL" -H "x-api-key: dummy")
  # Extract shortcodes
  SCS=$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for p in d.get('posts', []):
    n = p.get('node', {})
    sc = n.get('shortcode')
    if sc: print(sc)
")
  while IFS= read -r sc; do
    [ -n "$sc" ] && ALL_SHORTCODES+=("$sc")
  done <<< "$SCS"
  CURSOR=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cursor') or '')")
  CRED=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('credits_remaining','?'))")
  echo "[listing] page $i: total_shortcodes=${#ALL_SHORTCODES[@]} credits_remaining=$CRED cursor=$([ -n "$CURSOR" ] && echo yes || echo END)" >&2
  [ -z "$CURSOR" ] && break
  sleep 0.3
done

echo "[enrich] fetching detail for ${#ALL_SHORTCODES[@]} posts" >&2

# Per-post enrichment
IDX=0
for SC in "${ALL_SHORTCODES[@]}"; do
  IDX=$((IDX+1))
  URL="https://api.scrapecreators.com/v1/instagram/post?url=https%3A%2F%2Fwww.instagram.com%2Freel%2F${SC}%2F"
  RESP=$(curl -sS "$URL" -H "x-api-key: dummy")
  # Extract flat JSON with the fields we care about
  echo "$RESP" | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
m = d.get('data', {}).get('xdt_shortcode_media', {}) or {}
if not m:
    sys.exit(0)
caption = None
edges = m.get('edge_media_to_caption', {}).get('edges', [])
if edges:
    caption = edges[0].get('node', {}).get('text')
hashtags = []
if caption:
    hashtags = sorted(set(t.lower() for t in re.findall(r'#[\w\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]+', caption)))
row = {
    'external_post_id': str(m.get('id') or '$SC'),
    'shortcode': '$SC',
    'post_url': f'https://www.instagram.com/reel/$SC/',
    'posted_at': m.get('taken_at_timestamp') or m.get('created_at'),
    'caption': caption,
    'hashtags': hashtags,
    'media_type': 'video' if m.get('is_video') else 'image',
    'product_type': m.get('product_type'),
    'video_duration': m.get('video_duration'),
    'thumbnail_url': m.get('thumbnail_src'),
    'media_url': m.get('video_url') or m.get('display_url'),
    'video_views': m.get('video_play_count') or 0,
    'likes': (m.get('edge_media_preview_like') or {}).get('count') or 0,
    'comments': m.get('comment_count') or 0,
}
print(json.dumps(row))
" >> "$OUT"
  if [ $((IDX % 10)) -eq 0 ]; then
    echo "  ...enriched $IDX / ${#ALL_SHORTCODES[@]}" >&2
  fi
  sleep 0.2
done

echo "[done] wrote $(wc -l < "$OUT") posts to $OUT" >&2

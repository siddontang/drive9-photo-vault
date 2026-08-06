# PhotoVault — powered by drive9

A photo and video library demo built on top of [drive9.ai](https://drive9.ai).

Upload photos and short videos, let drive9 extract image/video semantics asynchronously, then search and organize media by what is inside them — not just by filename.

## Live Demo

- Website: https://drive9-photo-vault.netlify.app
- OpenAPI: https://drive9-photo-api.siddontang.workers.dev/openapi.json
- Repository: https://github.com/siddontang/drive9-photo-vault

## What it does

- Upload photos and videos (MP4, MOV, WebM, AVI, MKV) from desktop or mobile
- Store original files directly in drive9
- Use drive9 semantic metadata/OCR for captions, tags, and search (images and videos)
- Search by visible text, objects, topics, filenames, notes, albums, and tags
- Show compact photo summaries with `show more / show less`
- Show folded tag lists with `+N more`
- Favorite and delete photos
- Create and revoke unguessable, read-only links for one photo or video
- Detect duplicate uploads by SHA-256 checksum
- Display upload/indexing progress
- Expose a Cloudflare Worker OpenAPI gateway

## Architecture

```text
Browser / Netlify React app
        |
        v
Cloudflare Worker API
        |
        +--> Cloudflare Queue (video share preparation)
        |
        v
drive9 filesystem
  /photovault/index.json       metadata index
  /photovault/photos/*         original image/video files
```

Important design choice: the app does **not** use Cloudflare R2, KV, or Workers AI for storage/tagging. drive9 is the source of truth for files and media semantics.

## How search works

1. User uploads a photo or video through the website.
2. The Worker writes the original file into drive9 under `/photovault/photos/`.
3. drive9 asynchronously analyzes the file (image semantics/OCR, or video visual extraction) and exposes metadata via `?stat=1`.
4. The Worker refreshes metadata from drive9 and compacts it into `/photovault/index.json`.
5. For a non-empty query, the Worker calls drive9's scoped `grep` search on `/photovault/photos/`; drive9 combines full-text and semantic ranking.
6. The Worker maps the ranked drive9 paths back to the compact PhotoVault metadata and applies tag, owner, and favorite filters.
7. The Worker reranks only those drive9 candidates with structured caption/tag fields (ahead of description/OCR matches) and returns at most 12 results. It never adds a path that drive9 did not return.

Because drive9 analysis is async, a newly uploaded file may first appear with `drive9 analyzing...`; tags/search metadata usually appear after refresh/search a few seconds later. Video analysis typically takes longer than image analysis.

## API endpoints

Base URL:

```text
https://drive9-photo-api.siddontang.workers.dev
```

Endpoints:

- `GET /api/health`
- `GET /api/photos?q=&tag=&owner=&favorite=`
- `POST /api/photos` streaming raw-body upload (legacy multipart remains compatible up to 25 MiB)
- `PATCH /api/photos/:id`
- `DELETE /api/photos/:id`
- `POST /api/photos/:id/share`
- `DELETE /api/photos/:id/share`
- `GET /api/photos/:id/file`
- `GET /api/shares/:token`
- `GET /api/shares/:token/file`
- `GET /api/shares/:token/poster`
- `GET /api/collections`
- `GET /openapi.json`

## Local development

```bash
# install dependencies
npm --prefix worker install
npm --prefix web install

# run web locally
npm --prefix web run dev

# run worker locally
npm --prefix worker run dev
```

For production, the Worker needs these secrets/config values:

- `DRIVE9_API_KEY` — stored as a Cloudflare Worker secret
- `DRIVE9_SERVER` — defaults to `https://api.drive9.ai`

The Netlify web app uses:

- `VITE_API_BASE=https://drive9-photo-api.siddontang.workers.dev`

## Deployment

Deployment is automated with GitHub Actions.

On every push to `main`:

1. Deploy Cloudflare Worker
2. Build and deploy Netlify website

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` — must be able to deploy Workers and create/read Queues
- `NETLIFY_AUTH_TOKEN`
- `NETLIFY_SITE_ID`

Workflow file:

```text
.github/workflows/deploy.yml
```

## Notes / limitations

- drive9 semantic extraction is asynchronous, so tags are eventually consistent.
- The app stores a compact metadata index to avoid making drive9 embed a huge JSON file.
- This is a demo, not a full multi-user auth product yet.
- Current ownership is a lightweight browser-local `guest-*` id.
- The gallery remains a public demo rather than a complete account/auth product. Share links use unguessable tokens, expose only one media item, and can be revoked; they are not a replacement for future authenticated library access.
- Public share links never stream the original upload. Images produce a bounded JPEG before the link is returned. Videos persist an unguessable token, enqueue a single-concurrency background job, and return `status=preparing`; the queue consumer then produces an H.264/MP4 display rendition and freshly encoded JPEG poster. Public metadata, file, and poster endpoints return `425` with `Cache-Control: no-store` until both outputs are ready, and never transform inline or fall back to original bytes.
- Video jobs are fenced by photo id, source object/checksum, share token, and rendition version. Revoked, archived, deleted, or replaced sources cannot publish stale output. Failed attempts remove partial outputs, expose a terminal `503` state, and are retried by Cloudflare Queues.
- Cloudflare Media Transformations currently limits transformed video output to 60 seconds. Longer or unsupported videos remain private and the queued preparation fails instead of falling back to the original upload.
- X and Facebook use their official web share intents. WeChat QR codes are generated in the browser and the token-bearing URL is never sent to a third-party QR service.
- **Upload limits**: videos support exactly 40,000,000 bytes (40 MB); images remain limited to 25 MiB. The web app streams the raw file body and the Worker forwards sequential Drive9 multipart chunks, so it never retains a whole video in memory. Legacy `multipart/form-data` uploads remain limited to 25 MiB because parsing them buffers the request.
- **Video playback**: the Worker proxies the file from drive9. HTTP Range requests are forwarded when drive9 supports them; otherwise the full file is downloaded. For short demo clips this is acceptable.
- **Video analysis**: drive9 video visual extraction takes longer than image analysis. A video may show "analyzing…" for up to several minutes; if analysis has not completed after 10 minutes the UI marks it as timed out.

## Credits

Powered by [drive9.ai](https://drive9.ai).

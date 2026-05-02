# PhotoVault — powered by drive9

A simple photo library demo built on top of [drive9.ai](https://drive9.ai).

Upload photos, let drive9 extract image semantics/OCR asynchronously, then search and organize photos by what is inside them — not just by filename.

## Live Demo

- Website: https://drive9-photo-vault.netlify.app
- OpenAPI: https://drive9-photo-api.siddontang.workers.dev/openapi.json
- Repository: https://github.com/siddontang/drive9-photo-vault

## What it does

- Upload photos from desktop or mobile
- Store original images directly in drive9
- Use drive9 semantic metadata/OCR for captions, tags, and search
- Search by visible text, objects, topics, filenames, notes, albums, and tags
- Show compact photo summaries with `show more / show less`
- Show folded tag lists with `+N more`
- Favorite and delete photos
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
        v
drive9 filesystem
  /photovault/index.json       metadata index
  /photovault/photos/*         original image files
```

Important design choice: the app does **not** use Cloudflare R2, KV, or Workers AI for photo storage/tagging. drive9 is the source of truth for files and image semantics.

## How image search works

1. User uploads a photo through the website.
2. The Worker writes the original image into drive9 under `/photovault/photos/`.
3. drive9 asynchronously analyzes the image and exposes semantic metadata via `?stat=1`.
4. The Worker refreshes photo metadata from drive9 and compacts it into `/photovault/index.json`.
5. The website searches against title, note, album, tags, caption, and compact semantic text.

Because drive9 analysis is async, a newly uploaded photo may first appear with `drive9 analyzing...`; tags/search metadata usually appear after refresh/search a few seconds later.

## API endpoints

Base URL:

```text
https://drive9-photo-api.siddontang.workers.dev
```

Endpoints:

- `GET /api/health`
- `GET /api/photos?q=&tag=&owner=&favorite=`
- `POST /api/photos` multipart upload
- `PATCH /api/photos/:id`
- `DELETE /api/photos/:id`
- `GET /api/photos/:id/file`
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

- `CLOUDFLARE_API_TOKEN`
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

## Credits

Powered by [drive9.ai](https://drive9.ai).

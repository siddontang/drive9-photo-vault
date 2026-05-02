# Drive9-inspired PhotoVault Demo

A small Drive9-inspired photo application:
- Cloudflare Worker exposes an OpenAPI-compatible API
- drive9 stores original images and metadata index under `/photovault`
- Cloudflare Worker is only the OpenAPI/API gateway; no R2/KV object storage
- Netlify hosts the React website

The product idea: a personal photo drive with semantic-ish metadata search, smart collections, duplicate detection, and lightweight management.

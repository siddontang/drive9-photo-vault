import { injectShareMeta, shareMetaTags, shareToken } from './share-meta-core.mjs';

export default async function shareMeta(request, context) {
  const response = await context.next();
  const requestUrl = new URL(request.url);
  const token = shareToken(requestUrl.pathname);
  if (!token || !response.ok || !response.headers.get('content-type')?.includes('text/html')) return response;

  const metadataUrl = new URL(`/api/shares/${token}`, requestUrl);
  const metadata = await fetch(metadataUrl, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!metadata.ok) return response;

  const payload = await metadata.json();
  if (!payload?.photo) return response;
  requestUrl.search = '';
  requestUrl.hash = '';
  const tags = shareMetaTags({
    photo: payload.photo,
    pageUrl: requestUrl.toString(),
    posterUrl: new URL(`/api/shares/${token}/poster`, requestUrl).toString(),
  });
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-robots-tag', 'noindex, noarchive');
  headers.delete('content-length');
  return new Response(injectShareMeta(await response.text(), tags), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

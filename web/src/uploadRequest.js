export const UPLOAD_METADATA_HEADER = 'x-photovault-upload-metadata';

export function buildStreamUploadRequest(file, fields = {}) {
  const metadata = {
    name: file.name,
    size: file.size,
    owner: fields.owner || 'guest',
    title: fields.title || '',
    tags: fields.tags || '',
    note: fields.note || '',
    album: fields.album || 'Inbox',
  };
  return {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      [UPLOAD_METADATA_HEADER]: encodeURIComponent(JSON.stringify(metadata)),
    },
    body: file,
  };
}

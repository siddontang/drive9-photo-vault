export interface Drive9UploadEnv {
  DRIVE9_API_KEY: string;
  DRIVE9_SERVER?: string;
}

type Drive9UploadPlan = {
  upload_id: string;
  part_size: number;
  total_parts: number;
};

type Drive9PresignedPart = {
  number: number;
  url: string;
  size: number;
  headers?: Record<string, string>;
};

type Drive9CompletePart = {
  number: number;
  etag: string;
};

type DigestStreamLike = WritableStream<BufferSource> & {
  digest: Promise<ArrayBuffer>;
};

type CryptoWithDigestStream = Crypto & {
  DigestStream?: new (algorithm: string) => DigestStreamLike;
};

const DIRECT_PUT_LIMIT = 50_000;
const MAX_STREAM_PART_BYTES = 16 * 1024 * 1024;
const PRESIGN_BATCH_SIZE = 8;

export class UploadBodySizeError extends Error {}

class ExactStreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array | null = null;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readExact(size: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(size);
    let offset = 0;

    while (offset < size) {
      let chunk = this.pending;
      this.pending = null;
      if (!chunk) {
        const next = await this.reader.read();
        if (next.done) {
          throw new UploadBodySizeError(`upload body ended early: received ${offset} of ${size} bytes for the current part`);
        }
        chunk = next.value;
      }
      if (chunk.byteLength === 0) continue;

      const take = Math.min(chunk.byteLength, size - offset);
      output.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take < chunk.byteLength) this.pending = chunk.subarray(take);
    }

    return output;
  }

  async assertDone(): Promise<void> {
    if (this.pending?.byteLength) {
      throw new UploadBodySizeError('upload body exceeds the declared file size');
    }
    while (true) {
      const next = await this.reader.read();
      if (next.done) return;
      if (next.value.byteLength > 0) {
        throw new UploadBodySizeError('upload body exceeds the declared file size');
      }
    }
  }

  async cancel(reason: unknown): Promise<void> {
    await this.reader.cancel(reason).catch(() => {});
  }
}

function drive9Base(env: Drive9UploadEnv) {
  return (env.DRIVE9_SERVER || 'https://api.drive9.ai').replace(/\/$/, '');
}

function fsUrl(env: Drive9UploadEnv, path: string) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${drive9Base(env)}/v1/fs${normalized}`;
}

function authHeaders(env: Drive9UploadEnv, headers: HeadersInit = {}) {
  return { authorization: `Bearer ${env.DRIVE9_API_KEY}`, ...headers };
}

async function responseDetail(response: Response) {
  return (await response.text().catch(() => '')).slice(0, 1000);
}

function digestHex(digest: ArrayBuffer) {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digestBytes(bytes: Uint8Array<ArrayBuffer>) {
  return digestHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function deleteDrive9Path(env: Drive9UploadEnv, path: string) {
  await fetch(fsUrl(env, path), { method: 'DELETE', headers: authHeaders(env) }).catch(() => null);
}

async function abortDrive9Upload(env: Drive9UploadEnv, uploadID: string) {
  await fetch(`${drive9Base(env)}/v2/uploads/${uploadID}/abort`, {
    method: 'POST',
    headers: authHeaders(env),
  }).catch(() => null);
}

function expectedPartSize(totalSize: number, partSize: number, partNumber: number) {
  return Math.min(partSize, totalSize - (partNumber - 1) * partSize);
}

function validatePlan(plan: Drive9UploadPlan, totalSize: number) {
  if (!plan.upload_id) throw new Error('drive9 multipart initiate returned no upload_id');
  if (!Number.isSafeInteger(plan.part_size) || plan.part_size <= 0 || plan.part_size > MAX_STREAM_PART_BYTES) {
    throw new Error(`drive9 multipart returned unsafe part_size ${plan.part_size}`);
  }
  const expectedParts = Math.ceil(totalSize / plan.part_size);
  if (!Number.isSafeInteger(plan.total_parts) || plan.total_parts !== expectedParts) {
    throw new Error(`drive9 multipart returned invalid total_parts ${plan.total_parts}; expected ${expectedParts}`);
  }
}

async function uploadPart(part: Drive9PresignedPart, bytes: Uint8Array<ArrayBuffer>) {
  const headers = new Headers(part.headers || {});
  headers.delete('host');
  const response = await fetch(part.url, { method: 'PUT', headers, body: bytes });
  if (!response.ok) {
    throw new Error(`drive9 part ${part.number} upload failed: ${response.status} ${await responseDetail(response)}`);
  }
  return { number: part.number, etag: response.headers.get('etag') || '' };
}

async function directUpload(
  env: Drive9UploadEnv,
  path: string,
  stream: ReadableStream<Uint8Array>,
  totalSize: number,
  mime: string,
  description: string,
  tags: Record<string, string>,
) {
  const reader = new ExactStreamReader(stream);
  try {
    const bytes = await reader.readExact(totalSize);
    await reader.assertDone();
    const checksum = await digestBytes(bytes);
    const response = await fetch(fsUrl(env, path), {
      method: 'PUT',
      headers: authHeaders(env, {
        'content-type': mime,
        'x-dat9-description': description,
        ...Object.fromEntries(Object.entries(tags).map(([key, value]) => [`x-dat9-tag-${key}`, value])),
      }),
      body: bytes,
    });
    if (!response.ok) throw new Error(`drive9 direct upload failed: ${response.status} ${await responseDetail(response)}`);
    return checksum;
  } catch (error) {
    await reader.cancel(error);
    await deleteDrive9Path(env, path);
    throw error;
  }
}

async function multipartUpload(
  env: Drive9UploadEnv,
  path: string,
  stream: ReadableStream<Uint8Array>,
  totalSize: number,
  description: string,
  tags: Record<string, string>,
) {
  const initiate = await fetch(`${drive9Base(env)}/v2/uploads/initiate`, {
    method: 'POST',
    headers: authHeaders(env, { 'content-type': 'application/json' }),
    body: JSON.stringify({ path, total_size: totalSize, description }),
  });
  if (!initiate.ok) {
    throw new Error(`drive9 multipart initiate failed: ${initiate.status} ${await responseDetail(initiate)}`);
  }
  const plan = await initiate.json() as Drive9UploadPlan;
  const uploadID = plan.upload_id;
  const reader = new ExactStreamReader(stream);
  try {
    validatePlan(plan, totalSize);
  } catch (error) {
    await reader.cancel(error);
    if (uploadID) await abortDrive9Upload(env, uploadID);
    throw error;
  }
  const DigestStream = (crypto as CryptoWithDigestStream).DigestStream;
  if (!DigestStream) {
    await reader.cancel('Cloudflare streaming SHA-256 is unavailable');
    if (uploadID) await abortDrive9Upload(env, uploadID);
    throw new Error('Cloudflare streaming SHA-256 is unavailable');
  }
  const digestStream = new DigestStream('SHA-256');
  const digestPromise = digestStream.digest;
  digestPromise.catch(() => {});
  const digestWriter = digestStream.getWriter();
  let digestClosed = false;

  try {
    const completed: Drive9CompletePart[] = [];
    for (let start = 1; start <= plan.total_parts; start += PRESIGN_BATCH_SIZE) {
      const end = Math.min(plan.total_parts, start + PRESIGN_BATCH_SIZE - 1);
      const partNumbers = Array.from({ length: end - start + 1 }, (_, index) => start + index);
      const presigned = await presignPartsForSize(env, plan, totalSize, partNumbers);
      for (const part of presigned) {
        const bytes = await reader.readExact(part.size);
        await digestWriter.write(bytes);
        completed.push(await uploadPart(part, bytes));
      }
    }
    await reader.assertDone();
    await digestWriter.close();
    digestClosed = true;
    const checksum = digestHex(await digestPromise);

    const complete = await fetch(`${drive9Base(env)}/v2/uploads/${plan.upload_id}/complete`, {
      method: 'POST',
      headers: authHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ parts: completed, tags }),
    });
    if (!complete.ok) {
      throw new Error(`drive9 multipart complete failed: ${complete.status} ${await responseDetail(complete)}`);
    }
    return checksum;
  } catch (error) {
    if (!digestClosed) await digestWriter.abort(error).catch(() => {});
    await reader.cancel(error);
    if (uploadID) await abortDrive9Upload(env, uploadID);
    await deleteDrive9Path(env, path);
    throw error;
  }
}

async function presignPartsForSize(
  env: Drive9UploadEnv,
  plan: Drive9UploadPlan,
  totalSize: number,
  partNumbers: number[],
) {
  const response = await fetch(`${drive9Base(env)}/v2/uploads/${plan.upload_id}/presign-batch`, {
    method: 'POST',
    headers: authHeaders(env, { 'content-type': 'application/json' }),
    body: JSON.stringify({ parts: partNumbers.map((part_number) => ({ part_number })) }),
  });
  if (!response.ok) {
    throw new Error(`drive9 multipart presign failed: ${response.status} ${await responseDetail(response)}`);
  }
  const payload = await response.json() as { parts?: Drive9PresignedPart[] };
  const byNumber = new Map((payload.parts || []).map((part) => [part.number, part]));
  return partNumbers.map((partNumber) => {
    const part = byNumber.get(partNumber);
    const expectedSize = expectedPartSize(totalSize, plan.part_size, partNumber);
    if (!part || !part.url || part.size !== expectedSize) {
      throw new Error(`drive9 multipart returned invalid presign data for part ${partNumber}`);
    }
    return part;
  });
}

export async function drive9UploadStream(
  env: Drive9UploadEnv,
  path: string,
  stream: ReadableStream<Uint8Array>,
  totalSize: number,
  mime: string,
  description: string,
  tags: Record<string, string> = {},
) {
  if (!env.DRIVE9_API_KEY) throw new Error('missing DRIVE9_API_KEY');
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new UploadBodySizeError('invalid declared file size');
  const checksum = totalSize < DIRECT_PUT_LIMIT
    ? await directUpload(env, path, stream, totalSize, mime, description, tags)
    : await multipartUpload(env, path, stream, totalSize, description, tags);
  return { checksum };
}

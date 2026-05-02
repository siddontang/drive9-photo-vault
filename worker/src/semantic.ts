export type Drive9SemanticResult = {
  caption: string;
  text: string;
  objects: string[];
  tags: string[];
  searchText: string;
  status: string;
};

const DRIVE9_IMAGE_EN_TAG_RE = /^drive9\.image\.tag\.en\.(\d+)$/;
const MAX_TAGS = 30;
const MAX_TAG_RUNES = 64;
const MAX_CAPTION_LENGTH = 500;

const deniedDisplayTags = new Set([
  'app',
  'photo vault',
  'photovault',
  'drive9',
  'drive 9',
  'image_extract',
  'image extract',
  'structured_v1',
  'structured v1',
  'schema',
  'source',
  'image',
  'photo',
  'picture',
  'pic',
  'photograph',
  'ocr',
  'text',
  'visible text',
  'caption',
  'description',
  'tag',
  'tags',
  'file',
]);

const englishCaptionLabels = [
  '英文摘要',
  'english caption',
  'english summary',
  'caption_en',
  'summary_en',
  'en caption',
  'en summary',
  'en.caption',
  'en.summary',
];

const englishDescriptionLabels = [
  '英文描述',
  'english description',
  'description_en',
  'en description',
  'en.description',
];

const englishTagLabels = [
  '英文标签',
  'english tags',
  'english tag',
  'tags_en',
  'tag_en',
  'en tags',
  'en tag',
  'en.tags',
];

export function buildDrive9SemanticResult(meta: unknown, existingTags: string[] = []): Drive9SemanticResult | null {
  if (!isRecord(meta)) return null;

  const text = semanticTextToSearchText(meta.semantic_text);
  if (!text) return null;

  const tags = tagsFromDrive9Meta(meta.tags, existingTags, meta.semantic_text);
  return {
    caption: captionFromDrive9Semantic(meta.semantic_text),
    text,
    objects: [],
    tags,
    searchText: [text, tags.join(' ')].filter(Boolean).join(' '),
    status: 'drive9',
  };
}

export function captionFromDrive9Semantic(semanticValue: unknown): string {
  const obj = semanticObjectFromValue(semanticValue);
  if (obj) {
    const fromObject = englishCaptionFromObject(obj);
    if (fromObject) return fromObject;
  }

  const text = typeof semanticValue === 'string' ? semanticValue : semanticTextToSearchText(semanticValue);
  const caption = semanticLineValue(text, englishCaptionLabels);
  if (caption) return cleanCaption(caption);

  const description = semanticLineValue(text, englishDescriptionLabels);
  return description ? firstSentence(cleanCaption(description)) : '';
}

export function tagsFromDrive9Meta(tagsMeta: unknown, existingTags: string[] = [], semanticValue?: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addTag = (raw: unknown, lowercase = false) => {
    const tag = cleanDisplayTag(raw, lowercase);
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };

  for (const tag of existingTags) addTag(tag);

  const driveTags = drive9ImageEnglishTags(tagsMeta);
  const semanticTags = driveTags.length ? driveTags : englishTagsFromSemantic(semanticValue);
  for (const tag of semanticTags) addTag(tag, true);

  return out.slice(0, MAX_TAGS);
}

export function semanticTextToSearchText(value: unknown): string {
  const obj = semanticObjectFromValue(value);
  if (obj) {
    const structured = structuredSemanticObjectToText(obj);
    if (structured) return structured;
    return flattenStrings(obj).join('\n').trim();
  }

  return typeof value === 'string' ? cleanText(value) : '';
}

function drive9ImageEnglishTags(tagsMeta: unknown): string[] {
  if (!isRecord(tagsMeta)) return [];

  const tags: Array<{ order: number; value: string }> = [];
  for (const [key, value] of Object.entries(tagsMeta)) {
    const match = key.match(DRIVE9_IMAGE_EN_TAG_RE);
    if (!match) continue;

    const order = Number(match[1]);
    for (const item of stringValues(value)) {
      tags.push({ order, value: item });
    }
  }

  return tags
    .sort((a, b) => a.order - b.order)
    .map((tag) => tag.value);
}

function englishTagsFromSemantic(semanticValue: unknown): string[] {
  const obj = semanticObjectFromValue(semanticValue);
  if (obj) {
    const en = firstRecord(obj, ['en', 'english']);
    const tags = firstTagList(obj, ['tags_en', 'english_tags']) || (en ? firstTagList(en, ['tags', 'tag']) : null);
    if (tags?.length) return tags;
  }

  const text = typeof semanticValue === 'string' ? semanticValue : semanticTextToSearchText(semanticValue);
  const line = semanticLineValue(text, englishTagLabels);
  return line ? splitTagLine(line) : [];
}

function englishCaptionFromObject(obj: Record<string, unknown>): string {
  const en = firstRecord(obj, ['en', 'english']);
  const caption = firstString(obj, ['caption_en', 'summary_en', 'english_caption', 'english_summary'])
    || (en ? firstString(en, ['caption', 'summary']) : '')
    || firstString(obj, ['en', 'english']);
  if (caption) return cleanCaption(caption);

  const description = firstString(obj, ['description_en', 'english_description'])
    || (en ? firstString(en, ['description']) : '');
  return description ? firstSentence(cleanCaption(description)) : '';
}

function structuredSemanticObjectToText(obj: Record<string, unknown>): string {
  const zh = firstRecord(obj, ['zh', 'chinese']);
  const en = firstRecord(obj, ['en', 'english']);
  const lines: string[] = [];
  const addLine = (label: string, value: string | string[]) => {
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${label}：${value.join(label.includes('英文') ? ', ' : '；')}`);
      return;
    }
    if (value) lines.push(`${label}：${value}`);
  };

  addLine('中文摘要', firstString(obj, ['caption_zh', 'summary_zh']) || (zh ? firstString(zh, ['caption', 'summary']) : ''));
  addLine('中文描述', firstString(obj, ['description_zh']) || (zh ? firstString(zh, ['description']) : ''));
  addLine('英文摘要', firstString(obj, ['caption_en', 'summary_en']) || (en ? firstString(en, ['caption', 'summary']) : '') || firstString(obj, ['en', 'english']));
  addLine('英文描述', firstString(obj, ['description_en']) || (en ? firstString(en, ['description']) : ''));
  addLine('图中文字', firstList(obj, ['ocr_text', 'ocr']) || []);
  addLine('中文标签', firstTagList(obj, ['tags_zh']) || (zh ? firstTagList(zh, ['tags']) : null) || []);
  addLine('英文标签', firstTagList(obj, ['tags_en']) || (en ? firstTagList(en, ['tags']) : null) || []);
  addLine('中文搜索短语', firstList(obj, ['search_queries_zh', 'queries_zh']) || (zh ? firstList(zh, ['search_queries', 'queries']) : null) || []);
  addLine('英文搜索短语', firstList(obj, ['search_queries_en', 'queries_en']) || (en ? firstList(en, ['search_queries', 'queries']) : null) || []);

  return lines.join('\n').trim();
}

function semanticObjectFromValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;

  const candidate = jsonObjectCandidate(value);
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonObjectCandidate(raw: string): string {
  let text = cleanText(raw).replace(/^\ufeff/, '').trim();
  if (!text) return '';

  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines.length >= 2) {
      lines.shift();
      if (lines.at(-1)?.trim().startsWith('```')) lines.pop();
      text = lines.join('\n').trim();
    }
  }

  if (text.startsWith('{') && text.endsWith('}')) return text;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}

function semanticLineValue(text: string, labels: string[]): string {
  if (!text) return '';

  const wanted = new Set(labels.map(normalizeLabel));
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\*\*/g, '').replace(/^[\s#>*-]+/, '').trim();
    const idx = firstColonIndex(line);
    if (idx < 0) continue;

    const label = normalizeLabel(line.slice(0, idx));
    if (!wanted.has(label)) continue;

    return cleanLineValue(line.slice(idx + 1));
  }
  return '';
}

function firstColonIndex(line: string): number {
  const full = line.indexOf('：');
  const half = line.indexOf(':');
  if (full < 0) return half;
  if (half < 0) return full;
  return Math.min(full, half);
}

function normalizeLabel(label: string): string {
  return label
    .replace(/\*\*/g, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function cleanLineValue(value: string): string {
  return cleanText(value)
    .replace(/^[`"'“”‘’]+/, '')
    .replace(/[`"'“”‘’]+,?$/, '')
    .trim();
}

function cleanCaption(value: string): string {
  return cleanLineValue(value).replace(/\s+/g, ' ').slice(0, MAX_CAPTION_LENGTH).trim();
}

function firstSentence(value: string): string {
  const sentence = value.match(/^.{1,500}?[.!?](?:\s|$)/u)?.[0];
  return (sentence || value).slice(0, MAX_CAPTION_LENGTH).trim();
}

function splitTagLine(value: string): string[] {
  return cleanLineValue(value)
    .split(/[,\n;；，、]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function cleanDisplayTag(raw: unknown, lowercase = false): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';

  let tag = String(raw)
    .trim()
    .replace(/_/g, ' ')
    .replace(/^[`"'“”‘’.,;:!?()[\]{}<>#|]+/, '')
    .replace(/[`"'“”‘’.,;:!?()[\]{}<>#|]+$/, '')
    .replace(/\s+/g, ' ');

  if (lowercase) tag = tag.toLowerCase();
  tag = truncateRunes(tag, MAX_TAG_RUNES).trim();

  const key = tag.toLowerCase();
  if (!tag || deniedDisplayTags.has(key) || key.startsWith('drive9.image.')) return '';
  return tag;
}

function firstRecord(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = obj[key];
    if (isRecord(value)) return value;
  }
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const out = cleanLineValue(String(value));
      if (out) return out;
    }
  }
  return '';
}

function firstList(obj: Record<string, unknown>, keys: string[]): string[] | null {
  for (const key of keys) {
    const values = stringValues(obj[key]);
    if (values.length) return values.map(cleanLineValue).filter(Boolean);
  }
  return null;
}

function firstTagList(obj: Record<string, unknown>, keys: string[]): string[] | null {
  for (const key of keys) {
    const value = obj[key];
    const values = Array.isArray(value) ? stringValues(value) : typeof value === 'string' ? splitTagLine(value) : stringValues(value);
    if (values.length) return values;
  }
  return null;
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (typeof value === 'string' || typeof value === 'number') {
    const out = cleanLineValue(String(value));
    return out ? [out] : [];
  }
  return [];
}

function flattenStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = cleanLineValue(String(value));
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) flattenStrings(item, out);
  }
  return out;
}

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\*\*/g, '').trim();
}

function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  return runes.length > maxRunes ? runes.slice(0, maxRunes).join('') : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

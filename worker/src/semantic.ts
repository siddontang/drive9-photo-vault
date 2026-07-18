export type LangPair<T> = { zh: T; en: T };

export type Drive9SemanticResult = {
  caption: LangPair<string>;
  text: LangPair<string>;
  tags: LangPair<string[]>;
  status: string;
};

const DRIVE9_IMAGE_EN_TAG_RE = /^drive9\.image\.tag\.en\.(\d+)$/;
const DRIVE9_IMAGE_ZH_TAG_RE = /^drive9\.image\.tag\.zh\.(\d+)$/;
const DRIVE9_VIDEO_EN_TAG_RE = /^drive9\.video\.tag\.en\.(\d+)$/;
const DRIVE9_VIDEO_ZH_TAG_RE = /^drive9\.video\.tag\.zh\.(\d+)$/;
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
  'video_extract',
  'video extract',
  'video',
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
  'english caption',
  'english summary',
  'caption_en',
  'summary_en',
  'en caption',
  'en summary',
  'en.caption',
  'en.summary',
  '英文摘要',
];

const englishDescriptionLabels = [
  'english description',
  'description_en',
  'en description',
  'en.description',
  '英文描述',
];

const englishTagLabels = [
  'english tags',
  'english tag',
  'tags_en',
  'tag_en',
  'en tags',
  'en tag',
  'en.tags',
  '英文标签',
];

const chineseCaptionLabels = [
  '中文摘要',
  'chinese caption',
  'chinese summary',
  'caption_zh',
  'summary_zh',
  'zh caption',
  'zh summary',
  'zh.caption',
  'zh.summary',
];

const chineseDescriptionLabels = [
  '中文描述',
  'chinese description',
  'description_zh',
  'zh description',
  'zh.description',
];

const chineseTagLabels = [
  '中文标签',
  'chinese tags',
  'chinese tag',
  'tags_zh',
  'tag_zh',
  'zh tags',
  'zh tag',
  'zh.tags',
];

export function buildDrive9SemanticResult(meta: unknown, existingTags: string[] = []): Drive9SemanticResult | null {
  if (!isRecord(meta)) return null;

  const text = semanticTextToSearchText(meta.semantic_text);
  if (!text) return null;

  const tagsEn = tagsEnFromDrive9Meta(meta.tags, existingTags, meta.semantic_text);
  const tagsZh = tagsZhFromDrive9Meta(meta.tags, meta.semantic_text);
  const captionEn = captionEnFromDrive9Semantic(meta.semantic_text);
  const captionZh = captionZhFromDrive9Semantic(meta.semantic_text);
  const textEn = textEnFromDrive9Semantic(meta.semantic_text);
  const textZh = textZhFromDrive9Semantic(meta.semantic_text);

  return {
    caption: { zh: captionZh, en: captionEn },
    text: { zh: textZh, en: textEn },
    tags: { zh: tagsZh, en: tagsEn },
    status: 'drive9',
  };
}

export function captionEnFromDrive9Semantic(semanticValue: unknown): string {
  return captionForLang(semanticValue, 'en');
}

export function captionZhFromDrive9Semantic(semanticValue: unknown): string {
  return captionForLang(semanticValue, 'zh');
}

function captionForLang(semanticValue: unknown, lang: 'zh' | 'en'): string {
  const obj = semanticObjectFromValue(semanticValue);
  if (obj) {
    const fromObject = captionFromObjectForLang(obj, lang);
    if (fromObject) return fromObject;
  }

  const text = typeof semanticValue === 'string' ? semanticValue : semanticTextToSearchText(semanticValue);
  const captionLabels = lang === 'zh' ? chineseCaptionLabels : englishCaptionLabels;
  const descriptionLabels = lang === 'zh' ? chineseDescriptionLabels : englishDescriptionLabels;

  const caption = semanticLineValue(text, captionLabels);
  if (caption) return cleanCaption(caption);

  const description = semanticLineValue(text, descriptionLabels);
  return description ? firstSentence(cleanCaption(description)) : '';
}

export function tagsEnFromDrive9Meta(tagsMeta: unknown, existingTags: string[] = [], semanticValue?: unknown): string[] {
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

  const driveTags = drive9ImageTagsByLang(tagsMeta, 'en');
  const semanticTags = driveTags.length ? driveTags : tagsFromSemanticForLang(semanticValue, 'en');
  for (const tag of semanticTags) addTag(tag, true);

  return out.slice(0, MAX_TAGS);
}

export function tagsZhFromDrive9Meta(tagsMeta: unknown, semanticValue?: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addTag = (raw: unknown) => {
    const tag = cleanDisplayTag(raw, false);
    if (!tag) return;
    if (seen.has(tag)) return;
    seen.add(tag);
    out.push(tag);
  };

  const driveTags = drive9ImageTagsByLang(tagsMeta, 'zh');
  const semanticTags = driveTags.length ? driveTags : tagsFromSemanticForLang(semanticValue, 'zh');
  for (const tag of semanticTags) addTag(tag);

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

function textEnFromDrive9Semantic(semanticValue: unknown): string {
  return langTextFromSemantic(semanticValue, 'en');
}

function textZhFromDrive9Semantic(semanticValue: unknown): string {
  return langTextFromSemantic(semanticValue, 'zh');
}

function langTextFromSemantic(semanticValue: unknown, lang: 'zh' | 'en'): string {
  const obj = semanticObjectFromValue(semanticValue);
  if (obj) {
    const structured = structuredSemanticObjectToTextForLang(obj, lang);
    if (structured) return structured;
  }

  const text = typeof semanticValue === 'string' ? cleanText(semanticValue) : semanticTextToSearchText(semanticValue);
  return text ? extractLangLines(text, lang) : '';
}

function extractLangLines(text: string, lang: 'zh' | 'en'): string {
  const captionLabels = new Set((lang === 'zh' ? chineseCaptionLabels : englishCaptionLabels).map(normalizeLabel));
  const descriptionLabels = new Set((lang === 'zh' ? chineseDescriptionLabels : englishDescriptionLabels).map(normalizeLabel));
  const tagLabels = new Set((lang === 'zh' ? chineseTagLabels : englishTagLabels).map(normalizeLabel));
  const queryLabels = new Set((lang === 'zh' ? ['中文搜索短语'] : ['英文搜索短语']).map(normalizeLabel));
  const ocrLabels = new Set(['图中文字', '图中可见文字', 'ocr', 'ocr_text'].map(normalizeLabel));
  const wanted = new Set([...captionLabels, ...descriptionLabels, ...tagLabels, ...queryLabels, ...ocrLabels]);

  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\*\*/g, '').replace(/^[\s#>*-]+/, '').trim();
    const idx = firstColonIndex(line);
    if (idx < 0) continue;

    const label = normalizeLabel(line.slice(0, idx));
    if (wanted.has(label)) out.push(line);
  }
  return out.join('\n').trim();
}

function drive9ImageTagsByLang(tagsMeta: unknown, lang: 'zh' | 'en'): string[] {
  if (!isRecord(tagsMeta)) return [];

  const patterns = lang === 'zh'
    ? [DRIVE9_IMAGE_ZH_TAG_RE, DRIVE9_VIDEO_ZH_TAG_RE]
    : [DRIVE9_IMAGE_EN_TAG_RE, DRIVE9_VIDEO_EN_TAG_RE];
  const tags: Array<{ order: number; value: string }> = [];
  for (const [key, value] of Object.entries(tagsMeta)) {
    let match: RegExpMatchArray | null = null;
    for (const re of patterns) {
      match = key.match(re);
      if (match) break;
    }
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

function tagsFromSemanticForLang(semanticValue: unknown, lang: 'zh' | 'en'): string[] {
  const obj = semanticObjectFromValue(semanticValue);
  if (obj) {
    const langKey = lang === 'zh' ? ['zh', 'chinese'] : ['en', 'english'];
    const langObj = firstRecord(obj, langKey);
    const flatKeys = lang === 'zh' ? ['tags_zh', 'chinese_tags'] : ['tags_en', 'english_tags'];
    const tags = firstTagList(obj, flatKeys) || (langObj ? firstTagList(langObj, ['tags', 'tag']) : null);
    if (tags?.length) return tags;
  }

  const text = typeof semanticValue === 'string' ? semanticValue : semanticTextToSearchText(semanticValue);
  const labels = lang === 'zh' ? chineseTagLabels : englishTagLabels;
  const line = semanticLineValue(text, labels);
  return line ? splitTagLine(line) : [];
}

function captionFromObjectForLang(obj: Record<string, unknown>, lang: 'zh' | 'en'): string {
  const langObj = firstRecord(obj, lang === 'zh' ? ['zh', 'chinese'] : ['en', 'english']);
  const captionKeys = lang === 'zh'
    ? ['caption_zh', 'summary_zh', 'chinese_caption', 'chinese_summary']
    : ['caption_en', 'summary_en', 'english_caption', 'english_summary'];
  const flatStringKeys = lang === 'zh' ? ['zh', 'chinese'] : ['en', 'english'];
  const caption = firstString(obj, captionKeys)
    || (langObj ? firstString(langObj, ['caption', 'summary']) : '')
    || firstString(obj, flatStringKeys);
  if (caption) return cleanCaption(caption);

  const descriptionKeys = lang === 'zh' ? ['description_zh', 'chinese_description'] : ['description_en', 'english_description'];
  const description = firstString(obj, descriptionKeys)
    || (langObj ? firstString(langObj, ['description']) : '');
  return description ? firstSentence(cleanCaption(description)) : '';
}

function structuredSemanticObjectToText(obj: Record<string, unknown>): string {
  const zhText = structuredSemanticObjectToTextForLang(obj, 'zh');
  const enText = structuredSemanticObjectToTextForLang(obj, 'en');
  return [zhText, enText].filter(Boolean).join('\n').trim();
}

function structuredSemanticObjectToTextForLang(obj: Record<string, unknown>, lang: 'zh' | 'en'): string {
  const langObj = firstRecord(obj, lang === 'zh' ? ['zh', 'chinese'] : ['en', 'english']);
  const lines: string[] = [];
  const addLine = (label: string, value: string | string[]) => {
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${label}：${value.join(lang === 'en' ? ', ' : '；')}`);
      return;
    }
    if (value) lines.push(`${label}：${value}`);
  };

  if (lang === 'zh') {
    addLine('中文摘要', firstString(obj, ['caption_zh', 'summary_zh']) || (langObj ? firstString(langObj, ['caption', 'summary']) : ''));
    addLine('中文描述', firstString(obj, ['description_zh']) || (langObj ? firstString(langObj, ['description']) : ''));
    addLine('中文标签', firstTagList(obj, ['tags_zh']) || (langObj ? firstTagList(langObj, ['tags']) : null) || []);
    addLine('中文搜索短语', firstList(obj, ['search_queries_zh', 'queries_zh']) || (langObj ? firstList(langObj, ['search_queries', 'queries']) : null) || []);
  } else {
    addLine('英文摘要', firstString(obj, ['caption_en', 'summary_en']) || (langObj ? firstString(langObj, ['caption', 'summary']) : '') || firstString(obj, ['en', 'english']));
    addLine('英文描述', firstString(obj, ['description_en']) || (langObj ? firstString(langObj, ['description']) : ''));
    addLine('英文标签', firstTagList(obj, ['tags_en']) || (langObj ? firstTagList(langObj, ['tags']) : null) || []);
    addLine('英文搜索短语', firstList(obj, ['search_queries_en', 'queries_en']) || (langObj ? firstList(langObj, ['search_queries', 'queries']) : null) || []);
  }
  addLine('图中文字', firstList(obj, ['ocr_text', 'ocr']) || []);

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
  let text = cleanText(raw).replace(/^﻿/, '').trim();
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
  const sentence = value.match(/^.{1,500}?[.!?。！？](?:\s|$)/u)?.[0];
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
  if (!tag || deniedDisplayTags.has(key) || key.startsWith('drive9.image.') || key.startsWith('drive9.video.')) return '';
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

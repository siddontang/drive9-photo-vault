export const PHOTO_SEARCH_RESULT_LIMIT = 12;

export type PhotoSearchFields = {
  title?: string;
  note?: string;
  tags?: string[];
  aiCaptionEn?: string;
  aiCaptionZh?: string;
  aiTextEn?: string;
  aiTextZh?: string;
  aiTagsEn?: string[];
  aiTagsZh?: string[];
};

export type PhotoSearchCandidate<T extends PhotoSearchFields> = {
  photo: T;
  score: number;
};

type StructuredScore = {
  strong: number;
  weak: number;
};

const CJK_RE = /[\u3400-\u9fff]/u;
const WORD_RE = /[\p{L}\p{N}]+/gu;

export function rerankPhotoCandidates<T extends PhotoSearchFields>(
  candidates: PhotoSearchCandidate<T>[],
  query: string,
  limit = PHOTO_SEARCH_RESULT_LIMIT,
): PhotoSearchCandidate<T>[] {
  const resultLimit = Math.max(0, Math.floor(limit));
  if (!candidates.length || resultLimit === 0) return [];

  const normalizedQuery = normalize(query);
  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    structured: scoreStructuredFields(candidate.photo, normalizedQuery),
  }));
  const hasStrongMatch = scored.some(({ structured }) => structured.strong > 0);

  return scored
    .filter(({ structured }) => !hasStrongMatch || structured.strong > 0)
    .sort((left, right) => (
      right.structured.strong - left.structured.strong ||
      right.structured.weak - left.structured.weak ||
      finiteScore(right.candidate.score) - finiteScore(left.candidate.score) ||
      left.index - right.index
    ))
    .slice(0, resultLimit)
    .map(({ candidate }) => candidate);
}

function scoreStructuredFields(photo: PhotoSearchFields, query: string): StructuredScore {
  if (!query) return { strong: 0, weak: 0 };

  const primaryQuality = bestMatchQuality([
    photo.title,
    photo.aiCaptionEn,
    photo.aiCaptionZh,
    ...(photo.aiTagsEn || []),
    ...(photo.aiTagsZh || []),
  ], query);
  const otherTagQuality = bestMatchQuality(photo.tags || [], query);
  const weakQuality = bestMatchQuality([
    photo.note,
    photo.aiTextEn,
    photo.aiTextZh,
  ], query);

  return {
    strong: primaryQuality ? 300 + primaryQuality : otherTagQuality ? 200 + otherTagQuality : 0,
    weak: weakQuality ? 100 + weakQuality : 0,
  };
}

function bestMatchQuality(values: Array<string | undefined>, query: string): number {
  let best = 0;
  for (const value of values) {
    best = Math.max(best, matchQuality(normalize(value || ''), query));
  }
  return best;
}

function matchQuality(field: string, query: string): number {
  if (!field || !query) return 0;
  if (field === query) return 3;

  if (CJK_RE.test(query)) {
    const compactField = field.replace(/\s+/g, '');
    const compactQuery = query.replace(/\s+/g, '');
    if (compactField.includes(compactQuery)) return 2;
    if (isMeaningfulFragment(compactField) && compactQuery.endsWith(compactField)) return 1;
    return 0;
  }

  const fieldWords = words(field);
  const queryWords = words(query);
  if (containsSequence(fieldWords, queryWords)) return 2;
  if (isMeaningfulFragment(field) && endsWithSequence(queryWords, fieldWords)) return 1;
  return 0;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function words(value: string): string[] {
  return value.match(WORD_RE) || [];
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

function endsWithSequence(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  const start = haystack.length - needle.length;
  return needle.every((word, offset) => haystack[start + offset] === word);
}

function isMeaningfulFragment(value: string): boolean {
  if (CJK_RE.test(value)) return (value.match(/[\u3400-\u9fff]/gu) || []).length >= 2;
  const valueWords = words(value);
  return valueWords.length > 0 && valueWords.some((word) => word.length >= 2);
}

function finiteScore(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

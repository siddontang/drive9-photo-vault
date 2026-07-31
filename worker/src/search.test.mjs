import test from 'node:test';
import assert from 'node:assert/strict';

import { PHOTO_SEARCH_RESULT_LIMIT, rerankPhotoCandidates } from '../dist/search.js';

function candidate(id, score, fields = {}) {
  return { photo: { id, ...fields }, score };
}

test('structured Chinese subject queries keep the real cat above accessory matches and long-tail results', () => {
  const candidates = [
    candidate('generic-cat-tag', 0.95, { aiTagsZh: ['猫'] }),
    candidate('cute-hamster', 0.92, {
      aiCaptionZh: '一只卡通风格的仓鼠拟人化形象，整体造型可爱呆萌。',
      aiTagsZh: ['仓鼠', '可爱'],
    }),
    candidate('cat-ears', 0.9, { aiTagsZh: ['猫耳', '动漫角色'] }),
    candidate('real-cat', 0.8, {
      aiCaptionZh: '一只橘猫正视镜头，画面聚焦于猫脸特写。',
      aiTagsZh: ['橘猫', '宠物猫', '猫咪表情'],
    }),
    candidate('road', 0.7, { aiTagsZh: ['秋日', '公路'] }),
  ];

  for (const query of ['一只可爱的橘猫', '橘猫', '猫咪']) {
    assert.deepEqual(
      rerankPhotoCandidates(candidates, query).map(({ photo }) => photo.id),
      ['real-cat'],
      query,
    );
  }
});

test('explicit cat-ear queries surface the matching anime image', () => {
  const candidates = [
    candidate('real-cat', 0.9, { aiTagsEn: ['ginger cat', 'pet cat'], aiTagsZh: ['橘猫', '宠物猫'] }),
    candidate('cat-ears', 0.8, { aiTagsEn: ['cat ears', 'anime characters'], aiTagsZh: ['猫耳', '动漫角色'] }),
  ];

  assert.deepEqual(
    rerankPhotoCandidates(candidates, 'cat ears').map(({ photo }) => photo.id),
    ['cat-ears'],
  );
  assert.deepEqual(
    rerankPhotoCandidates(candidates, '猫耳').map(({ photo }) => photo.id),
    ['cat-ears'],
  );
});

test('caption and AI-tag matches outrank other tags and discard description-only matches', () => {
  const candidates = [
    candidate('description', 0.9, { aiTextEn: 'An autumn landscape beside a road.' }),
    candidate('other-tag', 0.8, { tags: ['autumn'] }),
    candidate('caption', 0.7, { aiCaptionEn: 'Autumn colors cover the forest.' }),
  ];

  assert.deepEqual(
    rerankPhotoCandidates(candidates, 'autumn').map(({ photo }) => photo.id),
    ['caption', 'other-tag'],
  );
});

test('English matching uses complete words instead of substrings', () => {
  const candidates = [
    candidate('location', 0.9, { aiCaptionEn: 'A location marker on a map.' }),
    candidate('mixed-location', 0.85, { aiCaptionZh: '地图上的 location 标记。' }),
    candidate('cat', 0.8, { aiTagsEn: ['cat'] }),
  ];

  assert.deepEqual(
    rerankPhotoCandidates(candidates, 'cat').map(({ photo }) => photo.id),
    ['cat'],
  );
});

test('non-cat semantic subjects keep their structured candidates', () => {
  const candidates = [
    candidate('jellyfish', 0.7, { aiTagsEn: ['jellyfish', 'marine life'] }),
    candidate('crab', 0.8, { aiTagsEn: ['crab mascot', 'anime characters'] }),
    candidate('autumn', 0.9, { aiTagsEn: ['autumn road', 'golden leaves'] }),
  ];

  assert.deepEqual(rerankPhotoCandidates(candidates, 'jellyfish').map(({ photo }) => photo.id), ['jellyfish']);
  assert.deepEqual(rerankPhotoCandidates(candidates, 'crab').map(({ photo }) => photo.id), ['crab']);
  assert.deepEqual(rerankPhotoCandidates(candidates, 'autumn').map(({ photo }) => photo.id), ['autumn']);
});

test('queries without a structured lexical match retain Drive9 score order', () => {
  const candidates = [
    candidate('second', 0.6, { aiCaptionEn: 'A household pet.' }),
    candidate('first', 0.8, { aiCaptionEn: 'An animal outdoors.' }),
  ];

  assert.deepEqual(
    rerankPhotoCandidates(candidates, 'feline companion').map(({ photo }) => photo.id),
    ['first', 'second'],
  );
});

test('description or OCR text is only a lower-signal fallback', () => {
  const candidates = [
    candidate('semantic-first', 0.9, { aiTextEn: 'No literal subject label here.' }),
    candidate('description-match', 0.8, { aiTextEn: 'A jellyfish appears in the detailed description.' }),
  ];

  assert.deepEqual(
    rerankPhotoCandidates(candidates, 'jellyfish').map(({ photo }) => photo.id),
    ['description-match', 'semantic-first'],
  );
});

test('result limit is small, explicit, and handles empty inputs', () => {
  const candidates = Array.from({ length: PHOTO_SEARCH_RESULT_LIMIT + 2 }, (_, index) => (
    candidate(String(index), PHOTO_SEARCH_RESULT_LIMIT + 2 - index, { aiTagsEn: ['autumn'] })
  ));

  assert.equal(rerankPhotoCandidates(candidates, 'autumn').length, PHOTO_SEARCH_RESULT_LIMIT);
  assert.deepEqual(rerankPhotoCandidates(candidates, '', 2).map(({ photo }) => photo.id), ['0', '1']);
  assert.deepEqual(rerankPhotoCandidates([], 'autumn'), []);
  assert.deepEqual(rerankPhotoCandidates(candidates, 'autumn', 0), []);
});

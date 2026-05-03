import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDrive9SemanticResult,
  captionEnFromDrive9Semantic,
  captionZhFromDrive9Semantic,
  tagsEnFromDrive9Meta,
  tagsZhFromDrive9Meta,
} from '../dist/semantic.js';

test('PR 372 semantic_text exposes parallel zh/en captions and tags', () => {
  const meta = {
    semantic_text: [
      '中文摘要：秋季林荫道路',
      '中文描述：一条蜿蜒柏油路穿过金黄色树林，阳光穿过树冠形成斑驳光影。',
      '英文摘要：Autumn tree-lined road',
      '英文描述：A winding asphalt road runs through tall trees with golden leaves and warm sunlight.',
      '图中文字：',
      '中文标签：秋季，林荫路，树木',
      '英文标签：autumn, tree-lined road, golden leaves, warm light',
      '中文搜索短语：秋天金黄色树林道路',
      '英文搜索短语：autumn golden tree road',
    ].join('\n'),
    tags: {
      app: 'photovault',
      album: 'Inbox',
      'drive9.image.schema': 'structured_v1',
      'drive9.image.source': 'image_extract',
      'drive9.image.tag.zh.0': '秋季',
      'drive9.image.tag.zh.1': '林荫路',
      'drive9.image.tag.en.2': 'golden leaves',
      'drive9.image.tag.en.0': 'Autumn',
      'drive9.image.tag.en.1': 'tree-lined road',
    },
  };

  const result = buildDrive9SemanticResult(meta, ['manual', 'photovault']);

  assert.equal(result?.caption.en, 'Autumn tree-lined road');
  assert.equal(result?.caption.zh, '秋季林荫道路');
  assert.deepEqual(result?.tags.en, ['manual', 'autumn', 'tree-lined road', 'golden leaves']);
  assert.deepEqual(result?.tags.zh, ['秋季', '林荫路']);
  assert.match(result?.text.en || '', /英文摘要：Autumn tree-lined road/);
  assert.match(result?.text.zh || '', /中文摘要：秋季林荫道路/);
  assert.doesNotMatch(result?.text.en || '', /中文摘要/);
  assert.doesNotMatch(result?.text.zh || '', /英文摘要/);
});

test('drive9 app and album metadata are never displayed as PhotoVault tags', () => {
  const tagsEn = tagsEnFromDrive9Meta({
    app: 'photovault',
    album: 'Inbox',
    'drive9.image.schema': 'structured_v1',
    'drive9.image.source': 'image_extract',
    'drive9.image.tag.en.0': 'invoice',
    'drive9.image.tag.en.1': 'mobile screenshot',
  }, ['PhotoVault', 'receipt']);

  assert.deepEqual(tagsEn, ['receipt', 'invoice', 'mobile screenshot']);
});

test('legacy fallback only parses explicit English tag line', () => {
  const semanticText = [
    '中文摘要：发票截图',
    '英文摘要：Receipt screenshot',
    '英文描述：A screenshot of a mobile app upload page with Drive9 and OpenAPI visible.',
    '英文标签：receipt, mobile app, upload form, photo, text, drive9',
  ].join('\n');

  const tagsEn = tagsEnFromDrive9Meta({}, ['user tag'], semanticText);

  assert.deepEqual(tagsEn, ['user tag', 'receipt', 'mobile app', 'upload form']);
});

test('legacy fallback does not mine arbitrary words from semantic text', () => {
  const semanticText = [
    '中文摘要：上传页面',
    '英文摘要：Upload page screenshot',
    '英文描述：A screenshot of drive9 upload search openapi text inside a web app.',
  ].join('\n');

  const tagsEn = tagsEnFromDrive9Meta({}, [], semanticText);
  const tagsZh = tagsZhFromDrive9Meta({}, semanticText);

  assert.deepEqual(tagsEn, []);
  assert.deepEqual(tagsZh, []);
});

test('object semantic_text shape exposes both en and zh', () => {
  const result = buildDrive9SemanticResult({
    semantic_text: {
      zh: {
        caption: '白板会议',
        description: '办公室里有人在白板前讨论。',
        tags: ['白板', '会议'],
      },
      en: {
        caption: 'Whiteboard meeting',
        description: 'People discuss ideas in front of a whiteboard.',
        tags: ['whiteboard', 'meeting'],
      },
      ocr_text: ['Q2 Roadmap'],
    },
    tags: {},
  });

  assert.equal(result?.caption.en, 'Whiteboard meeting');
  assert.equal(result?.caption.zh, '白板会议');
  assert.deepEqual(result?.tags.en, ['whiteboard', 'meeting']);
  assert.deepEqual(result?.tags.zh, ['白板', '会议']);
  assert.match(result?.text.en || '', /英文摘要：Whiteboard meeting/);
  assert.match(result?.text.zh || '', /中文摘要：白板会议/);
  assert.match(result?.text.en || '', /图中文字：Q2 Roadmap/);
});

test('English-only semantic text leaves zh fields empty', () => {
  const semanticText = [
    '英文摘要：Cat on a sofa',
    '英文描述：A cat rests on a gray sofa.',
    '英文标签：cat, sofa, indoor',
  ].join('\n');

  assert.equal(captionEnFromDrive9Semantic(semanticText), 'Cat on a sofa');
  assert.equal(captionZhFromDrive9Semantic(semanticText), '');

  const tagsEn = tagsEnFromDrive9Meta({}, [], semanticText);
  const tagsZh = tagsZhFromDrive9Meta({}, semanticText);
  assert.deepEqual(tagsEn, ['cat', 'sofa', 'indoor']);
  assert.deepEqual(tagsZh, []);
});

test('Chinese-only semantic text leaves en fields empty', () => {
  const semanticText = [
    '中文摘要：秋季林荫道路',
    '中文描述：一条蜿蜒柏油路穿过金黄色树林。',
    '中文标签：秋季，林荫路，树木',
  ].join('\n');

  assert.equal(captionZhFromDrive9Semantic(semanticText), '秋季林荫道路');
  assert.equal(captionEnFromDrive9Semantic(semanticText), '');
  assert.deepEqual(tagsZhFromDrive9Meta({}, semanticText), ['秋季', '林荫路', '树木']);
  assert.deepEqual(tagsEnFromDrive9Meta({}, [], semanticText), []);
});

test('JSON string semantic_text is parsed before falling back to text lines', () => {
  const result = buildDrive9SemanticResult({
    semantic_text: JSON.stringify({
      caption_zh: '猫在沙发上',
      description_zh: '一只猫趴在灰色沙发上。',
      caption_en: 'Cat on a sofa',
      description_en: 'A cat rests on a gray sofa in a living room.',
      tags_zh: ['猫', '沙发', '客厅'],
      tags_en: ['cat', 'gray sofa', 'living room'],
    }),
    tags: {},
  });

  assert.equal(result?.caption.en, 'Cat on a sofa');
  assert.equal(result?.caption.zh, '猫在沙发上');
  assert.deepEqual(result?.tags.en, ['cat', 'gray sofa', 'living room']);
  assert.deepEqual(result?.tags.zh, ['猫', '沙发', '客厅']);
  assert.match(result?.text.en || '', /英文标签：cat, gray sofa, living room/);
  assert.match(result?.text.zh || '', /中文标签：猫；沙发；客厅/);
});

test('drive9.image.tag.zh.* tags are sorted by index like the en counterpart', () => {
  const tagsZh = tagsZhFromDrive9Meta({
    'drive9.image.tag.zh.2': '客厅',
    'drive9.image.tag.zh.0': '猫',
    'drive9.image.tag.zh.1': '沙发',
  });
  assert.deepEqual(tagsZh, ['猫', '沙发', '客厅']);
});

test('zh tags never inherit user-provided existingTags (en-only contract)', () => {
  const semanticText = [
    '英文摘要：Receipt screenshot',
    '英文标签：receipt, mobile app',
    '中文摘要：发票截图',
    '中文标签：发票，应用',
  ].join('\n');

  const tagsEn = tagsEnFromDrive9Meta({}, ['user-tag'], semanticText);
  const tagsZh = tagsZhFromDrive9Meta({}, semanticText);

  assert.ok(tagsEn.includes('user-tag'), 'en tags should still prepend existingTags');
  assert.ok(!tagsZh.includes('user-tag'), 'zh tags should not contain user-provided tags');
  assert.deepEqual(tagsZh, ['发票', '应用']);
});

test('JSON-string semantic_text with only en fields leaves zh side empty', () => {
  const result = buildDrive9SemanticResult({
    semantic_text: JSON.stringify({
      caption_en: 'Lone English caption',
      description_en: 'A photo with only English semantic data.',
      tags_en: ['lone', 'english', 'only'],
    }),
    tags: {},
  });

  assert.equal(result?.caption.en, 'Lone English caption');
  assert.equal(result?.caption.zh, '');
  assert.deepEqual(result?.tags.en, ['lone', 'english', 'only']);
  assert.deepEqual(result?.tags.zh, []);
  assert.equal(result?.text.zh, '');
  assert.match(result?.text.en || '', /英文摘要：Lone English caption/);
});

test('buildDrive9SemanticResult returns null when meta is empty or invalid', () => {
  assert.equal(buildDrive9SemanticResult(null), null);
  assert.equal(buildDrive9SemanticResult({}), null);
  assert.equal(buildDrive9SemanticResult({ semantic_text: '' }), null);
  assert.equal(buildDrive9SemanticResult({ semantic_text: '   \n  ' }), null);
});

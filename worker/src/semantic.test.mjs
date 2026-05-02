import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDrive9SemanticResult,
  captionFromDrive9Semantic,
  tagsFromDrive9Meta,
} from '../dist/semantic.js';

test('PR 372 semantic_text uses English summary and drive9.image English tags', () => {
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
      'drive9.image.tag.en.2': 'golden leaves',
      'drive9.image.tag.en.0': 'Autumn',
      'drive9.image.tag.en.1': 'tree-lined road',
    },
  };

  const result = buildDrive9SemanticResult(meta, ['manual', 'photovault']);

  assert.equal(result?.caption, 'Autumn tree-lined road');
  assert.deepEqual(result?.tags, ['manual', 'autumn', 'tree-lined road', 'golden leaves']);
  assert.match(result?.text || '', /中文摘要：秋季林荫道路/);
  assert.match(result?.text || '', /英文描述：A winding asphalt road/);
  assert.doesNotMatch(result?.tags.join(' ') || '', /photovault|structured_v1|image_extract|Inbox/i);
});

test('drive9 app and album metadata are never displayed as PhotoVault tags', () => {
  const tags = tagsFromDrive9Meta({
    app: 'photovault',
    album: 'Inbox',
    'drive9.image.schema': 'structured_v1',
    'drive9.image.source': 'image_extract',
    'drive9.image.tag.en.0': 'invoice',
    'drive9.image.tag.en.1': 'mobile screenshot',
  }, ['PhotoVault', 'receipt']);

  assert.deepEqual(tags, ['receipt', 'invoice', 'mobile screenshot']);
});

test('legacy fallback only parses explicit English tag line', () => {
  const semanticText = [
    '中文摘要：发票截图',
    '英文摘要：Receipt screenshot',
    '英文描述：A screenshot of a mobile app upload page with Drive9 and OpenAPI visible.',
    '英文标签：receipt, mobile app, upload form, photo, text, drive9',
  ].join('\n');

  const tags = tagsFromDrive9Meta({}, ['user tag'], semanticText);

  assert.deepEqual(tags, ['user tag', 'receipt', 'mobile app', 'upload form']);
});

test('legacy fallback does not mine arbitrary words from semantic text', () => {
  const semanticText = [
    '中文摘要：上传页面',
    '英文摘要：Upload page screenshot',
    '英文描述：A screenshot of drive9 upload search openapi text inside a web app.',
  ].join('\n');

  const tags = tagsFromDrive9Meta({}, [], semanticText);

  assert.deepEqual(tags, []);
});

test('object semantic_text shape uses en caption and en tags', () => {
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

  assert.equal(result?.caption, 'Whiteboard meeting');
  assert.deepEqual(result?.tags, ['whiteboard', 'meeting']);
  assert.match(result?.text || '', /英文摘要：Whiteboard meeting/);
  assert.match(result?.text || '', /图中文字：Q2 Roadmap/);
});

test('Chinese-only semantic text does not fall back to Chinese summary', () => {
  const caption = captionFromDrive9Semantic([
    '中文摘要：秋季林荫道路',
    '中文描述：一条蜿蜒柏油路穿过金黄色树林。',
    '中文标签：秋季，林荫路，树木',
  ].join('\n'));

  assert.equal(caption, '');
});

test('JSON string semantic_text is parsed before falling back to text lines', () => {
  const result = buildDrive9SemanticResult({
    semantic_text: JSON.stringify({
      caption_zh: '猫在沙发上',
      description_zh: '一只猫趴在灰色沙发上。',
      caption_en: 'Cat on a sofa',
      description_en: 'A cat rests on a gray sofa in a living room.',
      tags_en: ['cat', 'gray sofa', 'living room'],
    }),
    tags: {},
  });

  assert.equal(result?.caption, 'Cat on a sofa');
  assert.deepEqual(result?.tags, ['cat', 'gray sofa', 'living room']);
  assert.match(result?.text || '', /英文标签：cat, gray sofa, living room/);
});

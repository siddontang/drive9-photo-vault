import { useEffect, useState } from 'react';

export const COPY = {
  en: {
    tagline: 'Upload. Search. Organize.',
    api: 'API',
    choose: 'Choose photos',
    working: 'Working…',
    addOptions: 'Add tags',
    hideOptions: 'Hide options',
    placeholderTags: 'Tags, comma separated',
    placeholderAlbum: 'Album',
    placeholderNote: 'Note',
    searchPlaceholder: 'Search photos…',
    refresh: 'Refresh',
    all: 'All',
    statsPhotos: 'photos',
    statsFavorites: 'favorites',
    summary: 'Summary',
    showMore: 'show more',
    showLess: 'show less',
    tagsLabel: 'Tags',
    hide: 'hide',
    moreSuffix: (n) => `+${n} more`,
    delete: 'Delete',
    editTags: 'Edit tags',
    addTag: 'Add',
    manageTags: 'Delete',
    done: 'Done',
    removeTag: (tag) => `Remove ${tag}`,
    saveTags: 'Save',
    cancel: 'Cancel',
    addTagPlaceholder: 'New tag',
    tagEditorPlaceholder: 'Add / edit tags, comma separated',
    noTags: 'No tags yet',
    pending: 'drive9 analyzing… refresh/search again in a few seconds',
    empty: 'No photos yet. Tap "Choose photos" to start.',
    poweredBy: 'Powered by',
    coachMark: 'Tap to switch · 切换语言',
    details: 'Details',
    close: 'Close',
    previous: 'Previous photo',
    next: 'Next photo',
    info: 'Info',
    photoCounter: (idx, total) => `${idx} / ${total}`,
    noMetadata: 'No additional details',
    progressPreparing: (n) => `Preparing ${n} photo${n > 1 ? 's' : ''}…`,
    progressUploading: (name, idx, total) => `Uploading ${name} (${idx}/${total})…`,
    progressIndexing: (idx, total) => `Saving to drive9 and extracting image metadata (${idx}/${total})…`,
    progressIndexed: (name, idx, total) => `Indexed ${name} (${idx}/${total})…`,
    progressPending: (name) => `Uploaded ${name}. drive9 is still analyzing; tags will appear after refresh.`,
    progressRefreshing: 'Refreshing library…',
    progressDone: 'Done',
    errorLoad: (msg) => `Could not load photos: ${msg}`,
  },
  zh: {
    tagline: '上传 · 搜索 · 整理',
    api: '接口',
    choose: '选择照片',
    working: '处理中…',
    addOptions: '添加标签',
    hideOptions: '收起选项',
    placeholderTags: '标签，用逗号分隔',
    placeholderAlbum: '相册',
    placeholderNote: '备注',
    searchPlaceholder: '搜索照片…',
    refresh: '刷新',
    all: '全部',
    statsPhotos: '张照片',
    statsFavorites: '收藏',
    summary: '摘要',
    showMore: '展开',
    showLess: '收起',
    tagsLabel: '标签',
    hide: '收起',
    moreSuffix: (n) => `还有 ${n} 项`,
    delete: '删除',
    editTags: '编辑标签',
    addTag: '添加',
    manageTags: '删除',
    done: '完成',
    removeTag: (tag) => `删除 ${tag}`,
    saveTags: '保存',
    cancel: '取消',
    addTagPlaceholder: '新标签',
    tagEditorPlaceholder: '添加 / 修改标签，用逗号分隔',
    noTags: '暂无标签',
    pending: 'drive9 正在分析… 几秒后刷新或再次搜索即可看到结果',
    empty: '还没有照片，点击 "选择照片" 开始。',
    poweredBy: '由',
    coachMark: '切换语言 · Tap to switch',
    details: '详情',
    close: '关闭',
    previous: '上一张',
    next: '下一张',
    info: '详情',
    photoCounter: (idx, total) => `${idx} / ${total}`,
    noMetadata: '暂无更多信息',
    progressPreparing: (n) => `正在准备 ${n} 张照片…`,
    progressUploading: (name, idx, total) => `正在上传 ${name}（${idx}/${total}）…`,
    progressIndexing: (idx, total) => `正在写入 drive9 并提取图片信息（${idx}/${total}）…`,
    progressIndexed: (name, idx, total) => `已索引 ${name}（${idx}/${total}）…`,
    progressPending: (name) => `已上传 ${name}。drive9 仍在分析，刷新后会出现标签。`,
    progressRefreshing: '正在刷新照片库…',
    progressDone: '完成',
    errorLoad: (msg) => `加载照片失败：${msg}`,
  },
};

function detectInitialLang() {
  const saved = typeof localStorage !== 'undefined' && localStorage.photoVaultLang;
  if (saved === 'zh' || saved === 'en') return saved;
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

export function useLang() {
  const [lang, setLang] = useState(detectInitialLang);

  useEffect(() => {
    localStorage.photoVaultLang = lang;
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
  }, [lang]);

  return { lang, setLang, t: COPY[lang] };
}

export function fmtBytes(n = 0) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtDate(value, lang = 'en') {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

export function pickLangField(photo, lang, key) {
  const primary = photo[`${key}${lang === 'zh' ? 'Zh' : 'En'}`];
  const fallback = photo[`${key}${lang === 'zh' ? 'En' : 'Zh'}`];
  return primary || fallback || '';
}

export function pickLangTags(photo, lang) {
  const manual = Array.isArray(photo.tags) ? photo.tags.filter(Boolean) : [];
  if (manual.length) return [...new Set(manual)];
  const primary = lang === 'zh' ? photo.aiTagsZh : photo.aiTagsEn;
  const fallback = lang === 'zh' ? photo.aiTagsEn : photo.aiTagsZh;
  if (primary && primary.length) return [...new Set(primary.filter(Boolean))];
  if (fallback && fallback.length) return [...new Set(fallback.filter(Boolean))];
  return [];
}

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Check, Heart, Play, Plus, Search, Trash2, Upload } from 'lucide-react';
import './style.css';
import { useLang, pickLangField, pickLangTags, fmtBytes } from './i18n';
import Lightbox from './Lightbox';
import { reanchorIndex } from './lightboxNav.js';

const API = import.meta.env.VITE_API_BASE || '';
const apiUrl = (path) => `${API}${path}`;
const owner = localStorage.photoVaultOwner || (localStorage.photoVaultOwner = `guest-${crypto.randomUUID().slice(0, 8)}`);

function isVideo(photo) {
  if (photo.mediaKind === 'video') return true;
  return photo.mime && photo.mime.startsWith('video/');
}

function withViewTransition(update) {
  if (typeof document !== 'undefined' && document.startViewTransition) {
    document.startViewTransition(() => flushSync(update));
  } else {
    update();
  }
}

function guessTags(name) {
  const base = name.toLowerCase();
  const tags = [];
  if (/screen|shot/.test(base)) tags.push('screenshot');
  if (/food|coffee|lunch|dinner/.test(base)) tags.push('food');
  if (/trip|travel|beach|mountain/.test(base)) tags.push('travel');
  if (/dog|cat|pet/.test(base)) tags.push('pet');
  return tags.join(', ');
}

function normalizeTags(values) {
  return [...new Set(values
    .flatMap((value) => String(value || '').split(','))
    .map((x) => x.trim())
    .filter(Boolean))].slice(0, 24);
}

function TagEditor({ photo, tags, addDraft, removing, t, onFilter, onAddDraft, onAdd, onRemove, onToggleRemove, expanded, onToggleExpanded }) {
  const visible = expanded ? tags : tags.slice(0, 5);
  const isAdding = Object.prototype.hasOwnProperty.call(addDraft, photo.id);
  const isRemoving = !!removing[photo.id];
  return <div className="tagBlock tagManager">
    <div className="tagBlockHead">
      <span>{t.tagsLabel}</span>
      <div className="tagHeadActions">
        <button className="tagToolBtn add" onClick={() => onAddDraft(photo.id, '')} aria-label={t.addTag} title={t.addTag}><Plus size={15} /></button>
        {!!tags.length && <button className={isRemoving ? 'tagToolBtn remove on' : 'tagToolBtn remove'} onClick={() => onToggleRemove(photo.id)} aria-label={isRemoving ? t.done : t.manageTags} title={isRemoving ? t.done : t.manageTags}>{isRemoving ? <Check size={15} /> : <Trash2 size={14} />}</button>}
      </div>
    </div>
    <div className={isRemoving ? 'miniTags editableTags removing' : 'miniTags editableTags'}>
      {visible.map(tg => <span className="editableTag" key={tg}>
        <button className="tagName" onClick={() => onFilter(tg)}>{tg}</button>
        {isRemoving && <button className="tagRemove" onClick={() => onRemove(photo.id, tags, tg)} aria-label={t.removeTag(tg)}>−</button>}
      </span>)}
      {tags.length > 5 && <button className="moreTag" onClick={onToggleExpanded}>{expanded ? t.hide : t.moreSuffix(tags.length - 5)}</button>}
      {!tags.length && !isAdding && <span className="noTags">{t.noTags}</span>}
      {isAdding && <span className="addTagInline">
        <input
          value={addDraft[photo.id] || ''}
          onChange={(e) => onAddDraft(photo.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd(photo.id, tags); if (e.key === 'Escape') onAddDraft(photo.id, null); }}
          placeholder={t.addTagPlaceholder}
          autoFocus
        />
        <button className="saveTag" onClick={() => onAdd(photo.id, tags)}>+</button>
        <button className="cancelTag" onClick={() => onAddDraft(photo.id, null)}>×</button>
      </span>}
    </div>
  </div>;
}

function LangSwitch({ lang, setLang, t }) {
  const [showCoach, setShowCoach] = useState(() => !localStorage.photoVaultLangSeen);
  const dismissedRef = useRef(false);
  const dismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    setShowCoach(false);
    try { localStorage.photoVaultLangSeen = '1'; } catch {}
  };
  useEffect(() => {
    if (!showCoach) return;
    const id = setTimeout(dismiss, 6000);
    return () => clearTimeout(id);
  }, [showCoach]);

  const onPick = (next) => {
    setLang(next);
    dismiss();
  };

  return <div className="langWrap">
    <div className="langSwitch" role="group" aria-label="Language">
      <button className={lang === 'en' ? 'on' : ''} aria-pressed={lang === 'en'} onClick={() => onPick('en')}>EN</button>
      <button className={lang === 'zh' ? 'on' : ''} aria-pressed={lang === 'zh'} onClick={() => onPick('zh')}>中</button>
    </div>
    {showCoach && <button className="langCoach" onClick={dismiss}>{t.coachMark}</button>}
  </div>;
}

function App() {
  const { lang, setLang, t } = useLang();
  const [photos, setPhotos] = useState([]);
  const [collections, setCollections] = useState(null);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [expandedTags, setExpandedTags] = useState({});
  const [addTagDraft, setAddTagDraft] = useState({});
  const [removingTags, setRemovingTags] = useState({});
  const [expandedSummary, setExpandedSummary] = useState({});
  const [draft, setDraft] = useState({ tags: '' });
  const [lightboxId, setLightboxId] = useState(null);

  const lightboxIndex = lightboxId == null ? -1 : (reanchorIndex(photos, lightboxId) ?? -1);
  useEffect(() => {
    if (lightboxId != null && lightboxIndex < 0) setLightboxId(null);
  }, [lightboxId, lightboxIndex]);

  async function load() {
    setError('');
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    try {
      const [p, c] = await Promise.all([
        fetch(apiUrl(`/api/photos?${params}`), { cache: 'no-store' }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
        fetch(apiUrl('/api/collections'), { cache: 'no-store' }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      ]);
      setPhotos((p.photos || []).map((photo) => ({ ...photo, url: apiUrl(`/api/photos/${photo.id}/file`) })));
      setCollections(c);
    } catch (e) {
      setError(t.errorLoad(e.message || e));
      setTimeout(() => load(), 2500);
    }
  }

  useEffect(() => {
    const tid = setTimeout(load, 180);
    return () => clearTimeout(tid);
  }, [q, tag]);

  const PENDING_TIMEOUT_MS = 600_000;
  function isPendingTimedOut(photo) {
    if (photo.analysisStatus !== 'pending') return false;
    const created = new Date(photo.updatedAt || photo.createdAt).getTime();
    return !isNaN(created) && Date.now() - created > PENDING_TIMEOUT_MS;
  }

  useEffect(() => {
    const pendingItems = photos.filter(p => p.analysisStatus === 'pending' && !isPendingTimedOut(p));
    if (!pendingItems.length) return;
    const tid = setTimeout(load, 5000);
    return () => clearTimeout(tid);
  }, [photos]);

  async function upload(files) {
    if (!files?.length) return;
    setBusy(true);
    setProgress(t.progressPreparing(files.length));
    setError('');
    try {
      let done = 0;
      for (const file of files) {
        setProgress(t.progressUploading(file.name, done + 1, files.length));
        const fd = new FormData();
        fd.set('file', file);
        fd.set('owner', owner);
        fd.set('title', file.name.replace(/\.[^.]+$/, '') || 'Untitled photo');
        fd.set('tags', draft.tags || guessTags(file.name));
        fd.set('album', 'Inbox');
        fd.set('note', '');
        const res = await fetch(apiUrl('/api/photos'), { method: 'POST', body: fd });
        setProgress(t.progressIndexing(done + 1, files.length));
        if (!res.ok) throw new Error(await res.text());
        const payload = await res.json();
        if (payload?.photo?.analysisStatus === 'pending') {
          setProgress(t.progressPending(file.name));
        } else {
          setProgress(t.progressIndexed(file.name, done + 1, files.length));
        }
        done++;
      }
      setDraft({ tags: '' });
      setShowDetails(false);
      setProgress(t.progressRefreshing);
      await load();
      setProgress(t.progressDone);
      setTimeout(() => setProgress(''), 1800);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function patch(id, body) {
    const res = await fetch(apiUrl(`/api/photos/${id}`), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    await load();
  }
  function setTagDraft(id, value) {
    if (value == null) setAddTagDraft(({ [id]: _removed, ...rest }) => rest);
    else setAddTagDraft({ ...addTagDraft, [id]: value });
  }
  async function addPhotoTags(id, currentTags) {
    const next = normalizeTags([...currentTags, addTagDraft[id] || '']);
    if (next.length === currentTags.length && next.every((tg, i) => tg === currentTags[i])) return setTagDraft(id, null);
    try {
      setError('');
      await patch(id, { tags: next });
      setTagDraft(id, null);
    } catch (e) {
      setError(e.message || String(e));
    }
  }
  async function removePhotoTag(id, currentTags, tagName) {
    try {
      setError('');
      await patch(id, { tags: currentTags.filter((tg) => tg !== tagName) });
    } catch (e) {
      setError(e.message || String(e));
    }
  }
  function toggleRemoveTags(id) {
    setRemovingTags({ ...removingTags, [id]: !removingTags[id] });
  }
  async function remove(id) {
    await fetch(apiUrl(`/api/photos/${id}`), { method: 'DELETE' });
    await load();
  }

  const totals = collections?.totals || { photos: 0, favorites: 0, bytes: 0 };
  const tags = collections?.tags || [];

  return <main>
    <header className="topbar">
      <div>
        <h1>PhotoVault</h1>
        <p>{t.tagline}</p>
      </div>
      <div className="topbarActions">
        <LangSwitch lang={lang} setLang={setLang} t={t} />
        <a href={apiUrl('/openapi.json')} target="_blank" rel="noreferrer">{t.api}</a>
      </div>
    </header>

    <section className="uploadCard" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files); }}>
      <label className="uploadButton picker">
        <Upload size={22} />
        <span>{busy ? t.working : t.choose}</span>
        <input type="file" accept="image/*,video/mp4,video/quicktime,video/webm,video/x-msvideo,video/x-matroska" multiple onChange={e => upload(e.target.files)} />
      </label>
      <button className="plain" onClick={() => setShowDetails(!showDetails)}>{showDetails ? t.hideOptions : t.addOptions}</button>
      {showDetails && <div className="details tagsOnlyDetails">
        <input placeholder={t.placeholderTags} value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} />
      </div>}
      {progress && <div className={busy ? 'progress' : 'progress done'}>{progress}</div>}
      {error && <div className="error">{error}</div>}
    </section>

    <section className="searchCard">
      <label className="search"><Search size={18} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={t.searchPlaceholder} /></label>
      <div className="statsRow"><div className="stats">{totals.videos > 0 ? <><b>{totals.images || totals.photos}</b> {t.statsPhotos} · <b>{totals.videos}</b> {t.statsVideos} · </> : <><b>{totals.photos}</b> {t.statsPhotos} · </>}<b>{totals.favorites}</b> {t.statsFavorites} · <b>{fmtBytes(totals.bytes)}</b></div><button className="refresh" onClick={load}>{t.refresh}</button></div>
      <div className="chips">
        <button className={!tag ? 'active' : ''} onClick={() => setTag('')}>{t.all}</button>
        {tags.slice(0, 8).map(tg => <button key={tg.name} className={tag === tg.name ? 'active' : ''} onClick={() => setTag(tg.name)}>{tg.name}</button>)}
      </div>
    </section>

    <section className="grid">
      {photos.map(p => {
        const caption = pickLangField(p, lang, 'aiCaption');
        const photoTags = pickLangTags(p, lang);
        const vid = isVideo(p);
        return <article key={p.id} className="photo">
          <button
            className="photoOpen"
            type="button"
            onClick={() => withViewTransition(() => setLightboxId(p.id))}
          >
            {vid ? (
              <div
                className="videoThumb"
                style={lightboxId == null ? { viewTransitionName: `photo-${p.id}` } : undefined}
              >
                <span className="playBadge"><Play size={18} /></span>
                <span className="videoLabel">{p.title}</span>
              </div>
            ) : (
              <img
                src={p.url}
                loading="lazy"
                alt={p.title}
                style={lightboxId == null ? { viewTransitionName: `photo-${p.id}` } : undefined}
              />
            )}
          </button>
          <div className="photoInfo">
            <div className="title"><b>{p.title}</b><button className={p.favorite ? 'icon on' : 'icon'} onClick={() => patch(p.id, { favorite: !p.favorite })}><Heart size={17} /></button></div>
            <div className="sub">{p.album} · {fmtBytes(p.size)}</div>
            {p.analysisStatus === 'pending' && (
              isPendingTimedOut(p) ? <div className="pending timeout">{t.pendingTimeout}</div>
              : vid ? <div className="pending">{t.pendingVideo}</div>
              : <div className="pending">{t.pending}</div>
            )}
            {caption && p.analysisStatus !== 'pending' && <div className="summaryBox"><div className="summaryHead"><b>{t.summary}</b><button onClick={() => setExpandedSummary({ ...expandedSummary, [p.id]: !expandedSummary[p.id] })}>{expandedSummary[p.id] ? t.showLess : t.showMore}</button></div><div className={expandedSummary[p.id] ? 'summaryText expanded' : 'summaryText'}>{caption}</div></div>}
            <TagEditor
              photo={p}
              tags={photoTags}
              addDraft={addTagDraft}
              removing={removingTags}
              t={t}
              onFilter={setTag}
              onAddDraft={setTagDraft}
              onAdd={addPhotoTags}
              onRemove={removePhotoTag}
              onToggleRemove={toggleRemoveTags}
              expanded={!!expandedTags[p.id]}
              onToggleExpanded={() => setExpandedTags({ ...expandedTags, [p.id]: !expandedTags[p.id] })}
            />
            <button className="delete" onClick={() => remove(p.id)}><Trash2 size={15} /> {t.delete}</button>
          </div>
        </article>;
      })}
      {!photos.length && <div className="empty">{t.empty}</div>}
    </section>

    <footer className="footer">{t.poweredBy} <a href="https://drive9.ai" target="_blank" rel="noreferrer">drive9.ai</a></footer>

    {lightboxIndex >= 0 && (
      <Lightbox
        photos={photos}
        index={lightboxIndex}
        onClose={() => withViewTransition(() => setLightboxId(null))}
        onIndexChange={(i) => { const p = photos[i]; if (p) setLightboxId(p.id); }}
        onTagClick={(tagName) => withViewTransition(() => { setTag(tagName); setLightboxId(null); })}
        lang={lang}
        t={t}
      />
    )}
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);

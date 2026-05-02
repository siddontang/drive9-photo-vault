import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Heart, Search, Trash2, Upload } from 'lucide-react';
import './style.css';

const API = import.meta.env.VITE_API_BASE || 'https://drive9-photo-api.siddontang.workers.dev';
const owner = localStorage.photoVaultOwner || (localStorage.photoVaultOwner = `guest-${crypto.randomUUID().slice(0, 8)}`);

function fmt(n = 0) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
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

function App() {
  const [photos, setPhotos] = useState([]);
  const [collections, setCollections] = useState(null);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [draft, setDraft] = useState({ tags: '', album: 'Inbox', note: '' });

  async function load() {
    setError('');
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    const [p, c] = await Promise.all([
      fetch(`${API}/api/photos?${params}`).then(r => r.json()),
      fetch(`${API}/api/collections`).then(r => r.json())
    ]);
    setPhotos(p.photos || []);
    setCollections(c);
  }

  useEffect(() => {
    const t = setTimeout(load, 180);
    return () => clearTimeout(t);
  }, [q, tag]);

  async function upload(files) {
    if (!files?.length) return;
    setBusy(true);
    setError('');
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.set('file', file);
        fd.set('owner', owner);
        fd.set('title', file.name.replace(/\.[^.]+$/, '') || 'Untitled photo');
        fd.set('tags', draft.tags || guessTags(file.name));
        fd.set('album', draft.album || 'Inbox');
        fd.set('note', draft.note || '');
        const res = await fetch(`${API}/api/photos`, { method: 'POST', body: fd });
        if (!res.ok) throw new Error(await res.text());
      }
      setDraft({ tags: '', album: 'Inbox', note: '' });
      setShowDetails(false);
      await load();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function patch(id, body) {
    await fetch(`${API}/api/photos/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await load();
  }
  async function remove(id) {
    await fetch(`${API}/api/photos/${id}`, { method: 'DELETE' });
    await load();
  }

  const totals = collections?.totals || { photos: 0, favorites: 0, bytes: 0 };
  const tags = collections?.tags || [];

  return <main>
    <header className="topbar">
      <div>
        <h1>PhotoVault</h1>
        <p>Upload. Search. Organize.</p>
      </div>
      <a href={`${API}/openapi.json`} target="_blank">API</a>
    </header>

    <section className="uploadCard" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files); }}>
      <label className="uploadButton picker">
        <Upload size={22} />
        <span>{busy ? 'Uploading & analyzing…' : 'Choose photos'}</span>
        <input type="file" accept="image/*" multiple onChange={e => upload(e.target.files)} />
      </label>
      <button className="plain" onClick={() => setShowDetails(!showDetails)}>{showDetails ? 'Hide options' : 'Add tags / album'}</button>
      {showDetails && <div className="details">
        <input placeholder="Tags, comma separated" value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} />
        <input placeholder="Album" value={draft.album} onChange={e => setDraft({ ...draft, album: e.target.value })} />
        <input className="wide" placeholder="Note" value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} />
      </div>}
      {error && <div className="error">{error}</div>}
    </section>

    <section className="searchCard">
      <label className="search"><Search size={18} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search photos…" /></label>
      <div className="stats"><b>{totals.photos}</b> photos · <b>{totals.favorites}</b> favorites · <b>{fmt(totals.bytes)}</b></div>
      <div className="chips">
        <button className={!tag ? 'active' : ''} onClick={() => setTag('')}>All</button>
        {tags.slice(0, 8).map(t => <button key={t.name} className={tag === t.name ? 'active' : ''} onClick={() => setTag(t.name)}>{t.name}</button>)}
      </div>
    </section>

    <section className="grid">
      {photos.map(p => <article key={p.id} className="photo">
        <img src={p.url} loading="lazy" />
        <div className="photoInfo">
          <div className="title"><b>{p.title}</b><button className={p.favorite ? 'icon on' : 'icon'} onClick={() => patch(p.id, { favorite: !p.favorite })}><Heart size={17} /></button></div>
          <div className="sub">{p.album} · {fmt(p.size)}</div>
          {p.aiCaption && <div className="caption">{p.aiCaption}</div>}
          {!!p.tags.length && <div className="tagBlock"><span>Tags</span><div className="miniTags">{p.tags.map(t => <button key={t} onClick={() => setTag(t)}>{t}</button>)}</div></div>}
          <button className="delete" onClick={() => remove(p.id)}><Trash2 size={15} /> Delete</button>
        </div>
      </article>)}
      {!photos.length && <div className="empty">No photos yet. Tap “Choose photos” to start.</div>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);

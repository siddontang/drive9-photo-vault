import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Camera, Cloud, Heart, Images, Layers3, Search, Sparkles, Tag, Upload, Wand2, Trash2 } from 'lucide-react';
import './style.css';

const API = import.meta.env.VITE_API_BASE || 'https://drive9-photo-api.siddon.workers.dev';
const owner = localStorage.photoVaultOwner || (localStorage.photoVaultOwner = `guest-${crypto.randomUUID().slice(0, 8)}`);

function fmt(n) { return n > 1024 * 1024 ? `${(n/1024/1024).toFixed(1)} MB` : `${(n/1024).toFixed(0)} KB`; }
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
  const [activeTag, setActiveTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({ title: '', tags: '', album: 'Inbox', note: '' });
  const fileRef = useRef(null);

  async function load() {
    setError('');
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (activeTag) params.set('tag', activeTag);
    const [p, c] = await Promise.all([
      fetch(`${API}/api/photos?${params}`).then(r => r.json()),
      fetch(`${API}/api/collections`).then(r => r.json())
    ]);
    setPhotos(p.photos || []); setCollections(c);
  }
  useEffect(() => { const t = setTimeout(load, 180); return () => clearTimeout(t); }, [q, activeTag]);

  async function upload(files) {
    if (!files?.length) return;
    setBusy(true); setError('');
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.set('file', file);
        fd.set('owner', owner);
        fd.set('title', draft.title || file.name.replace(/\.[^.]+$/, ''));
        fd.set('tags', draft.tags || guessTags(file.name));
        fd.set('album', draft.album || 'Inbox');
        fd.set('note', draft.note || 'Uploaded into a Drive9-style photo workspace.');
        const res = await fetch(`${API}/api/photos`, { method: 'POST', body: fd });
        if (!res.ok) throw new Error(await res.text());
      }
      setDraft({ title: '', tags: '', album: 'Inbox', note: '' });
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }
  async function patch(id, body) {
    await fetch(`${API}/api/photos/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await load();
  }
  async function remove(id) {
    await fetch(`${API}/api/photos/${id}`, { method: 'DELETE' });
    await load();
  }
  const heroStats = collections?.totals || { photos: 0, favorites: 0, bytes: 0 };

  return <main>
    <section className="hero">
      <div>
        <div className="eyebrow"><Cloud size={16}/> Drive9-inspired photo workspace</div>
        <h1>Your iPhone photo roll, rebuilt for search-first humans.</h1>
        <p>Upload images from desktop or phone, tag them, favorite the keepers, detect duplicates, and search by context. Cloudflare Worker exposes the OpenAPI; drive9 stores the actual photo workspace.</p>
        <div className="actions"><label className="uploadButton" htmlFor="photo-upload"><Upload size={18}/> Upload photos</label><a href={`${API}/openapi.json`} target="_blank">OpenAPI</a></div>
      </div>
      <div className="statGrid">
        <div><Images/><b>{heroStats.photos}</b><span>photos</span></div>
        <div><Heart/><b>{heroStats.favorites}</b><span>favorites</span></div>
        <div><Layers3/><b>{fmt(heroStats.bytes || 0)}</b><span>stored</span></div>
      </div>
    </section>

    <section className="panel upload" onDragOver={e=>e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files); }}>
      <input id="photo-upload" ref={fileRef} className="fileInput" type="file" accept="image/*" multiple onChange={e => upload(e.target.files)} />
      <label className="drop" htmlFor="photo-upload"><Camera size={30}/><b>Tap to choose photos</b><span>Desktop also supports drag & drop. Max 25MB/image.</span></label>
      <div className="fields">
        <input placeholder="Title override (optional)" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/>
        <input placeholder="Tags: travel, receipt, whiteboard" value={draft.tags} onChange={e=>setDraft({...draft,tags:e.target.value})}/>
        <input placeholder="Album" value={draft.album} onChange={e=>setDraft({...draft,album:e.target.value})}/>
        <input placeholder="Note / memory" value={draft.note} onChange={e=>setDraft({...draft,note:e.target.value})}/>
      </div>
      {busy && <div className="hint"><Sparkles size={16}/> Uploading and indexing…</div>}
      {error && <div className="error">{error}</div>}
    </section>

    <section className="toolbar">
      <label><Search size={18}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search: beach, receipt, Siddon, whiteboard…" /></label>
      <button className={!activeTag ? 'active' : ''} onClick={()=>setActiveTag('')}>All</button>
      {(collections?.tags || []).slice(0,8).map(t => <button key={t.name} className={activeTag===t.name?'active':''} onClick={()=>setActiveTag(t.name)}><Tag size={14}/>{t.name} <small>{t.count}</small></button>)}
    </section>

    <section className="smart">
      {(collections?.smart || []).map(s => <div key={s.id}><Wand2 size={18}/><b>{s.name}</b><span>{s.count}</span></div>)}
      {(collections?.albums || []).slice(0,4).map(a => <div key={a.name}><Layers3 size={18}/><b>{a.name}</b><span>{a.count}</span></div>)}
    </section>

    <section className="grid">
      {photos.map(p => <article key={p.id} className="card">
        <img src={p.url} loading="lazy" />
        <div className="cardBody">
          <div className="row"><b>{p.title}</b><button className={p.favorite?'heart on':'heart'} onClick={()=>patch(p.id,{favorite:!p.favorite})}><Heart size={17}/></button></div>
          <p>{p.note || 'No note yet.'}</p>
          <div className="chips">{p.tags.map(t => <button key={t} onClick={()=>setActiveTag(t)}>{t}</button>)}</div>
          <div className="meta"><span>{p.album}</span><span>{fmt(p.size)}</span><button title="Delete" onClick={()=>remove(p.id)}><Trash2 size={15}/></button></div>
        </div>
      </article>)}
      {!photos.length && <div className="empty">No photos yet. Add a few and the workspace becomes useful fast.</div>}
    </section>
  </main>
}

createRoot(document.getElementById('root')).render(<App />);

import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Info, X } from 'lucide-react';
import { fmtBytes, pickLangField, pickLangTags } from './i18n';
import {
  canGoNext,
  canGoPrev,
  gestureAction,
  nextIndex as nextIdx,
  prevIndex as prevIdx,
} from './lightboxNav.js';

const IDLE_MS = 2500;
const SHEET_DRAG_THRESHOLD = 60;

export default function Lightbox({ photos, index, onClose, onIndexChange, lang, t }) {
  const photo = photos[index];
  const [showControls, setShowControls] = useState(true);
  const [showInfo, setShowInfo] = useState(() => {
    try { return localStorage.photoVaultLightboxInfo === '1'; } catch { return false; }
  });
  const [sheetDrag, setSheetDrag] = useState(0);
  const idleTimerRef = useRef(null);
  const swipeStartRef = useRef(null);
  const sheetStartRef = useRef(null);

  // Keyboard. Re-subscribed every render so the handler closes over the
  // latest showInfo / index without ref gymnastics.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        if (showInfo) toggleInfo(false);
        else onClose();
      } else if (e.key === 'ArrowLeft') {
        goPrev();
      } else if (e.key === 'ArrowRight') {
        goNext();
      } else if (e.key === 'i' || e.key === 'I') {
        toggleInfo(!showInfo);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Body scroll lock + focus restoration
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  // Idle auto-hide of top controls (and side arrows by extension)
  useEffect(() => {
    function ping() {
      setShowControls(true);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => setShowControls(false), IDLE_MS);
    }
    ping();
    window.addEventListener('mousemove', ping);
    window.addEventListener('touchstart', ping);
    window.addEventListener('keydown', ping);
    return () => {
      window.removeEventListener('mousemove', ping);
      window.removeEventListener('touchstart', ping);
      window.removeEventListener('keydown', ping);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  // Neighbor preloading: warm browser cache for prev/next photos
  const prevUrl = photos[index - 1]?.url;
  const nextUrl = photos[index + 1]?.url;
  useEffect(() => {
    for (const url of [prevUrl, nextUrl]) {
      if (!url) continue;
      const img = new Image();
      img.src = url;
    }
  }, [prevUrl, nextUrl]);

  function goPrev() {
    if (canGoPrev(index)) onIndexChange(prevIdx(index));
  }
  function goNext() {
    if (canGoNext(index, photos.length)) onIndexChange(nextIdx(index, photos.length));
  }
  function toggleInfo(open) {
    const next = typeof open === 'boolean' ? open : !showInfo;
    setShowInfo(next);
    try { localStorage.photoVaultLightboxInfo = next ? '1' : '0'; } catch {}
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) {
      swipeStartRef.current = null;
      return;
    }
    swipeStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchEnd(e) {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const t0 = e.changedTouches[0];
    const dx = t0.clientX - start.x;
    const dy = t0.clientY - start.y;
    const action = gestureAction(dx, dy);
    if (action === 'next') goNext();
    else if (action === 'prev') goPrev();
    else if (action === 'close') onClose();
  }

  function onSheetTouchStart(e) {
    e.stopPropagation();
    sheetStartRef.current = e.touches[0].clientY;
  }
  function onSheetTouchMove(e) {
    e.stopPropagation();
    if (sheetStartRef.current == null) return;
    const dy = e.touches[0].clientY - sheetStartRef.current;
    setSheetDrag(Math.max(0, dy));
  }
  function onSheetTouchEnd(e) {
    e.stopPropagation();
    const dy = sheetDrag;
    sheetStartRef.current = null;
    setSheetDrag(0);
    if (dy > SHEET_DRAG_THRESHOLD) toggleInfo(false);
  }

  if (!photo) return null;

  const caption = pickLangField(photo, lang, 'aiCaption');
  const tags = pickLangTags(photo, lang);
  const hasMetadata = !!caption || (tags && tags.length > 0);

  return (
    <div
      className={`lightbox${showControls ? ' controlsVisible' : ''}${showInfo ? ' infoVisible' : ''}${sheetDrag > 0 ? ' sheetDragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={photo.title}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="lightboxBackdrop" aria-hidden="true" />

      <div className="lightboxStage" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <img
          className="lightboxImage"
          src={photo.url}
          alt={photo.title}
          loading="eager"
          draggable={false}
        />
      </div>

      <div className="lightboxTopBar" aria-hidden={!showControls}>
        <button className="lightboxIconBtn" onClick={onClose} aria-label={t.close} title={t.close}>
          <X size={20} />
        </button>
        <div className="lightboxCounter">{t.photoCounter(index + 1, photos.length)}</div>
        <button
          className={`lightboxIconBtn${showInfo ? ' on' : ''}`}
          onClick={() => toggleInfo()}
          aria-label={t.info}
          aria-pressed={showInfo}
          title={t.info}
        >
          <Info size={20} />
        </button>
      </div>

      {canGoPrev(index) && (
        <button
          className="lightboxArrow left"
          onClick={goPrev}
          aria-label={t.previous}
          aria-hidden={!showControls}
          tabIndex={showControls ? 0 : -1}
        >
          <ChevronLeft size={28} />
        </button>
      )}
      {canGoNext(index, photos.length) && (
        <button
          className="lightboxArrow right"
          onClick={goNext}
          aria-label={t.next}
          aria-hidden={!showControls}
          tabIndex={showControls ? 0 : -1}
        >
          <ChevronRight size={28} />
        </button>
      )}

      <div
        className="lightboxBottomRow"
        role={hasMetadata ? 'button' : undefined}
        tabIndex={hasMetadata ? 0 : -1}
        onClick={hasMetadata ? () => toggleInfo() : undefined}
        onKeyDown={(e) => {
          if (!hasMetadata) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleInfo(); }
        }}
      >
        <div className="lightboxBottomText">
          <div className="lightboxTitle">{photo.title}</div>
          <div className="lightboxAlbum">{photo.album} · {fmtBytes(photo.size)}</div>
        </div>
        {hasMetadata && (
          <div className="lightboxDetailsHint">
            {t.details}
            <ChevronRight size={14} />
          </div>
        )}
      </div>

      <aside
        className="lightboxInfo"
        aria-hidden={!showInfo}
        inert={!showInfo}
        style={sheetDrag > 0 ? { '--sheetDrag': `${Math.min(sheetDrag, 200)}px` } : undefined}
      >
        <div
          className="lightboxSheetHandle"
          onTouchStart={onSheetTouchStart}
          onTouchMove={onSheetTouchMove}
          onTouchEnd={onSheetTouchEnd}
          aria-hidden="true"
        />
        <div className="lightboxInfoBody">
          <div className="lightboxInfoTitle">{photo.title}</div>
          <div className="lightboxInfoMeta">{photo.album} · {fmtBytes(photo.size)}</div>
          {caption && (
            <section className="lightboxInfoSection">
              <h4>{t.summary}</h4>
              <p>{caption}</p>
            </section>
          )}
          {!!tags.length && (
            <section className="lightboxInfoSection">
              <h4>{t.tagsLabel}</h4>
              <div className="lightboxInfoTags">
                {tags.map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            </section>
          )}
          {!hasMetadata && <p className="lightboxInfoEmpty">{t.noMetadata}</p>}
        </div>
      </aside>
    </div>
  );
}

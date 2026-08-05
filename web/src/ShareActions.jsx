import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, MessageCircle, Share2, X } from 'lucide-react';
import { facebookShareUrl, openSharePopup, xShareUrl } from './shareTargets.js';

function QrDialog({ url, title, t, onClose }) {
  const canvasRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, url, {
      width: 236,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111113', light: '#ffffff' },
    }).catch(() => {});
  }, [url]);

  return <div className="qrOverlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="qrDialog" role="dialog" aria-modal="true" aria-label={t.wechatQrTitle}>
      <button ref={closeRef} className="qrClose" type="button" onClick={onClose} aria-label={t.close}><X size={18} /></button>
      <div className="qrCanvas"><canvas ref={canvasRef} aria-label={t.wechatQrTitle} /></div>
      <h3>{t.wechatQrTitle}</h3>
      <p>{t.wechatQrBody}</p>
      <span>{title}</span>
    </section>
  </div>;
}

export default function ShareActions({ url, title, copied, canNativeShare, t, onCopy, onNativeShare, compact = false }) {
  const [showQr, setShowQr] = useState(false);
  const openX = () => openSharePopup(xShareUrl(url, title));
  const openFacebook = () => openSharePopup(facebookShareUrl(url));

  return <>
    <div className={compact ? 'socialShareBar compact' : 'socialShareBar'} role="group" aria-label={t.shareTo}>
      <button type="button" className="socialShareAction" onClick={openX} aria-label={t.shareX}>
        <span className="socialMark xMark" aria-hidden="true">X</span><span>{t.x}</span>
      </button>
      <button type="button" className="socialShareAction" onClick={openFacebook} aria-label={t.shareFacebook}>
        <span className="socialMark facebookMark" aria-hidden="true">f</span><span>{t.facebook}</span>
      </button>
      <button type="button" className="socialShareAction" onClick={() => setShowQr(true)} aria-label={t.shareWechat}>
        <span className="socialMark" aria-hidden="true"><MessageCircle size={19} /></span><span>{t.wechat}</span>
      </button>
      <button type="button" className={copied ? 'socialShareAction copied' : 'socialShareAction'} onClick={onCopy} aria-label={t.copyShareLink}>
        <span className="socialMark" aria-hidden="true">{copied ? <Check size={19} /> : <Copy size={18} />}</span><span>{copied ? t.copied : t.copy}</span>
      </button>
      {canNativeShare && <button type="button" className="socialShareAction native" onClick={onNativeShare} aria-label={t.shareNow}>
        <span className="socialMark" aria-hidden="true"><Share2 size={18} /></span><span>{t.more}</span>
      </button>}
    </div>
    {showQr && <QrDialog url={url} title={title} t={t} onClose={() => setShowQr(false)} />}
  </>;
}

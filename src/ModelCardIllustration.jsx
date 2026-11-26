import React from 'react';

export function ModelBrandBadge({ brand = 'custom', label = 'MODEL' }) {
  return (
    <span className={`mm-brand-badge is-${brand}`}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
        {brand === 'minimax' && (
          <>
            <path d="M2 12V4L6 9L10 4V12" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="miter" />
            <path d="M12.5 4V12" stroke="#48a685" strokeWidth="1.8" />
          </>
        )}
        {brand === 'flux' && (
          <>
            <polygon points="8,1.5 14.5,8 8,14.5 1.5,8" stroke="currentColor" strokeWidth="1.4" />
            <rect x="6" y="6" width="4" height="4" fill="#48a685" />
          </>
        )}
        {brand === 'qwen' && (
          <>
            <rect x="2.5" y="2.5" width="9" height="9" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8.5 8.5L13.5 13.5" stroke="#48a685" strokeWidth="1.8" />
          </>
        )}
        {brand === 'krea' && (
          <>
            <path d="M3 2.5V13.5M12.5 2.5L5.5 8L12.5 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="miter" />
          </>
        )}
        {brand === 'moss' && (
          <>
            <path d="M2.5 13V6.5L8 2.5L13.5 6.5V13" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="8" cy="9" r="2" fill="#48a685" />
          </>
        )}
        {brand === 'pixal3d' && (
          <>
            <polygon points="8,1.5 14,4.8 14,11.2 8,14.5 2,11.2 2,4.8" stroke="currentColor" strokeWidth="1.4" />
            <polyline points="2,4.8 8,8 14,4.8" stroke="#48a685" strokeWidth="1.4" />
            <line x1="8" y1="8" x2="8" y2="14.5" stroke="#48a685" strokeWidth="1.4" />
          </>
        )}
        {brand === 'seedvr' && (
          <>
            <rect x="2" y="5" width="6" height="6" stroke="currentColor" strokeWidth="1.4" />
            <rect x="6" y="2.5" width="8" height="8" stroke="#48a685" strokeWidth="1.5" fill="rgba(72,166,133,0.16)" />
          </>
        )}
        {(brand === 'lora' || brand === 'upscale' || brand === 'custom') && (
          <>
            <path d="M3 4H13M3 8H10M3 12H13" stroke="currentColor" strokeWidth="1.5" />
            <rect x="11" y="6.8" width="2.5" height="2.5" fill="#48a685" />
          </>
        )}
      </svg>
      <span>{label}</span>
    </span>
  );
}

export default function ModelCardIllustration({
  kind = 'custom',
  title = '',
  specTag = '',
  needsCover = false,
  active = false,
}) {
  const monogram = String(title || specTag || 'AI')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 12);

  return (
    <div className={`mm-card-fallback ${active ? 'is-ready' : 'is-uninstalled'} is-${kind}`} aria-hidden="true">
      <div className="mm-fallback-grid" />
      <div className="mm-fallback-center">
        <span className="mm-fallback-mono">{monogram}</span>
        {needsCover && <span className="mm-fallback-note">待生图封面</span>}
      </div>
    </div>
  );
}

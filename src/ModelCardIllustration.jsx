import React from 'react';

export default function ModelCardIllustration({ kind = 'custom', specTag = '', active = false }) {
  const accent = active ? '#48a685' : '#8a8a94';
  const strokeMain = active ? '#f7f7f3' : '#b8b8c0';
  const gridColor = '#1c1c21';

  return (
    <div className={`mm-card-visual ${active ? 'is-ready' : 'is-uninstalled'}`} aria-hidden="true">
      <svg viewBox="0 0 320 124" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id={`grid-${kind}`} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" stroke={gridColor} strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="320" height="124" fill="#0b0b0d" />
        <rect width="320" height="124" fill={`url(#grid-${kind})`} />

        {/* Corner technical registration ticks */}
        <path d="M10 16V10H16M304 10H310V16M10 108V114H16M304 114H310V108" stroke="#303038" strokeWidth="1.2" />

        {kind === 'video' && (
          <g>
            <rect x="64" y="24" width="192" height="58" stroke="#2e2e36" strokeWidth="1.2" fill="#101014" />
            <rect x="78" y="34" width="52" height="38" stroke={strokeMain} strokeWidth="1.5" fill="#15151a" />
            <rect x="136" y="34" width="52" height="38" stroke={accent} strokeWidth="1.5" fill="#141e1a" />
            <rect x="194" y="34" width="48" height="38" stroke="#454550" strokeWidth="1.2" strokeDasharray="3 3" />
            <polygon points="158,47 169,53 158,59" fill={strokeMain} />
            <line x1="64" y1="96" x2="256" y2="96" stroke="#2d2d35" strokeWidth="2" />
            <line x1="64" y1="96" x2="188" y2="96" stroke={accent} strokeWidth="2" />
            <rect x="184" y="91" width="6" height="10" fill={strokeMain} />
          </g>
        )}

        {kind === 'image' && (
          <g>
            <rect x="86" y="22" width="148" height="80" stroke={strokeMain} strokeWidth="1.5" fill="#101014" />
            <path d="M98 86L138 50L166 74L190 56L222 86Z" stroke={accent} strokeWidth="1.5" fill="#131e19" />
            <circle cx="196" cy="40" r="8" stroke={strokeMain} strokeWidth="1.4" />
            <line x1="72" y1="62" x2="86" y2="62" stroke="#3c3c46" strokeWidth="1.2" />
            <line x1="234" y1="62" x2="248" y2="62" stroke="#3c3c46" strokeWidth="1.2" />
          </g>
        )}

        {kind === 'edit' && (
          <g>
            <rect x="74" y="24" width="116" height="76" stroke="#3b3b44" strokeWidth="1.3" fill="#101014" />
            <rect x="130" y="32" width="116" height="70" stroke={strokeMain} strokeWidth="1.5" fill="#141418" />
            <rect x="150" y="46" width="52" height="36" stroke={accent} strokeWidth="1.5" strokeDasharray="4 3" fill="#15241e" />
            <path d="M214 48L230 64L214 80" stroke={strokeMain} strokeWidth="1.5" />
          </g>
        )}

        {kind === 'character' && (
          <g>
            {[0, 1, 2, 3].map((idx) => {
              const x = 66 + idx * 49;
              return (
                <g key={idx}>
                  <rect x={x} y="24" width="42" height="74" stroke={idx === 1 ? accent : strokeMain} strokeWidth="1.3" fill="#111115" />
                  <circle cx={x + 21} cy="45" r="7" stroke={idx === 1 ? accent : '#8e8e98'} strokeWidth="1.3" />
                  <path d={`M${x + 11} 82V66C${x + 11} 61 ${x + 31} 61 ${x + 31} 66V82`} stroke={idx === 1 ? accent : '#8e8e98'} strokeWidth="1.3" />
                </g>
              );
            })}
          </g>
        )}

        {kind === 'upscale' && (
          <g>
            <rect x="74" y="22" width="172" height="80" stroke={strokeMain} strokeWidth="1.5" fill="#101014" />
            <path d="M84 36H112V64H84Z" stroke="#454550" strokeWidth="1.2" strokeDasharray="2 2" />
            <rect x="160" y="22" width="86" height="80" stroke={accent} strokeWidth="1.5" fill="#131f1a" />
            <path d="M174 78L202 44L232 78" stroke={strokeMain} strokeWidth="1.6" />
            <path d="M122 50H148M142 44L148 50L142 56" stroke={accent} strokeWidth="1.6" />
          </g>
        )}

        {kind === 'lora' && (
          <g>
            <rect x="86" y="28" width="90" height="68" stroke="#454550" strokeWidth="1.3" fill="#101014" />
            <rect x="144" y="28" width="90" height="68" stroke={accent} strokeWidth="1.5" fill="#131f1a" fillOpacity="0.88" />
            <line x1="112" y1="62" x2="208" y2="62" stroke={strokeMain} strokeWidth="1.4" />
            <line x1="160" y1="38" x2="160" y2="86" stroke={strokeMain} strokeWidth="1.4" />
          </g>
        )}

        {(kind === 'encoder' || kind === 'custom') && (
          <g>
            <polygon points="160,22 214,44 214,82 160,104 106,82 106,44" stroke={strokeMain} strokeWidth="1.5" fill="#121216" />
            <polyline points="106,44 160,66 214,44" stroke={accent} strokeWidth="1.4" />
            <line x1="160" y1="66" x2="160" y2="104" stroke={accent} strokeWidth="1.4" />
          </g>
        )}
      </svg>
      {specTag && <span className="mm-card-spec">{specTag}</span>}
    </div>
  );
}

import React, { useRef, useState } from 'react';
import { useReactFlow, ViewportPortal } from '@xyflow/react';
import { GripHorizontal, Pencil, X } from 'lucide-react';
import { PRODUCTION_ZONE_TITLE_LIMIT } from './canvas-production-zones.js';
import './canvas-production-zones.css';

function ZoneFrame({ frame, editable, onEdit, onMove, onMoveEnd }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(frame.title);
  const dragRef = useRef(null);
  const { screenToFlowPosition } = useReactFlow();

  const pointerPoint = (event) => screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
  const beginMove = (event) => {
    event.stopPropagation();
    if (!editable || event.button !== 0 || !event.isPrimary || event.target.closest('button,input,form')) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, screenX: event.clientX, screenY: event.clientY, last: pointerPoint(event), moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!drag.moved && Math.hypot(event.clientX - drag.screenX, event.clientY - drag.screenY) < 4) return;
    const point = pointerPoint(event);
    const delta = { x: point.x - drag.last.x, y: point.y - drag.last.y };
    if ((delta.x || delta.y) && onMove(frame.id, delta)) {
      drag.last = point;
      drag.moved = true;
    }
  };
  const endMove = (event) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.type === 'pointerup') move(event);
    dragRef.current = null;
    if (drag.moved) onMoveEnd();
  };

  return <section className="production-zone-frame" aria-label={frame.title}
    style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
    <header className={'production-zone-header nopan' + (editable ? ' is-editable' : '')}
      onPointerDown={beginMove} onPointerMove={move} onPointerUp={endMove}
      onPointerCancel={endMove} onLostPointerCapture={endMove}
      onClick={(event) => event.stopPropagation()}>
      {editable && <GripHorizontal size={16} aria-hidden="true" />}
      {editing && editable ? <form onSubmit={(event) => {
        event.preventDefault(); onEdit(frame.id, draft); setEditing(false);
      }}>
        <input aria-label="生产分区名称" value={draft} maxLength={PRODUCTION_ZONE_TITLE_LIMIT}
          onChange={(event) => setDraft(event.target.value)} onFocus={(event) => event.target.select()}
          onBlur={() => { onEdit(frame.id, draft); setEditing(false); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); }
          }} autoFocus />
      </form> : <strong title={frame.title}>{frame.title}</strong>}
      {editable && <>
        {!editing && <button type="button" aria-label="重命名生产分区" title="重命名"
          onClick={() => { setDraft(frame.title); setEditing(true); }}><Pencil size={13} /></button>}
        <button type="button" aria-label="解散生产分区" title="解散分区"
          onClick={() => onEdit(frame.id, null)}><X size={14} /></button>
      </>}
    </header>
  </section>;
}

export default function ProductionZones({ frames, editable, onEdit, onMove, onMoveEnd }) {
  if (!frames.length) return null;
  return <ViewportPortal>{frames.map((frame) => <ZoneFrame key={frame.id}
    frame={frame} editable={editable}
    onEdit={onEdit} onMove={onMove} onMoveEnd={onMoveEnd} />)}</ViewportPortal>;
}

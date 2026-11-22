import { Circle, Line, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, easeOutCubic, easeOutQuint, waitFor, waitUntil } from '@motion-canvas/core';

export const MOTION_CANVAS_WIDTH = 1280;
export const MOTION_CANVAS_HEIGHT = 720;
export const MOTION_CANVAS_FPS = 60;

const FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif';
const COLORS = {
  background: '#10151f',
  divider: '#283340',
  card: '#1b2533',
  currentCard: '#26343d',
  foreground: '#f4f7fa',
  muted: '#b0bdcb',
  complete: '#86daca',
  active: '#ffb888',
};
const RAIL_X = -530;
const MARKER = 46;

function fitText(measure, value, width, preferred, minimum, weight) {
  let text = value.replace(/\s+/gu, ' ').trim();
  let size = preferred;
  measure.font = weight + ' ' + size + 'px ' + FONT;
  const naturalWidth = measure.measureText(text).width;
  if (naturalWidth > width) {
    size = Math.max(minimum, Math.floor(size * width / naturalWidth));
    measure.font = weight + ' ' + size + 'px ' + FONT;
  }
  if (measure.measureText(text).width > width) {
    const characters = [...text];
    while (characters.length && measure.measureText(characters.join('') + '…').width > width) {
      characters.pop();
    }
    text = characters.join('') + '…';
  }
  return { text, fontFamily: FONT, fontSize: size, fontWeight: weight };
}

function leftText(measure, text, { x, y, width, size, minimum, weight, fill }) {
  return new Txt({
    ...fitText(measure, text, width, size, minimum, weight),
    x, y, offsetX: -1, fill,
  });
}

export function makeVoiceCueScene(measure, { title, cues, durationMs }) {
  const events = cues.map((cue, index) => ({
    name: 'voice-cue-' + (index + 1),
    targetTime: cue.atMs / 1000,
  }));
  const cueFrames = cues.map(({ atMs }) => Math.ceil(atMs * MOTION_CANVAS_FPS / 1000));
  const rowGap = Math.min(149, 486 / cues.length);
  const rowHeight = Math.min(116, rowGap - 12);
  const firstRow = -154 + rowGap / 2;
  const rowAt = (index) => firstRow + rowGap * index;
  const dense = cues.length > 3;

  const scene = makeScene2D(function* (view) {
    // Motion Canvas schedules generators up to a frame ahead. Mask
    // their visuals until the media frame actually reaches the event.
    const visibleFrame = () => Math.round(view.globalTime() * MOTION_CANVAS_FPS);
    const cueVisible = (index) => visibleFrame() >= cueFrames[index];
    const active = () => cueFrames.findLastIndex((frame) => frame <= visibleFrame());
    view.add([
      new Rect({ size: [MOTION_CANVAS_WIDTH, MOTION_CANVAS_HEIGHT], fill: COLORS.background }),
      new Rect({ x: -508, y: -305, width: 78, height: 4, radius: 2, fill: COLORS.complete }),
      leftText(measure, title, {
        x: -550, y: -254, width: 1100, size: 64, minimum: 42, weight: 700, fill: COLORS.foreground,
      }),
      new Rect({ y: -194, width: 1100, height: 2, fill: COLORS.divider }),
    ]);
    if (cues.length > 1) {
      view.add(new Line({
        points: [[RAIL_X, rowAt(0)], [RAIL_X, rowAt(cues.length - 1)]],
        stroke: COLORS.divider, lineWidth: 3,
      }));
    }
    const links = cues.slice(1).map((_, index) => {
      const link = new Line({
        points: [[RAIL_X, rowAt(index)], [RAIL_X, rowAt(index + 1)]],
        stroke: COLORS.complete, lineWidth: 3, end: 0,
        opacity: () => cueVisible(index + 1) ? 1 : 0,
      });
      view.add(link);
      return link;
    });
    const rows = cues.map((cue, index) => {
      const y = rowAt(index);
      const isCurrent = () => active() === index;
      const accent = () => isCurrent() ? COLORS.active : COLORS.complete;
      view.add(new Circle({
        x: RAIL_X, y, size: MARKER, fill: COLORS.background, stroke: COLORS.divider, lineWidth: 2,
      }));

      const pulse = new Circle({ x: RAIL_X, y, size: MARKER, lineWidth: 3, stroke: accent, opacity: 0 });
      const marker = new Circle({
        x: RAIL_X, y, size: MARKER, fill: accent, opacity: 0,
        children: [new Txt({ text: String(index + 1), fontFamily: FONT, fontWeight: 700, fontSize: 25, fill: COLORS.background })],
      });
      const hasDetail = Boolean(cue.detail.trim());
      const body = leftText(measure, cue.detail, {
        x: -434, y: dense ? 22 : 27, width: 953, size: dense ? 27 : 31, minimum: 24, weight: 400, fill: COLORS.muted,
      });
      body.opacity(0);
      const card = new Node({
        x: 21, y, opacity: 0,
        children: [
          new Rect({
            x: 44, width: 1030, height: rowHeight, radius: 18,
            fill: () => isCurrent() ? COLORS.currentCard : COLORS.card, stroke: accent,
            lineWidth: () => isCurrent() ? 2 : 1,
          }),
          leftText(measure, cue.label, {
            x: -434, y: hasDetail ? (dense ? -17 : -20) : 0, width: 953,
            size: dense ? 38 : 46, minimum: 29, weight: 700, fill: COLORS.foreground,
          }),
          body,
        ],
      });
      view.add(new Node({
        opacity: () => cueVisible(index) ? 1 : 0,
        children: [pulse, marker, card],
      }));
      return { pulse, marker, card, body };
    });

    yield* all(
      ...rows.map(({ pulse, marker, card, body }, index) => (function* () {
        yield* waitUntil(events[index].name);
        marker.opacity(1);
        pulse.opacity(0.7);
        card.opacity(0.18);
        const motions = [
          card.x(0, 0.32, easeOutQuint),
          card.opacity(1, 0.24, easeOutCubic),
          pulse.size(MARKER + 38, 0.42, easeOutQuint),
          pulse.opacity(0, 0.42, easeOutCubic),
          waitFor(0.08, body.opacity(1, 0.26, easeOutCubic)),
        ];
        if (index > 0) motions.push(links[index - 1].end(1, 0.28, easeOutCubic));
        yield* all(...motions);
      })()),
      // Keep the scene alive until the end of the media selection.
      waitFor(durationMs / 1000 + 0.05),
    );
  });

  scene.meta.timeEvents.set(events);
  return scene;
}

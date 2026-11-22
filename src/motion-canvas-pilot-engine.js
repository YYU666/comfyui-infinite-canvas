import { Logger, PlaybackManager, PlaybackStatus, SharedWebGLContext, Vector2 } from '@motion-canvas/core';
import { ReadOnlyTimeEvents } from '@motion-canvas/core/lib/scenes/timeEvents/index.js';
import { makeVoiceCueScene, MOTION_CANVAS_FPS, MOTION_CANVAS_HEIGHT, MOTION_CANVAS_WIDTH } from './motion-canvas-pilot-scene.js';

export async function createMotionCanvasPreview(canvas, plan) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前页面无法初始化 Motion Canvas 画面。');

  canvas.width = MOTION_CANVAS_WIDTH;
  canvas.height = MOTION_CANVAS_HEIGHT;

  const description = makeVoiceCueScene(context, plan);
  const playback = new PlaybackManager();
  playback.fps = MOTION_CANVAS_FPS;
  const logger = new Logger();
  const sharedWebGLContext = new SharedWebGLContext(logger);
  const scene = new description.klass({
    ...description,
    name: 'refmuse-voice-cues',
    playback: new PlaybackStatus(playback),
    size: new Vector2(MOTION_CANVAS_WIDTH, MOTION_CANVAS_HEIGHT),
    resolutionScale: 1,
    logger,
    timeEventsClass: ReadOnlyTimeEvents,
    sharedWebGLContext,
  });
  playback.setup([scene]);

  let disposed = false;
  let pendingFrame = null;
  let displayedFrame = null;
  let inFlight = null;

  const releaseScene = () => {
    scene.getView().dispose();
    sharedWebGLContext.dispose();
  };

  const draw = () => {
    inFlight = (async () => {
      while (!disposed && pendingFrame !== null) {
        const frame = pendingFrame;
        pendingFrame = null;
        if (frame === displayedFrame) continue;
        await playback.seek(frame);
        if (disposed) return;
        if (pendingFrame !== null && pendingFrame !== frame) continue;
        await scene.render(context);
        displayedFrame = frame;
      }
    })().catch((error) => {
      pendingFrame = null;
      throw error;
    }).finally(() => {
      inFlight = null;
      if (disposed) releaseScene();
      else if (pendingFrame !== null) return draw();
    });
    return inFlight;
  };

  // All timing comes from the caller's media playhead. The engine never
  // advances itself on a second, independent audio or animation clock.
  const seek = (atMs) => {
    if (disposed || !Number.isFinite(atMs)) return Promise.resolve();
    const clamped = Math.max(0, Math.min(plan.durationMs, atMs));
    pendingFrame = Math.floor(clamped * MOTION_CANVAS_FPS / 1000);
    return inFlight ?? draw();
  };

  try {
    await seek(0);
  } catch (error) {
    releaseScene();
    throw error;
  }

  return {
    seek,
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingFrame = null;
      if (!inFlight) releaseScene();
    },
  };
}

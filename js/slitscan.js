// The slit-scan algorithm itself. This module is the one that matters for
// the native Swift port — see PORTING.md, which describes exactly what it
// does in platform-independent terms.
//
// Core idea: every sampled video frame contributes one narrow vertical
// strip, always cropped from the SAME fixed location (the horizontal
// centre of the source frame, full frame height). Strips are placed into
// the output canvas left-to-right in the order they were captured, so the
// output's horizontal axis represents TIME elapsed during the scan, not
// horizontal field of view. A subject that walks across the live camera
// view only appears in the output at the moment(s) it happens to be
// crossing the centre column — that's what produces slit-scan distortion
// instead of a panorama.

// --- Tunable algorithm parameters (hard-coded for v0.1; see PORTING.md) ---
const SLIT_WIDTH_SRC_PX = 3;        // width of the sampled source column, in source video pixels
const MAX_OUTPUT_WIDTH_PX = 6000;   // pre-allocated output canvas width; scan auto-stops when full

// RATE (v0.2): output growth is now driven by elapsed TIME, not by "one
// column per callback" — see PORTING.md "RATE". This is the RATE value
// that reproduces v0.1's original fixed-2px-per-frame behaviour at a
// typical ~30fps camera frame delivery rate (2px * 30fps = 60px/s).
export const DEFAULT_OUTPUT_PIXELS_PER_SECOND = 60;

// Ceiling on how much elapsed time a single sample may convert into output
// width. Without this, a single abnormally large gap between two frames'
// timestamps (e.g. camera autofocus stall, brief tab backgrounding, a
// delayed callback) would dump a correspondingly huge slice of width into
// one draw call — potentially consuming most of the output canvas in one
// step and ending the scan almost immediately. 200ms is generous next to
// a normal ~33ms frame interval (comfortably covers a missed frame or two)
// while bounding the damage from a genuine anomaly. This does not smooth
// or alter the sampled image content — it only bounds one timestamp delta.
const MAX_ELAPSED_MS_PER_SAMPLE = 200;

export class SlitScan {
  constructor(sourceVideo, outputCanvas) {
    this.video = sourceVideo;
    this.outputCanvas = outputCanvas;
    this.ctx = outputCanvas.getContext('2d', { alpha: false });
    this.cursorX = 0;
    this.lastSampleTimeMs = null;
    this.fractionalAdvance = 0;
  }

  /**
   * Must be called once real video dimensions are known. Output height is
   * taken directly from the camera's native frame height (not the CSS
   * display size) so the photographic resolution isn't limited by the
   * phone's screen — see PORTING.md "Resolution".
   */
  prepare() {
    const sourceHeight = this.video.videoHeight;
    this.outputCanvas.width = MAX_OUTPUT_WIDTH_PX;
    this.outputCanvas.height = sourceHeight;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
    this.cursorX = 0;
    this.lastSampleTimeMs = null;
    this.fractionalAdvance = 0;
  }

  isFull() {
    return this.cursorX >= MAX_OUTPUT_WIDTH_PX;
  }

  /**
   * Samples the current video frame's centre vertical strip and appends
   * it as the next column of the output image.
   *
   * `nowMs` is a wall-clock DOMHighResTimeStamp (ms) from the sampling
   * callback (requestVideoFrameCallback's or requestAnimationFrame's own
   * `now` argument) — not the media timeline's mediaTime, which is
   * unreliable for live getUserMedia camera streams in WebKit and can
   * fail to advance at all. Using elapsed real time between callbacks
   * still means scan speed isn't a simple function of callback count —
   * see PORTING.md "RATE".
   *
   * `outputPixelsPerSecond` (RATE) is the only thing that changed for
   * v0.2: it replaces v0.1's fixed per-callback column width with a
   * column width proportional to elapsed time, so total scan speed no
   * longer depends on how many callbacks the browser happens to deliver.
   *
   * Returns false if there was nothing to sample (no frame yet, or
   * output already full).
   */
  sampleFrame(nowMs, outputPixelsPerSecond) {
    if (this.isFull()) return false;

    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (!sourceWidth || !sourceHeight) return false;

    // First sample of a scan has no prior timestamp to measure elapsed
    // time against, so it seeds the clock and contributes no width yet.
    if (this.lastSampleTimeMs === null) {
      this.lastSampleTimeMs = nowMs;
      return true;
    }

    let elapsedMs = nowMs - this.lastSampleTimeMs;
    this.lastSampleTimeMs = nowMs;
    if (elapsedMs <= 0) return true; // duplicate/out-of-order timestamp; skip
    if (elapsedMs > MAX_ELAPSED_MS_PER_SAMPLE) elapsedMs = MAX_ELAPSED_MS_PER_SAMPLE;

    const dw = Math.round(outputPixelsPerSecond * (elapsedMs / 1000));
    if (dw > 0) this.appendStrip(dw);
    return true;
  }

  /**
   * SCAN mode (v0.3): advances the output by measured camera travel rather
   * than elapsed time — a displacement-driven film transport behind a
   * fixed slit. `panSourcePx` is the estimated pan since the previous frame
   * in source-video pixels (= output pixels, since output is 1:1 with the
   * source vertically; see PORTING.md "Displacement scaling").
   *
   * Sub-pixel pans are carried in a fractional accumulator so a slow pan of,
   * say, 0.4 px/frame still advances 2 px every 5 frames instead of being
   * rounded away. Only positive (rightward) pan builds the image in v0.3;
   * leftward pan is measured but contributes nothing (see PORTING.md
   * "Direction handling").
   *
   * Returns false if there was nothing to sample (no frame yet, or output
   * already full).
   */
  sampleFrameByDisplacement(panSourcePx) {
    if (this.isFull()) return false;
    if (!this.video.videoWidth || !this.video.videoHeight) return false;
    if (panSourcePx <= 0) return true;

    this.fractionalAdvance += panSourcePx;
    const dw = Math.floor(this.fractionalAdvance);
    this.fractionalAdvance -= dw;
    if (dw > 0) this.appendStrip(dw);
    return true;
  }

  // Draws the fixed centre slit of the current frame into the next `dw`
  // output columns. Shared by TIME and SCAN — the two modes differ only in
  // how `dw` is decided, never in what is sampled.
  appendStrip(dw) {
    const remaining = MAX_OUTPUT_WIDTH_PX - this.cursorX;
    if (dw > remaining) dw = remaining;

    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;

    // Fixed centre column — deliberately never tracks motion or content.
    const sx = Math.round(sourceWidth / 2 - SLIT_WIDTH_SRC_PX / 2);
    const sy = 0;
    const sw = SLIT_WIDTH_SRC_PX;
    const sh = sourceHeight;

    const dx = this.cursorX;
    const dy = 0;
    const dh = sourceHeight;

    // Scaling the sampled strip to dw controls how much horizontal space
    // this moment occupies in the final image; SLIT_WIDTH_SRC_PX is
    // independent — it controls how much of the sensor contributes to that
    // moment (wider = more temporal smearing per sample), not transport
    // speed. In SCAN mode a fast pan gives a large dw, so a 3px slice is
    // stretched wide: that visible streaking is the slit-scan construction,
    // not something to fill in from neighbouring source columns.
    this.ctx.drawImage(this.video, sx, sy, sw, sh, dx, dy, dw, dh);

    this.cursorX += dw;
  }

  /**
   * Returns a new canvas cropped to only the columns filled so far
   * (the pre-allocated output canvas is otherwise mostly black/unfilled).
   */
  getResultCanvas() {
    const width = Math.max(1, this.cursorX);
    const height = this.outputCanvas.height;
    const result = document.createElement('canvas');
    result.width = width;
    result.height = height;
    result.getContext('2d').drawImage(this.outputCanvas, 0, 0, width, height, 0, 0, width, height);
    return result;
  }
}

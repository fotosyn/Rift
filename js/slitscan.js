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
const OUTPUT_COLUMN_WIDTH_PX = 2;   // width the sampled strip is scaled to in the output image
const MAX_OUTPUT_WIDTH_PX = 6000;   // pre-allocated output canvas width; scan auto-stops when full

export class SlitScan {
  constructor(sourceVideo, outputCanvas) {
    this.video = sourceVideo;
    this.outputCanvas = outputCanvas;
    this.ctx = outputCanvas.getContext('2d', { alpha: false });
    this.cursorX = 0;
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
  }

  isFull() {
    return this.cursorX >= MAX_OUTPUT_WIDTH_PX;
  }

  /**
   * Samples the current video frame's centre vertical strip and appends
   * it as the next column(s) of the output image. Returns false if there
   * was nothing to sample (no frame yet, or output already full).
   */
  sampleFrame() {
    if (this.isFull()) return false;

    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (!sourceWidth || !sourceHeight) return false;

    // Fixed centre column — deliberately never tracks motion or content.
    const sx = Math.round(sourceWidth / 2 - SLIT_WIDTH_SRC_PX / 2);
    const sy = 0;
    const sw = SLIT_WIDTH_SRC_PX;
    const sh = sourceHeight;

    const dx = this.cursorX;
    const dy = 0;
    const dw = OUTPUT_COLUMN_WIDTH_PX;
    const dh = sourceHeight;

    // Scaling the sampled strip to OUTPUT_COLUMN_WIDTH_PX controls how
    // much horizontal space one moment in time occupies in the final
    // image; SLIT_WIDTH_SRC_PX is independent and controls how much of
    // the sensor contributes to that moment (wider = more temporal
    // smearing per sample).
    this.ctx.drawImage(this.video, sx, sy, sw, sh, dx, dy, dw, dh);

    this.cursorX += OUTPUT_COLUMN_WIDTH_PX;
    return true;
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

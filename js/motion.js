// SCAN-mode motion estimator. Measures how far the scene shifted
// horizontally between consecutive camera frames, so the output can be
// advanced by camera travel instead of by elapsed time. It only measures;
// it never moves the photographic slit (see PORTING.md "SCAN capture model").
//
// Method: brute-force 1-D block matching on a small, heavily downsampled
// luminance image of the centre of the frame. No CV library, no optical
// flow — deliberately the smallest transparent experiment.

// Estimator region, as fractions of the source frame, centred. Broad enough
// to contain texture to match against; the slit alone is too thin.
const REGION_WIDTH_FRAC = 0.6;
const REGION_HEIGHT_FRAC = 0.5;

// Downsampled estimator buffer. The browser's drawImage scaling does the
// downsample, which also low-pass filters sensor noise.
const EST_W = 160;
const EST_H = 60;

// Horizontal search range, in estimator pixels (± this value).
const MAX_SHIFT = 24;

// Confidence rules — see PORTING.md "Confidence test".
const MIN_TEXTURE = 1.5;        // mean |horizontal gradient|, luminance 0–255
const MAX_MATCH_ERROR = 20;     // best mean abs difference, luminance 0–255
const MAX_AMBIGUITY = 0.85;     // best / second-best error (lower = more distinct)
const SECOND_BEST_EXCLUSION = 3; // second-best must be ≥ this far from best

// Below this |shift| (estimator px) the camera is treated as stationary, so
// sensor noise and hand tremor don't creep the output forward.
const DEAD_ZONE_EST_PX = 0.35;

export function createMotionEstimator() {
  const canvas = document.createElement('canvas');
  canvas.width = EST_W;
  canvas.height = EST_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Two luminance buffers, swapped each frame to avoid per-frame allocation.
  let prev = new Float32Array(EST_W * EST_H);
  let cur = new Float32Array(EST_W * EST_H);
  let prevMean = 0;
  let hasPrev = false;
  const errors = new Float32Array(2 * MAX_SHIFT + 1);

  function reset() {
    hasPrev = false;
  }

  // Draws the centre region of the current video frame into the estimator
  // buffer and converts to zero-mean luminance. Zero-mean makes the match
  // tolerant of auto-exposure drift during a pan.
  function capture(video, out) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const rw = Math.round(vw * REGION_WIDTH_FRAC);
    const rh = Math.round(vh * REGION_HEIGHT_FRAC);
    ctx.drawImage(video, (vw - rw) / 2, (vh - rh) / 2, rw, rh, 0, 0, EST_W, EST_H);
    const px = ctx.getImageData(0, 0, EST_W, EST_H).data;

    let sum = 0;
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      // Rec. 601 luma.
      const y = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
      out[i] = y;
      sum += y;
    }
    const mean = sum / out.length;
    for (let i = 0; i < out.length; i++) out[i] -= mean;
    return rw;
  }

  // Mean |horizontal gradient| of a buffer: a cheap "is there anything to
  // match against?" measure. Blank walls and heavy blur score low.
  function texture(buf) {
    let sum = 0;
    for (let y = 0; y < EST_H; y++) {
      const row = y * EST_W;
      for (let x = 1; x < EST_W; x++) sum += Math.abs(buf[row + x] - buf[row + x - 1]);
    }
    return sum / (EST_H * (EST_W - 1));
  }

  // Mean absolute difference between prev[x] and cur[x + s] over the
  // columns where both exist. Mean (not sum) because overlap shrinks with |s|.
  function matchError(s) {
    const x0 = Math.max(0, -s);
    const x1 = Math.min(EST_W, EST_W - s);
    let sum = 0;
    for (let y = 0; y < EST_H; y++) {
      const row = y * EST_W;
      for (let x = x0; x < x1; x++) sum += Math.abs(prev[row + x] - cur[row + x + s]);
    }
    return sum / (EST_H * (x1 - x0));
  }

  /**
   * Returns the estimated horizontal CAMERA PAN since the previous frame.
   *
   * Sign convention: + = camera panning right (scene content moves left in
   * the image), which is the direction that builds the output left→right
   * un-mirrored. `panSourcePx` is already converted from estimator pixels
   * into source-video pixels, which equal output pixels (see PORTING.md).
   * It is 0 when the frame is rejected or inside the dead zone; the raw
   * signed value is still reported in `rawPanSourcePx` for the overlay.
   */
  function estimate(video) {
    const regionSourceWidth = capture(video, cur);
    const sourcePerEst = regionSourceWidth / EST_W;
    const tex = texture(cur);

    if (!hasPrev) {
      [prev, cur] = [cur, prev];
      hasPrev = true;
      return { panSourcePx: 0, rawPanSourcePx: 0, status: 'init', error: 0, ambiguity: 1, texture: tex, sourcePerEst };
    }

    let best = 0;
    for (let i = 0; i < errors.length; i++) {
      errors[i] = matchError(i - MAX_SHIFT);
      if (errors[i] < errors[best]) best = i;
    }
    let secondBest = Infinity;
    for (let i = 0; i < errors.length; i++) {
      if (Math.abs(i - best) >= SECOND_BEST_EXCLUSION && errors[i] < secondBest) secondBest = errors[i];
    }
    const bestErr = errors[best];
    const ambiguity = secondBest > 0 ? bestErr / secondBest : 1;

    // Parabolic sub-pixel refinement around the minimum. At ~4 source px per
    // estimator px, integer-only shifts would be far too coarse for slow pans.
    let shift = best - MAX_SHIFT;
    const atEdge = best === 0 || best === errors.length - 1;
    if (!atEdge) {
      const l = errors[best - 1];
      const r = errors[best + 1];
      const denom = l - 2 * bestErr + r;
      if (denom > 0) shift += Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / denom));
    }

    [prev, cur] = [cur, prev];

    // `shift` is how far scene content moved right; camera pan is the opposite.
    const rawPanSourcePx = -shift * sourcePerEst;

    let status = 'ok';
    if (tex < MIN_TEXTURE) status = 'flat';
    else if (atEdge) status = 'edge';
    else if (bestErr > MAX_MATCH_ERROR) status = 'poor';
    else if (ambiguity > MAX_AMBIGUITY) status = 'ambig';
    else if (Math.abs(shift) < DEAD_ZONE_EST_PX) status = 'still';

    return {
      panSourcePx: status === 'ok' ? rawPanSourcePx : 0,
      rawPanSourcePx,
      status,
      error: bestErr,
      ambiguity,
      texture: tex,
      sourcePerEst,
    };
  }

  return { estimate, reset };
}

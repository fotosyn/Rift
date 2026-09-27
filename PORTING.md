# RIFT v0.1–v0.3 — Porting Notes

This document describes the slit-scan photograph pipeline in
platform-independent terms, so it can be re-implemented natively (Swift /
AVFoundation / Core Image or Metal) without reverse-engineering the
JavaScript. The JS is a reference implementation of this pipeline, not the
spec itself.

## Camera pipeline

| Browser (this prototype)                          | Native iOS equivalent                                   |
|-----------------------------------------------------|-----------------------------------------------------------|
| `navigator.mediaDevices.getUserMedia()`             | `AVCaptureSession` + `AVCaptureDevice` (rear wide camera) |
| `<video>` element receiving the MediaStream         | `AVCaptureVideoDataOutput` delivering `CMSampleBuffer`s   |
| `video.requestVideoFrameCallback()`                 | `AVCaptureVideoDataOutputSampleBufferDelegate` callback   |
| `canvas.drawImage(video, ...)` (crop + scale)        | `CIImage` crop (`CGRect`) + `CIFilter`/`CIContext.render`, or a Metal compute pass sampling a `CVPixelBuffer`-backed texture |
| `<canvas>` accumulation buffer                       | Persistent `CVPixelBuffer` / `MTLTexture` written to incrementally |
| `canvas.toBlob('image/png')`                        | `CIContext.writePNGRepresentation` / `UIImage` + `UIImageWriteToSavedPhotosAlbum` |

The browser cannot access raw uncompressed frames as directly or as
cheaply as `AVCaptureVideoDataOutput` can; native code should get
noticeably better throughput and can run every step on the GPU.

## Slit-scan algorithm

**Where the slit is sampled**: the horizontal centre of the *source video
frame*, spanning the full frame height. The slit location is fixed in
source-pixel space and is recomputed from `video.videoWidth` each time in
case the camera renegotiates resolution — it is never derived from CSS/
screen coordinates.

```
sx = round(sourceWidth / 2 - slitWidth / 2)
sy = 0
sw = slitWidth
sh = sourceHeight
```

**Slit width**: `SLIT_WIDTH_SRC_PX = 3` source pixels (v0.1 hard-coded).
This is deliberately small — wide enough to be robust to pixel/sensor
noise, narrow enough that the horizontal axis of the output still reads as
"time," not "space."

**Sampling frequency**: one sample per delivered video frame, using
`video.requestVideoFrameCallback()` where available (Safari 15.4+), which
fires once per decoded frame and is driven by the camera's real frame
delivery, not the display refresh rate. Falls back to
`requestAnimationFrame()` (~display refresh rate, typically 60 Hz) on
browsers without frame callback support. No sample is dropped or
duplicated intentionally, but the spec explicitly does not require
capturing literally every camera frame — a frame missed because of a slow
main thread is acceptable; there's no timer-based re-request/backfill.

**How strips are accumulated**: a pre-allocated wide output canvas
(`MAX_OUTPUT_WIDTH_PX = 6000` px, height = native source frame height) is
filled left-to-right. Each sample's cropped source strip is scaled
(`drawImage` src-rect → dst-rect) into the next column, and a cursor
advances by that column's width. Scanning stops automatically when the
cursor reaches the canvas's pre-allocated width. On stop, the result is
cropped to only the columns actually written (`cursorX`), discarding the
unfilled remainder. As of v0.2, column width is derived from RATE and
elapsed time rather than being a fixed constant — see "RATE" below.

**How output coordinates are calculated**:

```
output.x = cursorX               // increments by dw (see RATE) per sample
output.y = 0 .. sourceHeight      // full source height, 1:1, no vertical resampling
cursorX += dw
```

The vertical axis of the output is an untouched 1:1 copy of the source
frame's vertical axis (no cropping, no resizing) — vertical position in
the photograph is real spatial position; only the horizontal axis encodes
time.

**How orientation is handled**: the app does not apply any manual
rotation or mirroring. It reads `video.videoWidth` / `video.videoHeight`
only after `loadedmetadata` fires, and assumes those dimensions already
reflect the device's current (portrait) orientation, because Safari on
iOS applies sensor-to-display orientation correction before exposing
`videoWidth`/`videoHeight` and before rendering to `<video>` or
`drawImage`. This is an **assumption, not a guarantee** — see "Browser
limitations" below. The rear camera is explicitly never mirrored
(no `scaleX(-1)` anywhere), matching what the photographer sees when
looking at the world, not a selfie view.

**How resolution is determined**: output height = `video.videoHeight`
(the camera's actual native captured frame height, requested via
`getUserMedia` constraints as `{ width: {ideal: 1920}, height: {ideal:
1080} }`), not the CSS/display size of the `<video>` element. This can
still be less than the sensor's maximum resolution — see "Resolution
compromises" below.

## RATE (v0.2)

RATE is the first UI-exposed creative control. It represents **temporal
scan speed** — how much output width is generated per second of real
elapsed capture time — not a change to the slit itself.

**Representation**: `outputPixelsPerSecond`, a plain number of output
pixels per second of elapsed *media* time. Exposed as a continuous
slider, range **15–240**, default **60**.

- **v0.1-equivalent / default value**: **60 px/s**. v0.1 advanced the
  output by a fixed 2px per delivered camera frame; at a typical iPhone
  rear-camera delivery rate of ~30 fps, that works out to `2 × 30 = 60`
  output px/s. 60 is therefore the closest reproduction of v0.1's
  behaviour achievable without measuring the exact device frame rate
  live — see "Compromises" below.
- **SLOW test value**: **20 px/s** (slider ~1/3 of default) — a given
  amount of subject motion spends more real time crossing the slit,
  producing proportionally more output width and stronger stretching.
- **NORMAL test value**: **60 px/s** (slider default) — v0.1 behaviour.
- **FAST test value**: **180 px/s** (3× default) — the same motion is
  compressed into much less output width.

**Effect on destination coordinates**: for each sampled frame,

```
elapsedMs = callback.now - previousCallback.now
dw = round(outputPixelsPerSecond * elapsedMs / 1000)
output.x = cursorX .. cursorX + dw
cursorX += dw
```

`dw` (destination column width) replaces v0.1's fixed constant; it is
derived per-sample rather than declared once. The source slit
(`sx`, `sy`, `sw`, `sh` — location and `SLIT_WIDTH_SRC_PX`) is completely
unaffected by RATE.

**Does RATE depend on camera/frame callback frequency?** No, by design —
that was the specific failure mode this change corrects. Instead of one
fixed-width column per callback (which made v0.1's implicit px/s rate a
function of frame delivery rate), `dw` scales with the *elapsed wall-clock
time* between callbacks, using each callback's own `now` argument
(a DOMHighResTimeStamp, from `requestVideoFrameCallback` or
`requestAnimationFrame`). Whether the camera or main thread delivers 24,
30, or 60 callbacks per second, the same RATE value produces the same
total output width for the same elapsed duration — a dropped frame just
makes the next `dw` larger (covering the missed time, up to the cap
below), not a change in overall image speed.

Note this deliberately does **not** use
`VideoFrameCallbackMetadata.mediaTime` (the frame's media-timeline
presentation timestamp), despite that being the more "correct" time
source in principle. In testing, WebKit's `mediaTime` proved unreliable
for a live `getUserMedia` camera stream (as opposed to a file-backed
`<video>`) — it did not reliably advance, which made every elapsed-time
computation read as ~zero and silently stopped the output from growing
at all. `now` (wall-clock) has no such dependency on the media timeline
and is reliable across both the `requestVideoFrameCallback` and
`requestAnimationFrame` paths. This is a **known browser limitation**,
not a native-port concern — see "Reproducing this in Swift" below, where
`CMSampleBuffer` presentation timestamps do not have this problem.

**Reproducing this in Swift with `AVCaptureVideoDataOutput`**: each
`CMSampleBuffer` carries a presentation timestamp via
`CMSampleBufferGetPresentationTimeStamp()` (a `CMTime`). Convert
consecutive timestamps' difference to seconds
(`CMTimeGetSeconds(current) - CMTimeGetSeconds(previous)`), multiply by
`outputPixelsPerSecond`, and use that as the destination column width —
identical structure to the JS above, but with a presentation timestamp
that is authoritative (frame-accurate, hardware-derived) rather than a
best-effort browser API.

**Per-sample elapsed time is capped at 200ms** (`MAX_ELAPSED_MS_PER_SAMPLE`
in `js/slitscan.js`) before being converted to output width. Without this,
one abnormally large gap between two frames' timestamps (autofocus stall,
brief backgrounding, a delayed callback) would convert into a
correspondingly huge slice of output width in a single draw, which could
exhaust the 6000px canvas — and end the scan — almost immediately. This
does not smooth or alter sampled image content; it only bounds how much
one timestamp gap can contribute.

**Compromises made because of Safari**: the 60 px/s "default = v0.1
behaviour" figure assumes a ~30fps camera delivery rate, which is
Safari's typical but not guaranteed rate on iPhone — actual device frame
rate is not directly queryable from `getUserMedia`/`MediaStreamTrack` in
a way this prototype relies on. If the real device rate differs, NORMAL
will be *close to* but not bit-for-bit identical to v0.1's original
output speed. This was judged acceptable per the brief ("as closely as
possible") rather than adding frame-rate detection, which would be a
larger change.

## SCAN capture model (v0.3, experimental)

RIFT now has two capture modes. They sample **exactly the same slit**
(fixed centre column, `SLIT_WIDTH_SRC_PX` wide, full height) and differ
only in how far the output advances per frame:

- **TIME** — output advances by elapsed time × RATE (v0.2, unchanged).
  Stationary camera; moving subjects are shaped by time.
- **SCAN** — output advances by the *measured horizontal travel of the
  scene* across the sensor. The photographer pans; a stationary camera
  produces (almost) no output.

The metaphor: **fixed optical slit + moving camera + displacement-
controlled film transport** — a strip camera whose film speed is slaved to
image motion. It is not a panorama: no stitching, blending, warping or
perspective correction, and only the centre slit is ever written into the
photograph. The motion estimator only decides transport distance.

### Algorithm (platform-independent)

Per camera frame:

1. **Frame acquisition** — one estimate per delivered frame, on the same
   callback that samples the slit. Consecutive frames are compared; if a
   frame is dropped, the next comparison simply sees a larger shift (no
   timestamp maths needed while it stays inside the search range).
2. **Timestamp handling** — displacement is per-frame, so SCAN transport
   does not use time at all. Timestamps (callback `now`) are used only for
   the diagnostic FPS readout (exponential moving average of
   `1000 / Δt`), so irregular callback spacing is visible as it really is.
3. **Comparison region** — centred rectangle, **60% of frame width × 50% of
   frame height** (portrait 1080×1920 → 648×960 source px). Broad enough
   to contain texture; the 3 px slit alone is not.
4. **Downsample** — region scaled to **160 × 60** estimator pixels
   (portrait: ≈4.05 source px per estimator px horizontally). The resample
   also low-passes sensor noise.
5. **Luminance** — Rec. 601 luma `Y = 0.299R + 0.587G + 0.114B`, then the
   buffer mean is subtracted (zero-mean) so auto-exposure drift during a
   pan doesn't bias the match.
6. **Horizontal search** — integer shifts `s ∈ [−24, +24]` estimator px
   (portrait ≈ ±97 source px/frame ≈ 2.7 frame widths/s at 30 fps).
   Minimum overlap is 136/160 columns (85%). No vertical search.
7. **Error metric** — mean absolute difference over the overlapping
   columns: `E(s) = mean |prev[x] − cur[x + s]|`. Mean, not sum, because
   the overlap shrinks as |s| grows.
8. **Sub-pixel refinement** — parabola through `E(best−1), E(best),
   E(best+1)`: `s += 0.5·(E₋ − E₊) / (E₋ − 2E₀ + E₊)`, clamped to ±0.5.
   Needed because one estimator px ≈ 4 source px: integer shifts alone
   would quantise slow pans to 0 or 4 px/frame.
9. **Confidence test** — the frame contributes **no advance** if any of:
   - `flat`: mean |horizontal gradient| of the current buffer < 1.5
     (luma 0–255) — blank wall, heavy blur, darkness;
   - `edge`: best shift is at ±24 — true motion probably out of range;
   - `poor`: best error > 20 — scene changed too much to trust;
   - `ambig`: best error / second-best error > 0.85, where second-best is
     the lowest error at least 3 estimator px from the best — repeating
     patterns or broad, featureless minima.
   Rule of thumb: weak evidence → no transport, never a guessed jump.
10. **Dead zone** — |s| < 0.35 estimator px (≈1.4 source px, portrait) is
    treated as stationary (`still`) and contributes nothing, so sensor
    noise and hand tremor don't creep the output.
11. **Displacement scaling** — `panSourcePx = −s × (regionSourceWidth / 160)`.
    Scene content moving left (s < 0) means the camera is panning right.
    Output pixels are 1:1 with source pixels (vertical is 1:1 already), so
    `panSourcePx` is directly the output advance that keeps proportions
    natural. An estimator pixel is **never** treated as a source pixel.
12. **Fractional accumulation** — `acc += panSourcePx; dw = floor(acc);
    acc −= dw`. Slow pans (e.g. 0.4 px/frame) still advance 2 px every 5
    frames rather than being rounded away. Reset at the start of each scan.
13. **Output advancement** — if `dw > 0`, the fixed centre slit of the
    *current* frame is stretched into `dw` output columns at `cursorX`
    (same draw as TIME). At fast pans a 3 px slice fills many columns,
    producing visible horizontal streaking — this is the slit-scan
    construction showing, and is intentionally not filled in from
    neighbouring source columns (that would be panorama stitching).
14. **Direction handling** — the sign is computed and displayed
    (+ = pan right). v0.3 **builds only on rightward pan**; leftward pan is
    measured but contributes nothing (the accumulator is untouched).
    Writing leftward pans right-to-left un-mirrored needs a different
    canvas origin and crop, deferred rather than rewriting accumulation.

### Moving subjects

The estimator cannot tell camera motion from subject motion, by design.
A subject filling a large part of the estimator region pulls the estimate
toward its own motion: with a stationary camera, a person walking left
through the frame reads as a rightward pan and *drives the transport* —
SCAN briefly becomes subject-coupled. A small subject is outvoted by the
background. Partial occlusion can also trip `poor` / `ambig`, pausing
transport. None of this is corrected.

### Likely native implementation

| Step | Browser (v0.3) | Native iOS candidate |
|------|----------------|----------------------|
| Frames | `getUserMedia` + `requestVideoFrameCallback` | `AVCaptureSession` + `AVCaptureVideoDataOutput` delegate |
| Timestamps | callback `now` (diagnostic only) | `CMSampleBufferGetPresentationTimeStamp` |
| Region + downsample | `drawImage` into 160×60 canvas | `CVPixelBuffer` Y plane (already luma in 420f/420v) + `vImageScale_Planar8` (Accelerate), or Core Image `CILanczosScaleTransform` |
| Readback | `getImageData` (GPU→CPU sync) | direct `CVPixelBufferGetBaseAddress` on the Y plane — no RGB→luma step |
| Search | JS loops over `Float32Array` | `vDSP` (Accelerate), or a Metal compute kernel computing all 49 SADs in parallel |
| Strip append | `drawImage` into canvas | Metal blit/compute into a persistent `MTLTexture` |

Natively the algorithm could run at full frame rate at higher estimator
resolution (e.g. 320 px wide) for finer sub-pixel accuracy. The JS is the
reference for behaviour, not the production architecture.

### Future: optical vs. gyroscope

Native RIFT should eventually compare this optical estimate with Core
Motion (`CMDeviceMotion.rotationRate`, yaw about the device's vertical
axis). Gyro pan converts to image displacement via the lens's focal length
in pixels (`Δx ≈ f_px · Δθ`), and is immune to blank walls, repeated
patterns and moving subjects — but it measures *camera rotation*, not
*image motion*, so it ignores subjects entirely and drifts over time. A
hybrid (gyro for robustness, optical for fine correction and for the
deliberately "wrong" subject-coupled behaviour) may prove best. Not
implemented: v0.3 specifically tests how much the image alone can tell us.

## Parameters (candidates for future creative controls)

All currently hard-coded (`js/slitscan.js`, `js/motion.js`), except RATE
and the TIME/SCAN mode, which are UI-exposed:

| Parameter               | Value | Effect                                                  |
|--------------------------|-----------------|----------------------------------------------------------|
| capture mode             | TIME / SCAN (v0.3) | What drives transport: elapsed time, or measured pan |
| `SLIT_WIDTH_SRC_PX`       | 3               | Width of sampled source column (motion blur / smearing per sample) |
| `outputPixelsPerSecond` (RATE) | 60 default, 15–240 range | TIME only: how fast the output grows through time — **UI-exposed in v0.2** |
| estimator region          | 60% × 50% of frame, centred | SCAN: what the motion estimate "looks at" |
| estimator size            | 160 × 60        | SCAN: precision vs. cost |
| `MAX_SHIFT`               | ±24 estimator px | SCAN: fastest trackable pan |
| `DEAD_ZONE_EST_PX`        | 0.35            | SCAN: stillness threshold (tremor rejection) |
| confidence thresholds     | tex 1.5, err 20, amb 0.85 | SCAN: how readily transport pauses on doubtful frames |
| `MAX_OUTPUT_WIDTH_PX`     | 6000            | Maximum output width / scan duration cap                 |
| sampling rate             | 1 per video frame (rVFC or rAF) | How often the slit is read |
| scan direction            | left → right, fixed | Not exposed; TIME always time-forward; SCAN builds on rightward pan only |
| slit position              | frame horizontal centre, fixed | Not exposed; only centre-slit supported |
| output resolution (height)| native `videoHeight` | Vertical fidelity of the photograph |

## Browser limitations (vs. a hypothetical native implementation)

- **No guaranteed raw frame access without a `<video>` element**: the
  browser decodes frames into a `<video>` element and we sample from
  that decoded output rather than a raw `CMSampleBuffer`-equivalent. This
  is fine for v0.1 but adds a decode step a native pipeline wouldn't need.
- **SCAN pixel readback**: the browser can only read frame pixels by
  drawing to a canvas and calling `getImageData` (a GPU→CPU sync, plus an
  RGB→luma conversion in JS). Native code reads the camera's luma plane
  directly. This is why the estimator is kept to 160×60.
- **`requestVideoFrameCallback` availability**: only Safari 15.4+; older
  WebKit falls back to `requestAnimationFrame`, decoupling sampling from
  actual camera frame delivery (display refresh rate instead).
- **No control over exact sensor resolution/format**: `getUserMedia`
  constraints are advisory (`ideal`), and Safari may silently deliver a
  different resolution than requested. Native `AVCaptureSession` offers
  exact format selection.
- **Photo library saving is not directly possible from Safari**: there is
  no web API equivalent to `UIImageWriteToSavedPhotosAlbum`. v0.1 exports
  via a `download` anchor to a `Blob` URL; on iOS Safari this typically
  opens the image rather than saving it directly, requiring the user to
  long-press → "Add to Photos" manually. This is a genuine platform gap
  a native app would not have.
- **Orientation correction is implicit and undocumented by the spec**:
  Safari's behavior of pre-rotating `videoWidth`/`videoHeight` for device
  orientation is observed behavior, not a documented contract. A native
  implementation must handle `AVCaptureConnection.videoRotationAngle` (or
  the older `videoOrientation`) explicitly rather than relying on this.

## Resolution compromises (v0.1)

- Requested via constraints as `ideal` 1920×1080; actual delivered
  resolution depends on the device and may be lower or a different aspect
  ratio.
- Output image height is capped at whatever `videoHeight` the browser
  delivers — no upscaling is performed.
- Output width is capped at a fixed 6000 px allocation for practicality
  (canvas memory / mobile Safari canvas size limits); at RATE = 60 px/s
  that is a ~100 second scan before auto-stop, scaling inversely with
  RATE (e.g. ~33 seconds at 180 px/s).

## Photographic parameters discovered

Parameters recorded here for their effect on the resulting photograph,
in terms of subject movement × time × resulting spatial geometry —
independent of the implementation details above.

### RATE

RATE sets how much elapsed real time is compressed into each unit of
output width. It governs the relationship between a subject's real-world
speed and its apparent shape in the final image:

- **Low RATE (SLOW)**: a fixed amount of subject motion through the slit
  is spread across *more* output width, because more time passes for the
  same distance of output. A subject moving through the frame is
  recorded as many more temporal slices, so its shape stretches
  horizontally — motion tends toward elongation, smearing, and, at the
  extreme, a subject can seem to move impossibly slowly or appear to
  "linger."
- **High RATE (FAST)**: the same motion is compressed into *less* output
  width — fewer temporal slices record it, so a subject appears
  compressed/foreshortened, and fast or brief motion may be reduced to a
  narrow sliver or missed between samples entirely.
- **Interaction with subject speed**: RATE does not have an absolute
  photographic effect on its own — it only has meaning relative to how
  fast something is actually moving through the slit. The same RATE value
  will stretch a slow-moving subject only slightly, but stretch a
  fast-moving one dramatically, since it is elapsed time (not object
  speed) that RATE converts into image width. This is the central thing
  the SLOW/NORMAL/FAST experiment is testing.
- **Stationary background**: unaffected in principle by RATE — a static
  scene should look similar (subject to sensor noise) at any RATE, since
  every sampled slice of it looks the same regardless of how much output
  width that slice occupies. RATE's visible effect is therefore
  concentrated on whatever is moving, which is what makes it useful as an
  experimental control rather than a global image filter.

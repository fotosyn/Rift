# RIFT v0.1/v0.2 — Porting Notes

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
elapsedMs = frame.mediaTime - previousFrame.mediaTime
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
function of frame delivery rate), `dw` scales with the *elapsed time*
between frames' presentation timestamps
(`VideoFrameCallbackMetadata.mediaTime`, from
`requestVideoFrameCallback`). Whether the camera or main thread delivers
24, 30, or 60 callbacks per second, the same RATE value produces the same
total output width for the same elapsed capture duration — a dropped
frame just makes the next `dw` larger (covering the missed time), not a
change in overall image speed. The one exception is the `requestAnimationFrame`
fallback path (browsers without `requestVideoFrameCallback`), which has no
media timestamp to read and falls back to wall-clock `performance.now()`
via the rAF callback's own timestamp — still time-based, just using
display time instead of media time.

**Reproducing this in Swift with `AVCaptureVideoDataOutput`**: each
`CMSampleBuffer` carries a presentation timestamp via
`CMSampleBufferGetPresentationTimeStamp()` (a `CMTime`). Convert
consecutive timestamps' difference to seconds
(`CMTimeGetSeconds(current) - CMTimeGetSeconds(previous)`), multiply by
`outputPixelsPerSecond`, and use that as the destination column width —
identical structure to the JS above, but with a presentation timestamp
that is authoritative (frame-accurate, hardware-derived) rather than a
best-effort browser API.

**Compromises made because of Safari**: the 60 px/s "default = v0.1
behaviour" figure assumes a ~30fps camera delivery rate, which is
Safari's typical but not guaranteed rate on iPhone — actual device frame
rate is not directly queryable from `getUserMedia`/`MediaStreamTrack` in
a way this prototype relies on. If the real device rate differs, NORMAL
will be *close to* but not bit-for-bit identical to v0.1's original
output speed. This was judged acceptable per the brief ("as closely as
possible") rather than adding frame-rate detection, which would be a
larger change.

## Parameters (candidates for future creative controls)

All currently hard-coded in `js/slitscan.js`, except RATE (see above),
which is now UI-exposed:

| Parameter               | v0.1/v0.2 value | Effect                                                  |
|--------------------------|-----------------|----------------------------------------------------------|
| `SLIT_WIDTH_SRC_PX`       | 3               | Width of sampled source column (motion blur / smearing per sample) |
| `outputPixelsPerSecond` (RATE) | 60 default, 15–240 range | How fast the output grows through time (image "speed") — **UI-exposed in v0.2** |
| `MAX_OUTPUT_WIDTH_PX`     | 6000            | Maximum output width / scan duration cap                 |
| sampling rate             | 1 per video frame (rVFC or rAF) | How often the slit is read |
| scan direction            | left → right, fixed | Not exposed; always time-forward, always left-to-right |
| slit position              | frame horizontal centre, fixed | Not exposed; only centre-slit supported |
| output resolution (height)| native `videoHeight` | Vertical fidelity of the photograph |

## Browser limitations (vs. a hypothetical native implementation)

- **No guaranteed raw frame access without a `<video>` element**: the
  browser decodes frames into a `<video>` element and we sample from
  that decoded output rather than a raw `CMSampleBuffer`-equivalent. This
  is fine for v0.1 but adds a decode step a native pipeline wouldn't need.
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

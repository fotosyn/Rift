# RIFT v0.1 — Porting Notes

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
(`drawImage` src-rect → dst-rect) into the next
`OUTPUT_COLUMN_WIDTH_PX = 2`-pixel-wide column, and a cursor advances by
that amount. Scanning stops automatically when the cursor reaches the
canvas's pre-allocated width. On stop, the result is cropped to only the
columns actually written (`cursorX`), discarding the unfilled remainder.

**How output coordinates are calculated**:

```
output.x = cursorX               // increments by OUTPUT_COLUMN_WIDTH_PX per sample
output.y = 0 .. sourceHeight      // full source height, 1:1, no vertical resampling
cursorX += OUTPUT_COLUMN_WIDTH_PX
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

## Parameters (candidates for future creative controls)

All currently hard-coded in `js/slitscan.js`:

| Parameter               | v0.1 value      | Effect                                                  |
|--------------------------|-----------------|----------------------------------------------------------|
| `SLIT_WIDTH_SRC_PX`       | 3               | Width of sampled source column (motion blur / smearing per sample) |
| `OUTPUT_COLUMN_WIDTH_PX`  | 2               | How much output width one sample occupies (image "speed") |
| `MAX_OUTPUT_WIDTH_PX`     | 6000            | Maximum output width / scan duration cap                 |
| sampling rate             | 1 per video frame (rVFC or rAF) | How often the slit is read |
| scan direction            | left → right, fixed | Not exposed; always time-forward, always left-to-right |
| slit position              | frame horizontal centre, fixed | Not exposed; only centre-slit supported |
| output resolution (height)| native `videoHeight` | Vertical fidelity of the photograph |

None of these are UI-exposed in v0.1, per spec.

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
  (canvas memory / mobile Safari canvas size limits); a real scan longer
  than `6000 / OUTPUT_COLUMN_WIDTH_PX` samples will be auto-stopped rather
  than growing indefinitely.

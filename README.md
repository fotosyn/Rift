# RIFT v0.1 — Slit-Scan Camera Experiment

Smallest possible mobile-web slit-scan camera. Plain HTML/CSS/JS, no build
step, no frameworks.

## Hosting

Needs to be served over HTTPS (camera access requires a secure context).
Any static HTTPS host works, e.g.:

```
npx serve .
# or
python3 -m http.server 8443 --bind 0.0.0.0   # then front with HTTPS/ngrok for real device testing
```

Open the served URL in mobile Safari on an iPhone, grant camera
permission, point the rear camera at something moving, tap **SCAN**, tap
**STOP**, then **SAVE**.

## Files

- `index.html` — layout: live camera view + slit guide, output canvas, controls.
- `style.css` — minimal dark UI.
- `js/camera.js` — camera acquisition (`getUserMedia`) only.
- `js/slitscan.js` — the slit-scan algorithm (sampling + accumulation). No DOM/UI code.
- `js/motion.js` — SCAN-mode horizontal motion estimator (v0.3).
- `js/main.js` — wiring: button states, sample loop, export.
- `PORTING.md` — the algorithm described for a native Swift/AVFoundation/Core Image port.

## Known limitations

- Saving to Photos on iOS Safari isn't direct — SAVE opens the image;
  long-press it and choose "Add to Photos." See PORTING.md.
- Orientation handling relies on Safari pre-rotating camera frame
  dimensions for portrait use; untested in landscape.
- Scan length is capped (~6000px output width) before auto-stopping.

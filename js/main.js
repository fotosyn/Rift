// UI wiring / state machine only. No image-processing logic lives here —
// that's all in slitscan.js. This file just: gets a camera, drives the
// sample loop while scanning, and hands off the result for export.

import { startCamera } from './camera.js';
import { SlitScan, DEFAULT_OUTPUT_PIXELS_PER_SECOND } from './slitscan.js';
import { createMotionEstimator } from './motion.js';

const videoEl = document.getElementById('camera');
const messageEl = document.getElementById('camera-message');
const outputCanvas = document.getElementById('output-canvas');
const outputView = document.getElementById('output-view');
const scanBtn = document.getElementById('scan-btn');
const resetBtn = document.getElementById('reset-btn');
const saveLink = document.getElementById('save-link');
const rateSlider = document.getElementById('rate-slider');
const rateValueEl = document.getElementById('rate-value');
const rateControl = document.getElementById('rate-control');
const modeTimeBtn = document.getElementById('mode-time');
const modeScanBtn = document.getElementById('mode-scan');
const debugOverlay = document.getElementById('debug-overlay');

let stream = null;
let slitScan = null;
let scanning = false;
let rvfcHandle = null;
let rafHandle = null;

// Capture mode: 'time' (output advances with elapsed time at RATE) or
// 'scan' (output advances with estimated camera pan). Fixed for a scan.
let mode = 'time';
const motion = createMotionEstimator();

// Diagnostics only (SCAN overlay). FPS comes from the callbacks' own
// timestamps, so irregular callback spacing shows up as it really is.
let lastFrameNow = null;
let fpsEma = 0;
let estimateMsEma = 0;

function setMode(next) {
  mode = next;
  modeTimeBtn.classList.toggle('active', mode === 'time');
  modeScanBtn.classList.toggle('active', mode === 'scan');
  rateControl.classList.toggle('scan-mode', mode === 'scan');
}

modeTimeBtn.addEventListener('click', () => setMode('time'));
modeScanBtn.addEventListener('click', () => setMode('scan'));

// RATE: output pixels per second of real elapsed capture time (see
// PORTING.md "RATE"). The slider's default reproduces v0.1's original
// behaviour as closely as possible.
rateSlider.value = String(DEFAULT_OUTPUT_PIXELS_PER_SECOND);
updateRateLabel();

function currentRate() {
  return Number(rateSlider.value);
}

function updateRateLabel() {
  rateValueEl.textContent = `${currentRate()} px/s`;
}

rateSlider.addEventListener('input', updateRateLabel);

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.classList.remove('hidden');
}

function hideMessage() {
  messageEl.classList.add('hidden');
}

async function init() {
  try {
    stream = await startCamera(videoEl);
    slitScan = new SlitScan(videoEl, outputCanvas);
    slitScan.prepare();
    scanBtn.disabled = false;
    hideMessage();
  } catch (err) {
    showMessage('Camera unavailable: ' + err.message + '\nCheck camera permission and reload.');
  }
}

// Drives one sample per available video frame. Prefers
// requestVideoFrameCallback (frame-accurate, throttles naturally to the
// camera's real delivery rate) and falls back to requestAnimationFrame
// (screen refresh rate) on browsers that lack it.
function scheduleNextSample() {
  if (!scanning) return;

  if (typeof videoEl.requestVideoFrameCallback === 'function') {
    rvfcHandle = videoEl.requestVideoFrameCallback(onFrame);
  } else {
    rafHandle = requestAnimationFrame(onFrame);
  }
}

function onFrame(now) {
  if (!scanning) return;

  // `now` (both callbacks' first argument) is a plain, always-advancing
  // DOMHighResTimeStamp (ms). We deliberately do NOT use
  // metadata.mediaTime from requestVideoFrameCallback here: for a live
  // getUserMedia camera stream (as opposed to a file-backed <video>),
  // WebKit's mediaTime is unreliable and can fail to advance at all,
  // which would make every elapsed-time computation read as zero and
  // silently stop the output from growing. `now` has no such dependency
  // on the media timeline.
  if (lastFrameNow !== null && now > lastFrameNow) {
    fpsEma = ema(fpsEma, 1000 / (now - lastFrameNow));
  }
  lastFrameNow = now;

  let stillHasRoom;
  if (mode === 'scan') {
    const t0 = performance.now();
    const m = motion.estimate(videoEl);
    estimateMsEma = ema(estimateMsEma, performance.now() - t0);
    stillHasRoom = slitScan.sampleFrameByDisplacement(m.panSourcePx);
    showDiagnostics(m);
  } else {
    stillHasRoom = slitScan.sampleFrame(now, currentRate());
  }
  autoScrollOutput();

  if (!stillHasRoom) {
    stopScan();
    return;
  }

  scheduleNextSample();
}

function ema(prev, value) {
  return prev === 0 ? value : prev * 0.9 + value * 0.1;
}

// Temporary engineering readout. Δ is the RAW signed pan estimate in source
// pixels per frame (+ = panning right, the direction that builds); the
// status says whether it was actually applied ('ok') or why not.
function showDiagnostics(m) {
  const sign = m.rawPanSourcePx >= 0 ? '+' : '';
  // A confident leftward pan is measured but doesn't build in v0.3.
  const status = m.status === 'ok' && m.rawPanSourcePx < 0 ? 'rev' : m.status;
  debugOverlay.textContent =
    `Δ ${sign}${m.rawPanSourcePx.toFixed(1)} px/f  ${status}\n` +
    `~${fpsEma.toFixed(0)} fps  est ${estimateMsEma.toFixed(1)} ms\n` +
    `err ${m.error.toFixed(1)}  amb ${m.ambiguity.toFixed(2)}  tex ${m.texture.toFixed(1)}\n` +
    `${videoEl.videoWidth}×${videoEl.videoHeight}  1e=${m.sourcePerEst.toFixed(2)}px  x ${slitScan.cursorX}`;
}

function autoScrollOutput() {
  // The canvas element's on-screen width is fixed (set by its intrinsic
  // width/height attributes plus CSS height:100%), so we can't just
  // scroll to "the end" - only slitScan.cursorX columns are actually
  // filled so far. Convert the filled fraction to on-screen pixels and
  // keep that growing edge just inside the visible area.
  const displayedWidth = outputCanvas.getBoundingClientRect().width;
  const scale = displayedWidth / outputCanvas.width;
  const edgeX = slitScan.cursorX * scale;
  outputView.scrollLeft = Math.max(0, edgeX - outputView.clientWidth * 0.9);
}

function startScan() {
  scanning = true;
  motion.reset();
  lastFrameNow = null;
  fpsEma = 0;
  estimateMsEma = 0;
  modeTimeBtn.disabled = true;
  modeScanBtn.disabled = true;
  debugOverlay.textContent = '';
  debugOverlay.classList.toggle('hidden', mode !== 'scan');
  scanBtn.textContent = 'STOP';
  scanBtn.classList.add('scanning');
  resetBtn.classList.add('hidden');
  saveLink.classList.add('hidden');
  scheduleNextSample();
}

function stopScan() {
  scanning = false;
  if (rvfcHandle !== null) videoEl.cancelVideoFrameCallback(rvfcHandle);
  if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  rvfcHandle = null;
  rafHandle = null;

  scanBtn.textContent = 'SCAN';
  scanBtn.classList.remove('scanning');
  scanBtn.disabled = true;
  resetBtn.classList.remove('hidden');

  exportResult();
}

function exportResult() {
  const result = slitScan.getResultCanvas();
  result.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    saveLink.href = url;
    saveLink.classList.remove('hidden');
  }, 'image/png');
}

function reset() {
  slitScan.prepare();
  modeTimeBtn.disabled = false;
  modeScanBtn.disabled = false;
  debugOverlay.classList.add('hidden');
  outputView.scrollLeft = 0;
  scanBtn.disabled = false;
  scanBtn.textContent = 'SCAN';
  resetBtn.classList.add('hidden');
  saveLink.classList.add('hidden');
}

scanBtn.addEventListener('click', () => {
  if (!scanning) {
    startScan();
  } else {
    stopScan();
  }
});

resetBtn.addEventListener('click', reset);

init();

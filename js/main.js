// UI wiring / state machine only. No image-processing logic lives here —
// that's all in slitscan.js. This file just: gets a camera, drives the
// sample loop while scanning, and hands off the result for export.

import { startCamera } from './camera.js';
import { SlitScan, DEFAULT_OUTPUT_PIXELS_PER_SECOND } from './slitscan.js';

const videoEl = document.getElementById('camera');
const messageEl = document.getElementById('camera-message');
const outputCanvas = document.getElementById('output-canvas');
const outputView = document.getElementById('output-view');
const scanBtn = document.getElementById('scan-btn');
const resetBtn = document.getElementById('reset-btn');
const saveLink = document.getElementById('save-link');
const rateSlider = document.getElementById('rate-slider');
const rateValueEl = document.getElementById('rate-value');

let stream = null;
let slitScan = null;
let scanning = false;
let rvfcHandle = null;
let rafHandle = null;

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
  const stillHasRoom = slitScan.sampleFrame(now, currentRate());
  autoScrollOutput();

  if (!stillHasRoom) {
    stopScan();
    return;
  }

  scheduleNextSample();
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

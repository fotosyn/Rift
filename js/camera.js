// Camera acquisition only. Knows nothing about slit-scanning, canvases,
// or UI state — this is the piece that gets swapped for AVCaptureSession
// in a native port (see PORTING.md).

/**
 * Requests the rear camera and attaches it to the given <video> element.
 * Resolves only once real frame dimensions (videoWidth/videoHeight) are
 * available, since those are wrong/zero until 'loadedmetadata' fires.
 */
export async function startCamera(videoEl) {
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      // Ideal, not exact: let the device pick the closest native mode
      // rather than failing if 1920x1080 isn't offered.
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;

  if (videoEl.readyState < 1 /* HAVE_METADATA */) {
    await new Promise((resolve) => {
      videoEl.addEventListener('loadedmetadata', resolve, { once: true });
    });
  }

  await videoEl.play();
  return stream;
}

export function stopCamera(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

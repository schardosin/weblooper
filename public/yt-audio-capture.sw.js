/**
 * Service Worker for intercepting YouTube audio streams.
 *
 * This allows us to capture the actual audio data that the YouTube player
 * is already streaming (from googlevideo.com) without making separate API calls
 * that get blocked by CORS/403.
 *
 * Current scope: Capture audio segments for a specific video ID when requested.
 */

const CAPTURED_SEGMENTS = new Map(); // videoId -> Array of { url, data: ArrayBuffer }

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
  const { type, videoId } = event.data || {};

  if (type === 'START_CAPTURE' && videoId) {
    CAPTURED_SEGMENTS.set(videoId, []);
    // Tell the client we're ready
    event.source?.postMessage({ type: 'CAPTURE_STARTED', videoId });
  }

  if (type === 'STOP_CAPTURE' && videoId) {
    const segments = CAPTURED_SEGMENTS.get(videoId) || [];
    event.source?.postMessage({ 
      type: 'CAPTURE_STOPPED', 
      videoId, 
      segmentCount: segments.length 
    });
  }

  if (type === 'GET_CAPTURED_AUDIO' && videoId) {
    const segments = CAPTURED_SEGMENTS.get(videoId) || [];
    // For now we just report back — full concatenation + decoding will happen in the main thread
    event.source?.postMessage({ 
      type: 'CAPTURED_AUDIO_DATA', 
      videoId, 
      segments: segments.map(s => ({ url: s.url, size: s.data.byteLength }))
    });
  }
});

// Intercept network requests
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Only care about YouTube media segments (googlevideo.com range requests)
  if (!url.includes('googlevideo.com') || !url.includes('range=')) {
    return;
  }

  // Try to extract video ID from the URL (it usually appears as /videoplayback or in the query)
  const videoIdMatch = url.match(/[?&]id=([^&]+)/) || url.match(/\/([a-zA-Z0-9_-]{11})\/videoplayback/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;

  if (!videoId || !CAPTURED_SEGMENTS.has(videoId)) {
    return;
  }

  // Clone the request so we can also let it go through normally
  const fetchRequest = event.request.clone();

  event.respondWith(
    fetch(fetchRequest).then(async (response) => {
      if (response.ok) {
        const buffer = await response.clone().arrayBuffer();

        // Only capture audio if it looks like an audio-only itag (rough heuristic)
        const isAudio = url.includes('itag=') && 
          (url.includes('itag=249') || url.includes('itag=250') || url.includes('itag=251') || // Opus
           url.includes('itag=139') || url.includes('itag=140') || url.includes('itag=141'));   // AAC

        if (isAudio) {
          const segments = CAPTURED_SEGMENTS.get(videoId);
          if (segments) {
            segments.push({
              url: url,
              data: buffer,
              timestamp: Date.now()
            });
          }
        }
      }
      return response;
    }).catch(() => {
      // If the original request fails, we still want the player to handle it
      return fetch(event.request);
    })
  );
});

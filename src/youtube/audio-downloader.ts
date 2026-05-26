/**
 * Audio downloader for YouTube formats.
 *
 * Supports:
 * - Direct `url` (when available)
 * - Basic DASH segmented audio via `baseUrl` (common for high-quality Opus)
 *
 * Note: Full signature deciphering for the `n` parameter is not yet implemented.
 * Some videos will fail or return lower quality formats until that is added.
 */

import type { AudioFormat } from './types'

export interface DownloadProgress {
  loadedBytes: number
  totalBytes?: number
  percent?: number
  phase: 'direct' | 'segments' | 'complete'
}

/**
 * Download a YouTube audio format into an ArrayBuffer.
 *
 * Tries direct URL first, then falls back to DASH segment downloading when only `baseUrl` is present.
 */
export async function downloadAudioFormat(
  format: AudioFormat,
  onProgress?: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  // 1. Try direct URL (easiest and most reliable when available)
  if (format.url) {
    return downloadDirectUrl(format.url, onProgress);
  }

  // 2. DASH segmented audio (most common for high quality)
  if (format.baseUrl) {
    return downloadDASHAudio(format, onProgress);
  }

  throw new Error(`No usable URL or baseUrl found for audio format itag=${format.itag}`);
}

async function downloadDirectUrl(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  onProgress?.({ loadedBytes: 0, phase: 'direct' });

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? Number(contentLength) : undefined;

  if (!response.body) {
    return await response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (value) {
      chunks.push(value);
      loadedBytes += value.byteLength;

      onProgress?.({
        loadedBytes,
        totalBytes,
        percent: totalBytes ? (loadedBytes / totalBytes) * 100 : undefined,
        phase: 'direct',
      });
    }
  }

  // Concatenate
  const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  onProgress?.({ loadedBytes: totalLength, totalBytes, percent: 100, phase: 'complete' });
  return result.buffer;
}

/**
 * Improved DASH audio downloader with limited concurrency.
 * Fetches multiple segments in parallel for significantly better speed on long videos.
 */
async function downloadDASHAudio(
  format: AudioFormat,
  onProgress?: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  if (!format.baseUrl) {
    throw new Error('baseUrl is required for DASH download');
  }

  onProgress?.({ loadedBytes: 0, phase: 'segments' });

  const baseUrl = format.baseUrl.endsWith('&') || format.baseUrl.endsWith('?')
    ? format.baseUrl
    : format.baseUrl + (format.baseUrl.includes('?') ? '&' : '?');

  // First, do a quick probe to estimate how many segments exist
  const estimatedSegments = await probeSegmentCount(baseUrl);
  const segmentsToFetch = Array.from({ length: estimatedSegments }, (_, i) => i);

  const chunks = new Array<Uint8Array | null>(estimatedSegments).fill(null);
  let loadedBytes = 0;
  const CONCURRENCY = 6; // Reasonable balance between speed and browser limits

  const fetchSegment = async (index: number) => {
    const url = `${baseUrl}sq/${index}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return;

      const buffer = await res.arrayBuffer();
      const uint8 = new Uint8Array(buffer);
      chunks[index] = uint8;
      loadedBytes += uint8.byteLength;

      onProgress?.({
        loadedBytes,
        percent: Math.min(99, Math.round((loadedBytes / (estimatedSegments * 180000)) * 100)), // rough estimate
        phase: 'segments',
      });
    } catch (err) {
      console.warn(`[youtube] Failed to fetch segment ${index}`, err);
    }
  };

  // Process in batches with limited concurrency
  for (let i = 0; i < segmentsToFetch.length; i += CONCURRENCY) {
    const batch = segmentsToFetch.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchSegment));
  }

  // Filter out any failed segments and concatenate
  const validChunks = chunks.filter((c): c is Uint8Array => c !== null);

  if (validChunks.length === 0) {
    throw new Error('No audio segments could be downloaded');
  }

  const totalLength = validChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of validChunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  onProgress?.({ loadedBytes: totalLength, percent: 100, phase: 'complete' });
  return result.buffer;
}

/** Probe to find roughly how many segments exist */
async function probeSegmentCount(baseUrl: string): Promise<number> {
  // Start with a reasonable guess and binary-search upward if needed.
  // For simplicity we start at 300 and increase.
  let guess = 300;
  while (guess < 5000) {
    const url = `${baseUrl}sq/${guess}`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        guess += 200;
      } else {
        return guess - 50; // rough last good segment
      }
    } catch {
      return Math.max(50, guess - 100);
    }
  }
  return guess;
}

/**
 * Helper: guess a reasonable filename for the audio.
 */
export function guessAudioFilename(info: { title: string; format: AudioFormat }): string {
  const safeTitle = info.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80)
  return `${safeTitle || 'youtube-audio'}.${info.format.ext}`
}

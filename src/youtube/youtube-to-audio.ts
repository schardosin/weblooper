/**
 * High-level pipeline: YouTube video ID → Decoded AudioBuffer ready for stem separation.
 *
 * Uses tab audio capture (getDisplayMedia API) to record the audio output from
 * the current browser tab while the YouTube video plays at normal speed.
 * This is 100% client-side and works on GitHub Pages without any backend.
 */

import { isTabAudioCaptureSupported, captureTabAudio } from './tab-audio-capture'
import type { CaptureResult } from './tab-audio-capture'
import type { DecodedAudio } from '../audio/decoder'

export interface YouTubeStemSource {
  videoId: string
  title: string
  decoded: DecodedAudio
}

/**
 * Given a YouTube video ID, extract audio suitable for stem separation.
 *
 * Uses tab audio capture (getDisplayMedia) — works on any deployment
 * including GitHub Pages with zero server dependencies.
 *
 * The caller must start video playback in the onPermissionGranted callback.
 * The video plays at normal speed and audio is recorded cleanly.
 */
export async function youtubeVideoToAudioBuffer(
  videoId: string,
  onProgress?: (message: string, percent?: number) => void,
  options?: { durationSeconds?: number; signal?: AbortSignal; onPermissionGranted?: () => void | Promise<void> }
): Promise<YouTubeStemSource> {
  // Tab audio capture is the primary extraction method.
  if (isTabAudioCaptureSupported()) {
    return await extractViaTabCapture(videoId, onProgress, options)
  }

  // Browser doesn't support tab audio capture — give helpful error
  throw new Error(
    'YouTube audio extraction requires tab audio capture (Chrome 94+ or Edge 94+).\n\n' +
    'Alternative method:\n' +
    '1. Download the audio using yt-dlp:\n' +
    '   yt-dlp -f bestaudio --extract-audio --audio-format opus "https://youtu.be/' + videoId + '"\n\n' +
    '2. Then load the downloaded file using "Load local audio file (for stems)".'
  )
}

/**
 * Extract audio by capturing the tab's audio output while the YouTube video plays.
 * Works on any deployment (GitHub Pages, etc.) — no server needed.
 *
 * Records at normal (1x) speed for clean, artifact-free audio.
 */
async function extractViaTabCapture(
  videoId: string,
  onProgress?: (message: string, percent?: number) => void,
  options?: { durationSeconds?: number; signal?: AbortSignal; onPermissionGranted?: () => void | Promise<void> }
): Promise<YouTubeStemSource> {
  const durationSeconds = options?.durationSeconds || getVideoDurationFromPage() || 300

  onProgress?.('Preparing audio capture from tab...', 0)

  const result: CaptureResult = await captureTabAudio({
    durationSeconds,
    signal: options?.signal,
    onPermissionGranted: options?.onPermissionGranted,
    onProgress: (info) => {
      switch (info.phase) {
        case 'permission':
          onProgress?.(info.message, 0)
          break
        case 'recording':
          onProgress?.(info.message, info.percent)
          break
        case 'processing':
          onProgress?.(info.message, 95)
          break
        case 'complete':
          onProgress?.(info.message, 100)
          break
      }
    },
  })

  // Get the video title from the page if possible
  const title = getVideoTitleFromPage() || `YouTube ${videoId}`

  return {
    videoId,
    title,
    decoded: {
      buffer: result.buffer,
      fileName: `${title}.webm`,
      duration: result.buffer.duration,
      sampleRate: result.buffer.sampleRate,
      numberOfChannels: result.buffer.numberOfChannels,
    },
  }
}

/**
 * Try to get the video duration from the YouTube player on the current page.
 */
function getVideoDurationFromPage(): number | null {
  try {
    const player = (window as any).YT?.get?.('yt-player') || (window as any).__ytPlayer
    if (player?.getDuration) {
      return player.getDuration()
    }
    // Try the global WebLooper instance
    const app = (window as any).__weblooper
    if (app?.player?.getDuration) {
      return app.player.getDuration()
    }
  } catch {}
  return null
}

/**
 * Try to get the video title from the page.
 */
function getVideoTitleFromPage(): string | null {
  try {
    // The app stores titles in the UI
    const titleEl = document.querySelector('#video-title, .video-title, [data-video-title]')
    if (titleEl?.textContent) return titleEl.textContent.trim()
  } catch {}
  return null
}

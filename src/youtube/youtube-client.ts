/**
 * YouTube client for extracting audio stream information.
 * Everything runs client-side in the browser. No external services.
 *
 * Uses multiple client configurations as fallbacks to maximize success rate.
 * YouTube frequently blocks certain client types — having alternatives helps.
 */

import type { AudioFormat, YouTubeVideoInfo } from './types'

// --- Client Configurations ---
// YouTube checks the client identity and returns different responses.
// We try multiple clients in order of reliability.

interface InnertubeClient {
  name: string
  clientName: string
  clientVersion: string
  platform?: string
  userAgent: string
  apiKey: string
  /** Some clients need extra context fields */
  extraContext?: Record<string, any>
  /** Some clients need extra body fields */
  extraBody?: Record<string, any>
}

const CLIENTS: InnertubeClient[] = [
  {
    // WEB client — the standard one used by the YouTube website.
    // Most likely to succeed for public videos.
    name: 'Web',
    clientName: 'WEB',
    clientVersion: '2.20250601.01.00',
    platform: 'DESKTOP',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_G9SN2FctQ',
  },
  {
    // WEB_EMBEDDED_PLAYER — what the iframe embed player uses.
    // Good fallback for embedded-restriction scenarios.
    name: 'Web Embedded',
    clientName: 'WEB_EMBEDDED_PLAYER',
    clientVersion: '2.20250601.01.00',
    platform: 'DESKTOP',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_G9SN2FctQ',
    extraContext: {
      thirdParty: {
        embedUrl: 'https://www.youtube.com/',
      },
    },
  },
  {
    // TVHTML5_SIMPLY_EMBEDDED_PLAYER — commonly used by yt-dlp.
    // Works well for music videos and many common content types.
    name: 'TV Embedded',
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    clientVersion: '2.0',
    userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/5.0 Chrome/85.0.4183.93 TV Safari/537.36',
    apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_G9SN2FctQ',
    extraContext: {
      thirdParty: {
        embedUrl: 'https://www.youtube.com/',
      },
    },
  },
  {
    // ANDROID client — more permissive than WEB for many videos.
    // Often returns direct URLs without signature ciphering.
    name: 'Android',
    clientName: 'ANDROID',
    clientVersion: '19.29.37',
    userAgent: 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    extraBody: {
      params: 'CgIQBg==', // Request only audio formats (yt-dlp technique)
    },
  },
  {
    // IOS client — another fallback, sometimes works when others don't.
    name: 'iOS',
    clientName: 'IOS',
    clientVersion: '19.29.1',
    userAgent: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
    apiKey: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  },
]

interface PlayerResponse {
  streamingData?: {
    adaptiveFormats?: any[]
    formats?: any[]
  }
  videoDetails?: {
    videoId: string
    title: string
    lengthSeconds: string
  }
  playabilityStatus?: {
    status: string
    reason?: string
  }
  playerConfig?: any
  assets?: any
}

/**
 * Fetch player response using a specific client configuration.
 * In development we go through the Vite proxy (/yt-api) to avoid CORS issues.
 * The proxy handles User-Agent spoofing since browsers forbid setting it in fetch().
 */
async function fetchWithClient(videoId: string, client: InnertubeClient): Promise<PlayerResponse> {
  const isDev = import.meta.env.DEV
  const base = isDev ? '/yt-api' : 'https://www.youtube.com'

  const url = `${base}/youtubei/v1/player?key=${client.apiKey}`

  const context: any = {
    client: {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      ...(client.platform ? { platform: client.platform } : {}),
    },
    ...(client.extraContext || {}),
  }

  const body: any = {
    context,
    videoId,
    ...(client.extraBody || {}),
  }

  // Note: User-Agent is a forbidden header in browsers — cannot be set via fetch().
  // In dev mode, the Vite proxy overrides it. In production, the browser's UA is used.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-YouTube-Client-Name': '1',
    'X-YouTube-Client-Version': client.clientVersion,
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const shortMessage = text.includes('<html>')
      ? `YouTube blocked the request (${client.name} client)`
      : text.slice(0, 200)
    throw new Error(`YouTube player request failed [${client.name}]: ${res.status} ${res.statusText}. ${shortMessage}`)
  }

  return res.json()
}

/**
 * Try multiple client configurations until one succeeds with streaming data.
 * This is the key resilience mechanism against YouTube's client-specific blocking.
 */
export async function fetchPlayerResponse(videoId: string): Promise<PlayerResponse> {
  const errors: string[] = []

  for (const client of CLIENTS) {
    try {
      const response = await fetchWithClient(videoId, client)

      const status = response.playabilityStatus?.status

      // Require explicitly OK status — YouTube uses many non-OK values:
      // ERROR, UNPLAYABLE, LOGIN_REQUIRED, CONTENT_CHECK_REQUIRED, etc.
      if (status !== 'OK') {
        const reason = response.playabilityStatus?.reason || status || 'unknown status'
        errors.push(`[${client.name}] ${reason}`)
        continue
      }

      // Also verify we actually got usable streaming data
      if (!response.streamingData?.adaptiveFormats?.length && !response.streamingData?.formats?.length) {
        errors.push(`[${client.name}] OK status but no streaming data (formats blocked for this client)`)
        continue
      }

      // We got a usable response: OK status + actual streaming data
      console.log(`[youtube] Successfully fetched player response using ${client.name} client`)
      return response

    } catch (err: any) {
      errors.push(`[${client.name}] ${err.message}`)
      // Continue to next client
    }
  }

  // All clients failed — determine what kind of error to report
  const allVideoUnavailable = errors.every(e =>
    e.includes('Video unavailable') ||
    e.includes('unavailable') ||
    e.includes('not available') ||
    e.includes('private video') ||
    e.includes('deleted')
  )

  if (allVideoUnavailable) {
    throw new Error(
      `This video is unavailable (it may be private, deleted, or geo-restricted).\n\n` +
      `Details:\n${errors.map(e => `  ${e}`).join('\n')}`
    )
  }

  throw new Error(
    `YouTube audio extraction failed with all client configurations.\n\n` +
    `Errors:\n${errors.map(e => `  ${e}`).join('\n')}\n\n` +
    `This usually means YouTube is actively blocking automated access.`
  )
}

/**
 * Parse the player response and extract usable audio-only formats.
 */
export function parseAudioFormats(playerResponse: PlayerResponse): AudioFormat[] {
  const formats: AudioFormat[] = []
  const adaptive = playerResponse.streamingData?.adaptiveFormats ?? []

  for (const f of adaptive) {
    const mime = f.mimeType || ''
    if (!mime.startsWith('audio/')) continue

    const isWebM = mime.includes('webm')
    const isMP4 = mime.includes('mp4')

    const format: AudioFormat = {
      itag: f.itag,
      mimeType: mime,
      bitrate: f.bitrate,
      averageBitrate: f.averageBitrate,
      contentLength: f.contentLength ? Number(f.contentLength) : undefined,
      url: f.url,
      baseUrl: f.baseUrl,
      audioQuality: f.audioQuality,
      audioSampleRate: f.audioSampleRate,
      audioChannels: f.audioChannels,
      isAdaptive: true,
      ext: isWebM ? 'webm' : isMP4 ? 'm4a' : 'audio',
    }

    formats.push(format)
  }

  // Sort by quality (prefer higher bitrate / higher quality label)
  formats.sort((a, b) => {
    const qa = qualityScore(a)
    const qb = qualityScore(b)
    return qb - qa
  })

  return formats
}

function qualityScore(format: AudioFormat): number {
  let score = format.bitrate ?? format.averageBitrate ?? 0

  if (format.audioQuality === 'AUDIO_QUALITY_HIGH') score += 100000
  else if (format.audioQuality === 'AUDIO_QUALITY_MEDIUM') score += 50000

  // Strongly prefer Opus (webm) for quality/size
  if (format.mimeType.includes('opus')) score += 30000

  return score
}

/**
 * Enhanced video info that also includes data needed for signature deciphering.
 */
export interface YouTubeVideoInfoWithPlayer extends YouTubeVideoInfo {
  /** URL to the player JS (needed for signature / n-parameter deciphering) */
  playerUrl?: string;
  /** Raw player response (for advanced use) */
  rawPlayerResponse: any;
}

/**
 * High level helper: get video info + best audio format for a given video ID.
 * Also attempts to extract the player JS URL for signature deciphering.
 */
export async function getYouTubeVideoAudioInfo(videoId: string): Promise<YouTubeVideoInfoWithPlayer> {
  const player = await fetchPlayerResponse(videoId)

  if (player.playabilityStatus?.status !== 'OK') {
    throw new Error(player.playabilityStatus?.reason || 'Video is not playable')
  }

  const details = player.videoDetails
  if (!details) throw new Error('Missing video details in player response')

  const audioFormats = parseAudioFormats(player)

  // Try to find the player JS URL (important for deciphering)
  const playerConfig = (player as any)?.playerConfig;
  const assets = (player as any)?.assets;

  const playerUrl =
    playerConfig?.mediaCommonConfig?.url ||
    assets?.js ||
    null;

  return {
    videoId: details.videoId,
    title: details.title || 'Unknown title',
    durationSeconds: Number(details.lengthSeconds) || 0,
    audioFormats,
    bestAudioFormat: audioFormats[0],
    playerUrl: playerUrl ? `https://www.youtube.com${playerUrl}` : undefined,
    rawPlayerResponse: player,
  }
}

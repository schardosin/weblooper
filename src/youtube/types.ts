/**
 * Types for YouTube audio extraction (client-side only).
 */

export interface AudioFormat {
  /** Unique itag for the format */
  itag: number
  /** MIME type, e.g. "audio/webm; codecs=\"opus\"" */
  mimeType: string
  /** Bitrate in bits per second */
  bitrate?: number
  /** Average bitrate */
  averageBitrate?: number
  /** Content length in bytes (if known) */
  contentLength?: number
  /** Direct URL (may require signature deciphering in some cases) */
  url?: string
  /** For DASH: base URL + segment info */
  baseUrl?: string
  /** Audio quality label (AUDIO_QUALITY_LOW / MEDIUM / HIGH) */
  audioQuality?: string
  /** Sample rate */
  audioSampleRate?: string
  /** Number of audio channels */
  audioChannels?: number
  /** Whether this is an adaptive (DASH) format */
  isAdaptive: boolean
  /** Rough file extension derived from mime */
  ext: string
}

export interface YouTubeVideoInfo {
  videoId: string
  title: string
  durationSeconds: number
  /** Best audio-only formats, sorted from highest to lowest quality */
  audioFormats: AudioFormat[]
  /** The single best audio format we recommend for stem separation */
  bestAudioFormat?: AudioFormat
}
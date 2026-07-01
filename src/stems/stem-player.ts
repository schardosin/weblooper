/**
 * StemPlayer — Multi-stem Web Audio playback engine for weblooper.
 *
 * Core contract:
 * - Accepts multiple named AudioBuffers (real stems later, fake for now).
 * - Provides unified transport: play/pause, seek, setRate, setLoop(start, end).
 * - Per-stem independent gain, solo, mute.
 * - Emits high-frequency time updates for timeline / current time UI.
 * - Handles seamless looping when loop is active.
 * - Pitch-preserved tempo control via SoundTouch time-stretching.
 *
 * This is deliberately decoupled from the YouTube path.
 * Later we can make WebLooper use this for audio files and the YT player for videos.
 */

import { isLowMemoryDevice, stretchCacheMaxEntries } from '../audio/device-memory'
import { timeStretchAsync } from '../audio/time-stretch'
import {
  StretchCancelledError,
  cancelPendingStretchJobs,
  terminateStretchWorker,
} from '../audio/time-stretch-worker-client'

export interface StemTrack {
  name: string
  buffer: AudioBuffer
}

export interface StemState {
  name: string
  gain: number // 0.0 - 2.0 (linear)
  muted: boolean
  soloed: boolean
}

export type StemPlayerEvent =
  | { type: 'time'; time: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'ended' }
  | { type: 'loop-jump' }
  | { type: 'stretching'; active: boolean; phase?: 'pending' | 'processing'; progress?: number; stemIndex?: number; totalStems?: number }

export class StemPlayer {
  private audioContext: AudioContext
  private tracks: StemTrack[] = []              // currently active buffers (original or stretched)
  private originalTracks: StemTrack[] = []      // always holds the original unmodified buffers
  private states: Map<string, StemState> = new Map()

  // Web Audio graph
  private masterGain: GainNode
  private stemNodes: Map<string, {
    source: AudioBufferSourceNode | null
    gain: GainNode
  }> = new Map()

  private isPlaying = false
  private startTime = 0 // context time when current playback segment started
  private offset = 0 // current logical position in the ORIGINAL audio timeline

  private loopStart = 0
  private loopEnd = 0
  private isLooping = false
  private playbackRate = 1.0
  private pitchSemitones = 0

  private animationFrame: number | null = null
  private listeners: ((e: StemPlayerEvent) => void)[] = []

  private duration = 0 // original (un-stretched) duration
  private isStretching = false
  private stretchGeneration = 0 // incremented each time setPlaybackRate is called, to abort stale stretches

  // Debounce rapid speed/pitch tweaks so we only stretch once at the final value
  private rateDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pitchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPlaybackRate: number | null = null
  private pendingPitchSemitones: number | null = null
  private rateCommitResolvers: Array<() => void> = []
  private pitchCommitResolvers: Array<() => void> = []
  private static readonly RATE_DEBOUNCE_MS = 800

  // LRU cache of pre-stretched stem sets (keyed by rate:pitch); 0 on low-memory devices
  private stretchCache = new Map<string, StemTrack[]>()
  private stretchCacheOrder: string[] = []
  private readonly stretchCacheMax = stretchCacheMaxEntries()

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    this.masterGain = this.audioContext.createGain()
    this.masterGain.connect(this.audioContext.destination)
  }

  // ============================================
  // Loading
  // ============================================

  loadStems(stems: StemTrack[]) {
    this.stop()

    this.originalTracks = stems
    this.tracks = stems
    this.duration = Math.max(...stems.map(s => s.buffer.duration))

    // Default loop = full track
    this.loopStart = 0
    this.loopEnd = this.duration

    // Initialize states
    this.states.clear()
    this.stemNodes.clear()

    stems.forEach(stem => {
      this.states.set(stem.name, {
        name: stem.name,
        gain: 1.0,
        muted: false,
        soloed: false,
      })

      // Create persistent nodes for this stem (we'll reconnect sources on play)
      const gain = this.audioContext.createGain()
      gain.connect(this.masterGain)
      this.stemNodes.set(stem.name, { source: null, gain })
    })
  }

  // ============================================
  // Transport
  // ============================================

  play() {
    if (this.isPlaying || this.tracks.length === 0 || this.isStretching) return

    // Resume context if it was suspended (autoplay policy)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume()
    }

    this.isPlaying = true
    this.startTime = this.audioContext.currentTime
    this.startAllSources(this.offset)

    this.emit({ type: 'play' })
    this.startTimeTicker()
  }

  pause() {
    if (!this.isPlaying) return

    this.offset = this.getCurrentTime()
    this.stopAllSources()
    this.isPlaying = false

    this.emit({ type: 'pause' })
    this.stopTimeTicker()
  }

  togglePlayPause() {
    if (this.isPlaying) this.pause()
    else this.play()
  }

  seek(time: number) {
    const wasPlaying = this.isPlaying
    if (wasPlaying) this.pause()

    this.offset = Math.max(0, Math.min(time, this.duration))

    if (wasPlaying) {
      this.play()
    } else {
      this.emit({ type: 'time', time: this.offset })
    }
  }

  setPlaybackRate(rate: number, options?: { immediate?: boolean }): Promise<void> {
    const newRate = Math.max(0.25, Math.min(rate, 2.0))

    if (!options?.immediate && this.isStretching) {
      return Promise.resolve()
    }

    if (!options?.immediate && Math.abs(newRate - this.playbackRate) < 0.01) {
      this.clearPendingPlaybackRate()
      return Promise.resolve()
    }

    const effectiveRate = this.pendingPlaybackRate ?? this.playbackRate
    if (Math.abs(newRate - effectiveRate) < 0.01) return Promise.resolve()

    this.pendingPlaybackRate = newRate

    if (this.rateDebounceTimer) clearTimeout(this.rateDebounceTimer)

    const commitPromise = new Promise<void>(resolve => {
      this.rateCommitResolvers.push(resolve)
    })

    if (!options?.immediate) {
      this.emit({ type: 'stretching', active: true, phase: 'pending' })
    }

    const delay = options?.immediate ? 0 : StemPlayer.RATE_DEBOUNCE_MS
    this.rateDebounceTimer = setTimeout(() => {
      this.rateDebounceTimer = null
      this.flushPendingPlaybackRate()
    }, delay)

    return commitPromise
  }

  private clearPendingPlaybackRate() {
    this.pendingPlaybackRate = null
    if (this.rateDebounceTimer) {
      clearTimeout(this.rateDebounceTimer)
      this.rateDebounceTimer = null
    }
    const resolvers = this.rateCommitResolvers.splice(0)
    resolvers.forEach(resolve => resolve())
    this.emitStretchingIdleIfReady()
  }

  private flushPendingPlaybackRate() {
    const target = this.pendingPlaybackRate
    this.pendingPlaybackRate = null
    const resolvers = this.rateCommitResolvers.splice(0)

    if (target == null) {
      resolvers.forEach(resolve => resolve())
      this.emitStretchingIdleIfReady()
      return
    }

    if (this.isStretching) {
      // A stretch is still running — keep the target and try again when it finishes
      this.pendingPlaybackRate = target
      this.rateCommitResolvers.push(...resolvers)
      return
    }

    void this.commitPlaybackRate(target, resolvers)
  }

  private maybeFlushDeferredPlaybackRate() {
    if (this.isStretching || this.rateDebounceTimer || this.pendingPlaybackRate == null) return
    if (Math.abs(this.pendingPlaybackRate - this.playbackRate) < 0.01) {
      this.clearPendingPlaybackRate()
      return
    }
    this.flushPendingPlaybackRate()
  }

  private async commitPlaybackRate(newRate: number, resolvers: Array<() => void>) {
    const generation = ++this.stretchGeneration

    try {
      if (Math.abs(newRate - this.playbackRate) < 0.01) return

      const wasPlaying = this.isPlaying
      const currentTime = this.getCurrentTime()

      if (wasPlaying) this.pause()

      this.playbackRate = newRate
      this.offset = currentTime

      const completed = await this.reprocessAudio(generation)
      if (!completed) return

      if (wasPlaying) {
        this.play()
      }
    } finally {
      if (this.stretchGeneration === generation) {
        resolvers.forEach(resolve => resolve())
        this.emitStretchingIdleIfReady()
      }
    }
  }

  private emitStretchingIdleIfReady() {
    if (this.isStretching) return
    if (this.rateDebounceTimer || this.pendingPlaybackRate != null) {
      this.emit({ type: 'stretching', active: true, phase: 'pending' })
      return
    }
    this.emit({ type: 'stretching', active: false })
  }

  /**
   * Re-process all stems with current playbackRate + pitchSemitones.
   * Used by both setPlaybackRate and setPitch.
   */
  private stretchCacheKey(rate: number, pitch: number): string {
    return `${rate.toFixed(2)}:${pitch}`
  }

  private getCachedTracks(key: string): StemTrack[] | null {
    const cached = this.stretchCache.get(key)
    if (!cached) return null

    // Touch LRU order
    const idx = this.stretchCacheOrder.indexOf(key)
    if (idx >= 0) {
      this.stretchCacheOrder.splice(idx, 1)
      this.stretchCacheOrder.push(key)
    }

    return cached
  }

  private evictStretchCacheEntry(evictKey: string) {
    const evicted = this.stretchCache.get(evictKey)
    this.stretchCache.delete(evictKey)
    if (evicted && this.tracks === evicted) {
      this.tracks = this.originalTracks
    }
  }

  private putCachedTracks(key: string, tracks: StemTrack[]) {
    if (this.stretchCacheMax === 0) return

    if (this.stretchCache.has(key)) {
      const idx = this.stretchCacheOrder.indexOf(key)
      if (idx >= 0) this.stretchCacheOrder.splice(idx, 1)
    }

    this.stretchCache.set(key, tracks)
    this.stretchCacheOrder.push(key)

    while (this.stretchCacheOrder.length > this.stretchCacheMax) {
      const evictKey = this.stretchCacheOrder.shift()!
      this.evictStretchCacheEntry(evictKey)
    }
  }

  private async reprocessAudio(generation: number): Promise<boolean> {
    const needsProcessing =
      Math.abs(this.playbackRate - 1.0) >= 0.01 ||
      Math.abs(this.pitchSemitones) >= 0.01

    if (!needsProcessing) {
      this.tracks = this.originalTracks
      return true
    }

    const cacheKey = this.stretchCacheKey(this.playbackRate, this.pitchSemitones)
    const cached = this.getCachedTracks(cacheKey)
    if (cached) {
      this.tracks = cached
      return true
    }

    if (this.stretchGeneration !== generation) return false

    // Drop references to the previous stretched set before allocating new buffers
    if (this.tracks !== this.originalTracks) {
      this.tracks = this.originalTracks
    }

    cancelPendingStretchJobs()

    this.isStretching = true
    const totalStems = this.originalTracks.length
    this.emit({ type: 'stretching', active: true, phase: 'processing', progress: 0, stemIndex: 0, totalStems })

    let completed = false

    try {
      const processed: StemTrack[] = []
      for (let i = 0; i < this.originalTracks.length; i++) {
        if (this.stretchGeneration !== generation) return false

        if (i > 0 && isLowMemoryDevice()) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }

        let processedBuffer: AudioBuffer
        try {
          processedBuffer = await timeStretchAsync(
            this.originalTracks[i].buffer,
            this.playbackRate,
            this.pitchSemitones,
          )
        } catch (err) {
          if (err instanceof StretchCancelledError || this.stretchGeneration !== generation) {
            return false
          }
          throw err
        }

        if (this.stretchGeneration !== generation) return false

        processed.push({ name: this.originalTracks[i].name, buffer: processedBuffer })

        this.emit({
          type: 'stretching',
          active: true,
          phase: 'processing',
          progress: (i + 1) / totalStems,
          stemIndex: i + 1,
          totalStems,
        })
      }

      if (this.stretchGeneration !== generation) return false

      this.tracks = processed
      this.putCachedTracks(cacheKey, processed)
      completed = true
      return true
    } catch (err) {
      console.error('[StemPlayer] Audio processing failed:', err)
      this.tracks = this.originalTracks
      completed = true
      return true
    } finally {
      terminateStretchWorker()
      if (completed || this.stretchGeneration === generation) {
        this.isStretching = false
        this.emitStretchingIdleIfReady()
        this.maybeFlushDeferredPlaybackRate()
        this.maybeFlushDeferredPitch()
      }
    }
  }

  setLoop(start: number, end: number) {
    this.loopStart = Math.max(0, Math.min(start, this.duration))
    this.loopEnd = Math.max(this.loopStart + 0.1, Math.min(end, this.duration))
  }

  setIsLooping(enabled: boolean) {
    this.isLooping = enabled
  }

  /**
   * Set pitch shift in semitones (independent of tempo).
   * Positive = higher key, negative = lower key.
   * This will re-process the audio buffers.
   */
  setPitch(semitones: number, options?: { immediate?: boolean }): Promise<void> {
    const newPitch = Math.max(-12, Math.min(12, Math.round(semitones)))

    if (!options?.immediate && this.isStretching) {
      return Promise.resolve()
    }

    if (!options?.immediate && newPitch === this.pitchSemitones) {
      this.clearPendingPitch()
      return Promise.resolve()
    }

    const effectivePitch = this.pendingPitchSemitones ?? this.pitchSemitones
    if (newPitch === effectivePitch) return Promise.resolve()

    this.pendingPitchSemitones = newPitch

    if (this.pitchDebounceTimer) clearTimeout(this.pitchDebounceTimer)

    const commitPromise = new Promise<void>(resolve => {
      this.pitchCommitResolvers.push(resolve)
    })

    const delay = options?.immediate ? 0 : StemPlayer.RATE_DEBOUNCE_MS
    this.pitchDebounceTimer = setTimeout(() => {
      this.pitchDebounceTimer = null
      this.flushPendingPitch()
    }, delay)

    return commitPromise
  }

  private clearPendingPitch() {
    this.pendingPitchSemitones = null
    if (this.pitchDebounceTimer) {
      clearTimeout(this.pitchDebounceTimer)
      this.pitchDebounceTimer = null
    }
    const resolvers = this.pitchCommitResolvers.splice(0)
    resolvers.forEach(resolve => resolve())
  }

  private flushPendingPitch() {
    const target = this.pendingPitchSemitones
    this.pendingPitchSemitones = null
    const resolvers = this.pitchCommitResolvers.splice(0)

    if (target == null) {
      resolvers.forEach(resolve => resolve())
      return
    }

    if (this.isStretching) {
      this.pendingPitchSemitones = target
      this.pitchCommitResolvers.push(...resolvers)
      return
    }

    void this.commitPitch(target, resolvers)
  }

  private maybeFlushDeferredPitch() {
    if (this.isStretching || this.pitchDebounceTimer || this.pendingPitchSemitones == null) return
    if (this.pendingPitchSemitones === this.pitchSemitones) {
      this.clearPendingPitch()
      return
    }
    this.flushPendingPitch()
  }

  private async commitPitch(newPitch: number, resolvers: Array<() => void>) {
    const generation = ++this.stretchGeneration

    try {
      if (newPitch === this.pitchSemitones) return

      const wasPlaying = this.isPlaying
      const currentTime = this.getCurrentTime()

      if (wasPlaying) this.pause()

      this.pitchSemitones = newPitch
      this.offset = currentTime

      const completed = await this.reprocessAudio(generation)
      if (!completed) return

      if (wasPlaying) {
        this.play()
      }
    } finally {
      if (this.stretchGeneration === generation) {
        resolvers.forEach(resolve => resolve())
      }
    }
  }

  getCurrentPitch(): number {
    return this.pitchSemitones
  }

  restartFromLoopStart() {
    this.seek(this.loopStart)
    if (!this.isPlaying) this.play()
  }

  /**
   * Restart: when looping, from loopStart; otherwise from beginning of song (0).
   * Ensures playback is started after seek.
   */
  restart() {
    const target = this.isLooping ? this.loopStart : 0
    this.seek(target)
    if (!this.isPlaying) this.play()
  }

  stop() {
    this.pause()
    this.offset = 0
    this.emit({ type: 'time', time: 0 })
  }

  // ============================================
  // Per-stem controls
  // ============================================

  setStemGain(name: string, gain: number) {
    const state = this.states.get(name)
    if (!state) return

    state.gain = Math.max(0, Math.min(gain, 2.5))
    this.updateStemGain(name)
  }

  setStemMuted(name: string, muted: boolean) {
    const state = this.states.get(name)
    if (!state) return

    state.muted = muted
    this.updateStemGain(name)
  }

  setStemSoloed(name: string, soloed: boolean) {
    const state = this.states.get(name)
    if (!state) return

    state.soloed = soloed
    this.updateAllStemGains()
  }

  getStemStates(): StemState[] {
    return Array.from(this.states.values())
  }

  resetMix() {
    this.states.forEach(s => {
      s.gain = 1.0
      s.muted = false
      s.soloed = false
    })
    this.updateAllStemGains()
  }

  // ============================================
  // Internal playback
  // ============================================

  private startAllSources(fromTime: number) {
    this.stopAllSources()

    // Convert logical time (in original timeline) to buffer time (in stretched timeline)
    const bufferOffset = this.logicalToBufferTime(fromTime)

    this.tracks.forEach(track => {
      const node = this.stemNodes.get(track.name)!

      const source = this.audioContext.createBufferSource()
      source.buffer = track.buffer
      // Always play at native rate — stretching is already baked into the buffer
      source.playbackRate.value = 1.0
      source.connect(node.gain)

      const startAt = this.audioContext.currentTime
      const offsetInBuffer = Math.max(0, bufferOffset)

      // Play until end of buffer
      const remainingInBuffer = track.buffer.duration - offsetInBuffer
      if (remainingInBuffer > 0) {
        source.start(startAt, offsetInBuffer, remainingInBuffer)
      }

      node.source = source

      // Handle natural end of this source (for looping logic)
      source.onended = () => this.handleSourceEnded(track.name)
    })

    this.updateAllStemGains()
  }

  private stopAllSources() {
    this.stemNodes.forEach(node => {
      if (node.source) {
        try { node.source.stop() } catch {}
        node.source = null
      }
    })
  }

  private handleSourceEnded(_name: string) {
    if (!this.isPlaying) return

    const current = this.getCurrentTime()

    if (this.isLooping && current >= this.loopEnd - 0.05) {
      // Jump back to loop start
      this.offset = this.loopStart
      this.startTime = this.audioContext.currentTime
      this.emit({ type: 'loop-jump' })
      this.startAllSources(this.loopStart)
    } else if (current >= this.duration - 0.1) {
      this.isPlaying = false
      this.offset = this.duration
      this.stopTimeTicker()
      this.emit({ type: 'ended' })
    }
  }

  private updateStemGain(name: string) {
    const state = this.states.get(name)
    const node = this.stemNodes.get(name)
    if (!state || !node) return

    const anySoloActive = Array.from(this.states.values()).some(s => s.soloed)
    let effective = state.gain

    if (state.muted || (anySoloActive && !state.soloed)) {
      effective = 0
    }

    // Smooth gain changes
    node.gain.gain.cancelScheduledValues(this.audioContext.currentTime)
    node.gain.gain.linearRampToValueAtTime(effective, this.audioContext.currentTime + 0.03)
  }

  private updateAllStemGains() {
    this.states.forEach((_, name) => this.updateStemGain(name))
  }

  // ============================================
  // Time tracking
  // ============================================

  /**
   * Convert logical time (original timeline) to buffer time (stretched timeline).
   * When tempo = 0.75, the buffer is longer: 4min becomes ~5.33min.
   * Logical time 60s → buffer time 60s / 0.75 = 80s.
   */
  private logicalToBufferTime(logicalTime: number): number {
    if (Math.abs(this.playbackRate - 1.0) < 0.01) return logicalTime
    return logicalTime / this.playbackRate
  }

  /**
   * Convert elapsed buffer time back to logical time.
   * Buffer plays at 1.0 rate, but represents stretched audio.
   * elapsed buffer time * playbackRate = logical time elapsed.
   */
  private bufferToLogicalTime(bufferElapsed: number): number {
    if (Math.abs(this.playbackRate - 1.0) < 0.01) return bufferElapsed
    return bufferElapsed * this.playbackRate
  }

  getCurrentTime(): number {
    if (!this.isPlaying) return this.offset

    // Buffer plays at rate 1.0 — elapsed wall clock time = elapsed buffer time
    const bufferElapsed = this.audioContext.currentTime - this.startTime
    // Convert to logical time
    const logicalElapsed = this.bufferToLogicalTime(bufferElapsed)
    let t = this.offset + logicalElapsed

    if (this.isLooping && t >= this.loopEnd) {
      // Wrap for display purposes
      const loopLen = this.loopEnd - this.loopStart
      t = this.loopStart + ((t - this.loopStart) % loopLen)
    }

    return Math.min(t, this.duration)
  }

  private startTimeTicker() {
    this.stopTimeTicker()

    const tick = () => {
      if (!this.isPlaying) return

      const time = this.getCurrentTime()
      this.emit({ type: 'time', time })

      // Check for loop boundary enforcement (defensive)
      if (this.isLooping && time >= this.loopEnd - 0.03) {
        this.offset = this.loopStart
        this.startTime = this.audioContext.currentTime
        this.startAllSources(this.loopStart)
        this.emit({ type: 'loop-jump' })
      }

      this.animationFrame = requestAnimationFrame(tick)
    }

    this.animationFrame = requestAnimationFrame(tick)
  }

  private stopTimeTicker() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }
  }

  // ============================================
  // Events & Public API
  // ============================================

  on(listener: (e: StemPlayerEvent) => void) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private emit(e: StemPlayerEvent) {
    this.listeners.forEach(fn => fn(e))
  }

  getDuration(): number {
    return this.duration
  }

  getCurrentPlaybackRate(): number {
    return this.pendingPlaybackRate ?? this.playbackRate
  }

  getPendingPlaybackRate(): number | null {
    return this.pendingPlaybackRate
  }

  isCurrentlyStretching(): boolean {
    return this.isStretching
  }

  /** True while audio is being reprocessed — speed/pitch inputs should be locked. */
  isPlaybackRateLocked(): boolean {
    return this.isStretching
  }

  getLoopRegion(): { start: number; end: number } {
    return { start: this.loopStart, end: this.loopEnd }
  }

  isCurrentlyPlaying(): boolean {
    return this.isPlaying
  }

  getIsStretching(): boolean {
    return this.isStretching
  }

  dispose() {
    this.stop()
    this.stopTimeTicker()
    if (this.rateDebounceTimer) clearTimeout(this.rateDebounceTimer)
    if (this.pitchDebounceTimer) clearTimeout(this.pitchDebounceTimer)
    this.stretchCache.clear()
    this.stretchCacheOrder = []
    try { this.audioContext.close() } catch {}
    this.listeners = []
  }
}

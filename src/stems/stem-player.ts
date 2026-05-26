/**
 * StemPlayer — Multi-stem Web Audio playback engine for weblooper.
 *
 * Core contract:
 * - Accepts multiple named AudioBuffers (real stems later, fake for now).
 * - Provides unified transport: play/pause, seek, setRate, setLoop(start, end).
 * - Per-stem independent gain, solo, mute.
 * - Emits high-frequency time updates for timeline / current time UI.
 * - Handles seamless looping when loop is active.
 *
 * This is deliberately decoupled from the YouTube path.
 * Later we can make WebLooper use this for audio files and the YT player for videos.
 */

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

export class StemPlayer {
  private audioContext: AudioContext
  private tracks: StemTrack[] = []
  private states: Map<string, StemState> = new Map()

  // Web Audio graph
  private masterGain: GainNode
  private stemNodes: Map<string, {
    source: AudioBufferSourceNode | null
    gain: GainNode
    // Future: filter nodes per stem for EQ
  }> = new Map()

  private isPlaying = false
  private startTime = 0 // context time when current playback segment started
  private offset = 0 // current logical position in the audio when playback started

  private loopStart = 0
  private loopEnd = 0
  private isLooping = false
  private playbackRate = 1.0

  private animationFrame: number | null = null
  private listeners: ((e: StemPlayerEvent) => void)[] = []

  private duration = 0

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
    if (this.isPlaying || this.tracks.length === 0) return

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

  setPlaybackRate(rate: number) {
    this.playbackRate = Math.max(0.25, Math.min(rate, 4.0))

    if (this.isPlaying) {
      // Restart sources at new rate (Web Audio limitation)
      const currentTime = this.getCurrentTime()
      this.pause()
      this.offset = currentTime
      this.play()
    }
  }

  setLoop(start: number, end: number) {
    this.loopStart = Math.max(0, Math.min(start, this.duration))
    this.loopEnd = Math.max(this.loopStart + 0.1, Math.min(end, this.duration))
  }

  setIsLooping(enabled: boolean) {
    this.isLooping = enabled
  }

  restartFromLoopStart() {
    this.seek(this.loopStart)
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

    this.tracks.forEach(track => {
      const node = this.stemNodes.get(track.name)!

      const source = this.audioContext.createBufferSource()
      source.buffer = track.buffer
      source.playbackRate.value = this.playbackRate
      source.connect(node.gain)

      const startAt = this.audioContext.currentTime
      const offsetInBuffer = Math.max(0, fromTime)

      // Play until end of buffer or loop point
      const remainingInBuffer = track.buffer.duration - offsetInBuffer
      source.start(startAt, offsetInBuffer, remainingInBuffer)

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

  private getCurrentTime(): number {
    if (!this.isPlaying) return this.offset

    const elapsed = (this.audioContext.currentTime - this.startTime) * this.playbackRate
    let t = this.offset + elapsed

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
    return this.playbackRate
  }

  getLoopRegion(): { start: number; end: number } {
    return { start: this.loopStart, end: this.loopEnd }
  }

  isCurrentlyPlaying(): boolean {
    return this.isPlaying
  }

  dispose() {
    this.stop()
    this.stopTimeTicker()
    try { this.audioContext.close() } catch {}
    this.listeners = []
  }
}

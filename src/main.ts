/**
 * weblooper
 * YouTube looper built for musicians to practice specific sections of songs.
 * Supports precise start/end loop points + speed control + presets.
 */

import './style.css'
import { decodeAudioFile, estimateSeparationMinutes } from './audio/decoder'
import { StemPlayer, createStemMixerUI, type StemTrack } from './stems'

// ============================================
// Types
// ============================================

interface LoopPreset {
  id: string
  name: string
  start: number
  end: number
}

interface VideoState {
  videoId: string
  title: string
  duration: number
  start: number
  end: number
  isLooping: boolean
  playbackRate: number
  presets: LoopPreset[]
}

declare global {
  interface Window {
    YT: any
    onYouTubeIframeAPIReady: () => void
  }
}

// ============================================
// Constants & Helpers
// ============================================

const DEFAULT_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

function formatTime(totalSeconds: number, showDecimals = false): string {
  if (!isFinite(totalSeconds) || totalSeconds < 0) return '0:00'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const decimals = Math.floor((totalSeconds % 1) * 10)

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  const base = `${minutes}:${seconds.toString().padStart(2, '0')}`
  return showDecimals && decimals > 0 ? `${base}.${decimals}` : base
}

function parseTime(input: string): number {
  const trimmed = input.trim()
  if (!trimmed) return 0

  // Pure seconds (e.g. "83" or "83.4")
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, parseFloat(trimmed))
  }

  // mm:ss or m:ss.s
  const match = trimmed.match(/^(\d+):(\d{1,2})(?:\.(\d))?$/i)
  if (match) {
    const mins = parseInt(match[1], 10)
    const secs = parseInt(match[2], 10)
    const dec = match[3] ? parseInt(match[3], 10) / 10 : 0
    return mins * 60 + secs + dec
  }

  return 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function getYouTubeVideoId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim()
  if (!trimmed) return null

  // Already an ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed

  // youtube.com/watch?v=ID
  let match = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
  if (match) return match[1]

  // youtu.be/ID
  match = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  if (match) return match[1]

  // youtube.com/embed/ID
  match = trimmed.match(/embed\/([a-zA-Z0-9_-]{11})/)
  if (match) return match[1]

  // youtube.com/shorts/ID
  match = trimmed.match(/shorts\/([a-zA-Z0-9_-]{11})/)
  if (match) return match[1]

  return null
}

// ============================================
// Storage
// ============================================

const STORAGE_KEY = 'weblooper_state_v1'

/**
 * Sanitize a video state object before persisting to localStorage or uploading to Drive.
 * Strips UI-only fields (like "source") and keeps only the known persistent fields.
 * This prevents pollution of the cross-device state (e.g. "source: cloud" leaking into video-states.json).
 */
function sanitizeVideoState(raw: any): any {
  if (!raw || typeof raw !== 'object') return {}
  const clean: any = {}
  const allowedKeys = [
    'videoId',
    'title',
    'duration',
    'start',
    'end',
    'isLooping',
    'playbackRate',
    'presets',
    'lastVisited',
  ]
  for (const key of allowedKeys) {
    if (key in raw) {
      clean[key] = raw[key]
    }
  }
  // Always ensure videoId is present if we have it
  if (raw.videoId) clean.videoId = raw.videoId
  return clean
}

function saveVideoState(videoId: string, state: Partial<VideoState> & { title?: string }) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const existing = sanitizeVideoState(all[videoId] || {})
    const merged = {
      ...existing,
      ...state,
      videoId,
      lastVisited: Date.now(),
      // keep the best title we have seen
      title: state.title || existing.title || undefined,
    }
    all[videoId] = sanitizeVideoState(merged)

    // Prune to the most recent 15 videos so localStorage doesn't grow forever
    const entries = Object.values(all) as any[]
    if (entries.length > 15) {
      entries.sort((a: any, b: any) => (b.lastVisited || 0) - (a.lastVisited || 0))
      const keep = entries.slice(0, 15)
      const pruned: any = {}
      keep.forEach((e: any) => { if (e.videoId) pruned[e.videoId] = sanitizeVideoState(e) })
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned))
      // Best-effort cloud sync of the pruned map
      triggerBackgroundVideoStatesUpload(pruned)
      return
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
    // Best-effort cloud sync when signed in
    triggerBackgroundVideoStatesUpload(all)
  } catch (e) {
    console.warn('Failed to save state', e)
  }
}

/** Fire-and-forget upload of current video states to Drive (if signed in) */
function triggerBackgroundVideoStatesUpload(states: Record<string, any>) {
  // Dynamic import to avoid blocking + no top-level await issues
  import('./drive').then(({ isSignedIn, uploadVideoStates }) => {
    if (!isSignedIn()) return
    // Sanitize before upload to prevent leaking UI-only fields (source, etc.) to Drive
    const cleanStates: Record<string, any> = {}
    for (const [id, s] of Object.entries(states || {})) {
      cleanStates[id] = sanitizeVideoState(s)
    }
    // Don't await — best effort background sync
    uploadVideoStates(cleanStates).catch((err: any) =>
      console.warn('[drive-sync] Background video states upload failed:', err?.message || err)
    )
  }).catch(() => {})
}

function loadVideoState(videoId: string): Partial<VideoState> | null {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return all[videoId] || null
  } catch {
    return null
  }
}

// ============================================
// Main App
// ============================================

class WebLooper {
  private player: any = null
  private playerReady = false
  private currentVideoId: string | null = null
  private videoPitch = 0                    // Current key shift for this video
  private _onVideoEndedDuringCapture: (() => void) | null = null  // Callback to stop recording when video ends
  private _pitchAudioSource: AudioBufferSourceNode | null = null  // Currently playing pitch-shifted audio
  private _pitchAudioContext: AudioContext | null = null
  private _pitchSyncInterval: number | null = null
  private _pitchRawBuffer: AudioBuffer | null = null              // Raw (original key) AudioBuffer for current video
  private _pitchStretchGeneration = 0                             // Generation counter for aborting stale stretches
  private duration = 0
  private start = 0
  private end = 0
  private isLooping = false
  private playbackRate = 1
  private presets: LoopPreset[] = []
  private monitorInterval: number | null = null
  private lastKnownTime = 0
  private currentView: 'landing' | 'workspace' = 'landing'
  private pendingVideoUrl: string | null = null

  // UI elements (set after render — only valid in workspace view)
  private els!: {
    loaderSection: HTMLElement
    playerSection: HTMLElement
    urlInput: HTMLInputElement
    loadBtn: HTMLElement
    videoTitle: HTMLElement
    videoIdBadge: HTMLElement
    videoDuration: HTMLElement
    changeVideoBtn: HTMLElement
    separateStemsFromYtBtn: HTMLElement
    playerWrap: HTMLElement
    ytPlayer: HTMLElement
    timeline: HTMLElement
    timelineLabels: HTMLElement
    timelineCurrent: HTMLElement
    currentTime: HTMLElement
    startInput: HTMLInputElement
    endInput: HTMLInputElement
    loopToggle: HTMLElement
    playPause: HTMLElement
    playLabel: HTMLElement
    restartLoop: HTMLElement
    speedChips: HTMLElement
    speedValue: HTMLElement
    presetsList: HTMLElement
    noPresetsHint: HTMLElement
    savePresetBtn: HTMLElement
    shortcutsBtn: HTMLElement
    shortcutsModal: HTMLElement
    closeShortcuts: HTMLElement
  }

  constructor() {
    // Kill any orphaned YouTube iframes that might survive from a previous page session
    // (e.g. browser bfcache restoring the page with audio still playing)
    document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu"]').forEach(el => {
      try { (el as HTMLIFrameElement).src = 'about:blank' } catch {}
      el.remove()
    })

    this.route()
    this.bindGlobalEvents()
    window.addEventListener('hashchange', () => this.route())

    // Prevent audio from auto-resuming when page is restored from bfcache
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        // Page was restored from bfcache — stop any playing audio
        if (this.player) {
          try { this.player.pauseVideo() } catch {}
          try { this.player.stopVideo() } catch {}
        }
        document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu"]').forEach(el => {
          try { (el as HTMLIFrameElement).src = 'about:blank' } catch {}
          el.remove()
        })
      }
    })
  }

  // ---------- Router ----------
  private route() {
    const hash = location.hash
    if (hash === '#/workspace' || hash.startsWith('#/workspace?')) {
      this.navigateToWorkspace()
    } else {
      this.navigateToLanding()
    }
  }

  private navigateToWorkspace() {
    if (this.currentView === 'workspace') return
    this.currentView = 'workspace'
    this.renderWorkspace()
    this.initYouTubeAPI()
    // If we have a pending URL from the landing page hero input, load it
    if (this.pendingVideoUrl) {
      const url = this.pendingVideoUrl
      this.pendingVideoUrl = null
      this.els.urlInput.value = url
      this.loadFromInput()
    }
  }

  private navigateToLanding() {
    if (this.currentView === 'landing') {
      this.renderLanding()
      return
    }
    this.currentView = 'landing'
    // Fully stop and clean up any active video/audio
    this.unloadVideo()
    this.renderLanding()
  }

  navigateTo(view: 'landing' | 'workspace', options?: { videoUrl?: string }) {
    if (options?.videoUrl) {
      this.pendingVideoUrl = options.videoUrl
    }
    if (view === 'workspace') {
      location.hash = '#/workspace'
    } else {
      // Remove hash without adding '#' to URL
      history.pushState(null, '', location.pathname + location.search)
      this.route()
    }
  }

  // Smooth scroll navigation for landing page sections
  private setupLandingNavigation() {
    // Smooth scroll for in-page anchor links (features, how, stems)
    document.querySelectorAll('a.nav-link[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', (e) => {
        const href = (anchor as HTMLAnchorElement).getAttribute('href')
        if (!href || href === '#' || href === '#/workspace') return
        const target = document.querySelector(href)
        if (target) {
          e.preventDefault()
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    })

    // "Open Workspace" CTA navigates to the workspace view
    const launchBtn = document.getElementById('launch-workspace-btn')
    launchBtn?.addEventListener('click', () => {
      this.navigateTo('workspace')
    })

    // Hero "START LOOPING" button: grab the URL and navigate to workspace with it
    const heroLoadBtn = document.getElementById('hero-load-btn')
    const heroInput = document.getElementById('hero-url-input') as HTMLInputElement | null
    heroLoadBtn?.addEventListener('click', () => {
      const url = heroInput?.value.trim() || ''
      this.navigateTo('workspace', { videoUrl: url || undefined })
    })
    heroInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const url = heroInput.value.trim()
        this.navigateTo('workspace', { videoUrl: url || undefined })
      }
    })

    // Hero example links
    document.querySelectorAll('.hero-example-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url!
        this.navigateTo('workspace', { videoUrl: url })
      })
    })
  }

  // ---------- Rendering ----------
  // ---------- Landing Page View ----------
  private renderLanding() {
    const app = document.querySelector<HTMLDivElement>('#app')!
    app.innerHTML = `
      <div class="min-h-screen flex flex-col bg-[#0a0a0b] text-zinc-200">
        <!-- Landing Header -->
        <header class="border-b border-white/10 bg-[#0a0a0b]/95 backdrop-blur-xl sticky top-0 z-[200]">
          <div class="max-w-[1280px] mx-auto px-6 h-16 flex items-center flex-nowrap overflow-hidden">
            <div class="flex-none flex items-center gap-3">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-2xl bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#052e16" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 2l4 4-4 4"/>
                    <path d="M3 11v-1a4 4 0 014-4h14"/>
                    <path d="M7 22l-4-4 4-4"/>
                    <path d="M21 13v1a4 4 0 01-4 4H3"/>
                  </svg>
                </div>
                <div>
                  <div class="font-semibold tracking-[-1.5px] text-2xl">weblooper</div>
                  <div class="text-[10px] text-emerald-500/70 -mt-1 font-medium tracking-[1.5px]">FOR MUSICIANS</div>
                </div>
              </div>
            </div>

            <nav class="hidden md:flex flex-1 items-center justify-center gap-6 text-sm font-medium min-w-0">
              <a href="#features" class="nav-link text-zinc-400 hover:text-white transition whitespace-nowrap">Features</a>
              <a href="#how" class="nav-link text-zinc-400 hover:text-white transition whitespace-nowrap">How it works</a>
              <a href="#stems" class="nav-link text-zinc-400 hover:text-white transition whitespace-nowrap">Stems</a>
            </nav>

            <div class="flex-none flex items-center gap-3 flex-shrink-0">
              <button id="launch-workspace-btn"
                      class="px-5 py-2 text-sm rounded-full bg-white text-zinc-950 font-semibold active:scale-[0.985] transition flex items-center gap-2 whitespace-nowrap">
                Open Workspace
              </button>
            </div>
          </div>
        </header>

        <!-- Hero -->
        <section class="relative min-h-[620px] flex items-center justify-center overflow-hidden border-b border-white/10">
          <div class="absolute inset-0 hero-bg" style="background-image: url('${import.meta.env.BASE_URL}brand/hero.jpg')"></div>
          <div class="absolute inset-0 bg-gradient-to-b from-black/60 via-black/70 to-[#0a0a0b]"></div>

          <div class="relative max-w-[820px] px-6 text-center">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs tracking-[2px] text-emerald-400 mb-6">
              BUILT FOR SERIOUS PRACTICE
            </div>

            <div class="relative inline-block px-10 py-5 rounded-3xl bg-black/65 backdrop-blur-lg border border-white/10">
              <h1 class="text-6xl md:text-7xl font-semibold tracking-[-3.5px] leading-[0.95]">
                Loop any part.<br>Practice perfectly.
              </h1>
              <p class="mt-4 text-lg text-zinc-200 max-w-md mx-auto">
                The focused practice tool musicians actually use. Precise loops, AI stems, and everything stays on your device.
              </p>
            </div>

            <div class="mt-10 max-w-[620px] mx-auto">
              <div class="bg-zinc-900/90 border border-white/10 rounded-3xl p-2 flex gap-2 shadow-2xl">
                <input id="hero-url-input"
                       type="text"
                       placeholder="Paste YouTube link or video ID"
                       class="flex-1 bg-black text-lg px-6 py-4 rounded-2xl border border-white/10 focus:border-emerald-500/60 focus:outline-none placeholder:text-zinc-600" />
                <button id="hero-load-btn"
                        class="btn-primary px-8 text-base rounded-2xl font-semibold active:scale-[0.985] transition whitespace-nowrap">
                  START LOOPING
                </button>
              </div>
              <div class="flex items-center justify-center gap-4 mt-4 text-xs">
                <button class="hero-example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://youtu.be/3JZ_2t3oX8s">Guitar riff</button>
                <span class="text-white/20">•</span>
                <button class="hero-example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://www.youtube.com/watch?v=9bZkp7q19f0">Gangnam Style</button>
                <span class="text-white/20">•</span>
                <button class="hero-example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://youtu.be/dQw4w9wgccc">Never Gonna</button>
              </div>
            </div>
          </div>
        </section>

        <!-- Features -->
        <section id="features" class="max-w-[1280px] mx-auto px-6 pt-20 pb-16">
          <div class="text-center mb-12">
            <div class="text-emerald-400 text-xs tracking-[3px] font-medium">EVERYTHING YOU NEED TO PRACTICE</div>
            <h2 class="text-4xl font-semibold tracking-tighter mt-3">Built for the way musicians actually work</h2>
          </div>

          <div class="grid md:grid-cols-3 gap-6">
            <div class="premium-card group bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden">
              <div class="feature-img h-56" style="background-image: url('${import.meta.env.BASE_URL}brand/looping.jpg')"></div>
              <div class="p-8">
                <div class="font-semibold text-xl tracking-tight">Precision Looping</div>
                <div class="text-zinc-400 mt-3 leading-relaxed">Drag handles, keyboard shortcuts, saved presets. Loop exactly what you need — nothing more, nothing less.</div>
              </div>
            </div>

            <div class="premium-card group bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden">
              <div class="feature-img h-56" style="background-image: url('${import.meta.env.BASE_URL}brand/stems.jpg')"></div>
              <div class="p-8">
                <div class="font-semibold text-xl tracking-tight">AI Stem Separation</div>
                <div class="text-zinc-400 mt-3 leading-relaxed">6-stem separation (drums, bass, guitar, piano, vocals, other) runs 100% in your browser using WebGPU. No uploads. No recurring cost.</div>
              </div>
            </div>

            <div class="premium-card group bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden">
              <div class="feature-img h-56" style="background-image: url('${import.meta.env.BASE_URL}brand/practice.jpg')"></div>
              <div class="p-8">
                <div class="font-semibold text-xl tracking-tight">Practice with Stems</div>
                <div class="text-zinc-400 mt-3 leading-relaxed">Isolate any instrument, slow it down, loop sections, save presets. The ultimate practice environment for learning songs by ear.</div>
                <div class="mt-5 text-xs text-emerald-400/80 flex items-center gap-2">
                  <div class="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
                  WORKS WITH YOUTUBE &amp; LOCAL FILES
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- How it works -->
        <section id="how" class="border-y border-white/10 bg-zinc-900/50">
          <div class="max-w-[1280px] mx-auto px-6 py-16">
            <div class="text-center mb-12">
              <div class="text-emerald-400 text-xs tracking-[3px] font-medium">FOUR MINUTES TO MASTERY</div>
              <h3 class="text-3xl font-semibold tracking-tighter mt-2">How weblooper works</h3>
            </div>

            <div class="grid md:grid-cols-4 gap-6 text-sm">
              <div class="flex gap-4">
                <div class="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-mono text-xs flex-shrink-0 mt-0.5">01</div>
                <div>
                  <div class="font-medium">Paste any YouTube link</div>
                  <div class="text-zinc-400 mt-1">Or load a local audio file. No sign-up, no limits.</div>
                </div>
              </div>
              <div class="flex gap-4">
                <div class="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-mono text-xs flex-shrink-0 mt-0.5">02</div>
                <div>
                  <div class="font-medium">Set your loop instantly</div>
                  <div class="text-zinc-400 mt-1">Drag the timeline handles or use [ and ] keys. Save as many presets as you want.</div>
                </div>
              </div>
              <div class="flex gap-4">
                <div class="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-mono text-xs flex-shrink-0 mt-0.5">03</div>
                <div>
                  <div class="font-medium">Separate stems (optional)</div>
                  <div class="text-zinc-400 mt-1">One click. 6-stem AI runs locally. Practice guitar without the vocals, or drums without the bass.</div>
                </div>
              </div>
              <div class="flex gap-4">
                <div class="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-mono text-xs flex-shrink-0 mt-0.5">04</div>
                <div>
                  <div class="font-medium">Do once, use anywhere</div>
                  <div class="text-zinc-400 mt-1">Sessions save locally and sync to your Google Drive. Practice on desktop, pick up on your phone or tablet.</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Stems highlight -->
        <section id="stems" class="max-w-[1280px] mx-auto px-6 py-20">
          <div class="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div class="text-emerald-400 text-xs tracking-[3px]">THE FUTURE OF PRACTICE</div>
              <h3 class="text-4xl font-semibold tracking-tighter mt-3 leading-none">AI stems.<br>Zero compromise.</h3>
              <div class="mt-6 text-lg text-zinc-400">
                Run a full 6-stem model locally in your browser. No uploads. No monthly fees. 
                The same quality musicians pay hundreds of dollars for — completely free and private.
              </div>
              <div class="mt-8 flex gap-3">
                <div class="px-4 py-2 text-xs rounded-full border border-white/10">6 stems</div>
                <div class="px-4 py-2 text-xs rounded-full border border-white/10">WebGPU accelerated</div>
                <div class="px-4 py-2 text-xs rounded-full border border-white/10">Works offline after download</div>
              </div>
            </div>
            <div class="rounded-3xl overflow-hidden border border-white/10">
              <img src="${import.meta.env.BASE_URL}brand/stems.jpg" class="w-full" alt="AI stem separation visualization">
            </div>
          </div>
        </section>

        <footer class="border-t border-white/10 py-8 text-center text-xs text-zinc-500">
          Made with focus for musicians who practice seriously.<br>
          Your data stays private. Optionally sync to your Google Drive for access on any device.
        </footer>
      </div>
    `

    // Final safety: ensure no YouTube iframes survived the DOM replacement
    document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu"]').forEach(el => {
      try { (el as HTMLIFrameElement).src = 'about:blank' } catch {}
      el.remove()
    })

    this.setupLandingNavigation()
  }

  // ---------- Workspace View (Full-Screen Dedicated) ----------
  private renderWorkspace() {
    const app = document.querySelector<HTMLDivElement>('#app')!
    app.innerHTML = `
      <div class="min-h-screen flex flex-col bg-[#0a0a0b] text-zinc-200">
        <!-- Workspace Header — minimal, focused -->
        <header class="border-b border-white/10 bg-[#0a0a0b]/95 backdrop-blur-xl sticky top-0 z-[200]">
          <div class="max-w-[1280px] mx-auto px-6 h-14 flex items-center justify-between">
            <!-- Left: Back + Logo -->
            <div class="flex items-center gap-4">
              <button id="workspace-back-btn"
                      class="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
                <span class="hidden sm:inline">Home</span>
              </button>
              <div class="h-5 w-px bg-white/10"></div>
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-xl bg-emerald-500 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#052e16" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 2l4 4-4 4"/>
                    <path d="M3 11v-1a4 4 0 014-4h14"/>
                    <path d="M7 22l-4-4 4-4"/>
                    <path d="M21 13v1a4 4 0 01-4 4H3"/>
                  </svg>
                </div>
                <span class="font-semibold tracking-tight text-lg">Workspace</span>
              </div>
            </div>

            <!-- Right: Cloud sync + Shortcuts -->
            <div class="flex items-center gap-3">
              <button id="drive-sync-btn"
                      class="flex items-center gap-2 px-3 py-1.5 text-xs rounded-full border border-white/10 hover:bg-white/5 transition whitespace-nowrap"
                      title="Sync stems to Google Drive">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
                </svg>
                <span id="drive-sync-label">Sign in</span>
              </button>
              <button id="shortcuts-btn"
                      class="flex items-center gap-2 px-3 py-1.5 text-xs rounded-full border border-white/10 hover:bg-white/5 transition whitespace-nowrap">
                <span>Shortcuts</span>
              </button>
            </div>
          </div>
        </header>

        <!-- Workspace Content -->
        <main class="flex-1 flex flex-col">
          <div class="flex-1 max-w-[1280px] w-full mx-auto px-6 py-8">
            <!-- Loader / URL Input -->
            <div id="loader-section" class="max-w-[720px] mx-auto">
              <div class="text-center mb-8">
                <h1 class="text-4xl font-semibold tracking-tighter">Loop any part.<br>Practice perfectly.</h1>
                <p class="text-zinc-400 mt-3">Paste a YouTube link. Set your start &amp; end points. Loop it.</p>
              </div>

              <div class="bg-zinc-900 border border-white/10 rounded-3xl p-2 flex gap-2 shadow-xl">
                <input id="url-input"
                       type="text"
                       placeholder="https://youtube.com/watch?v=dQw4w9wgccc or just the video ID"
                       class="flex-1 bg-black text-lg px-5 py-4 rounded-2xl border border-white/10 focus:border-emerald-500/60 focus:outline-none placeholder:text-zinc-600" />
                <button id="load-btn"
                        class="btn-primary px-8 text-base rounded-2xl font-semibold active:scale-[0.985] transition">
                  LOAD
                </button>
              </div>

              <div class="flex justify-center gap-3 mt-3 text-xs">
                <button class="example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://youtu.be/3JZ_2t3oX8s">Classic guitar riff</button>
                <span class="text-white/20">•</span>
                <button class="example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://www.youtube.com/watch?v=9bZkp7q19f0">PSY - Gangnam Style</button>
                <span class="text-white/20">•</span>
                <button class="example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://youtu.be/dQw4w9wgccc">Never gonna give you up</button>
              </div>

              <!-- Audio file path -->
              <div class="mt-8 text-center">
                <div class="text-[10px] uppercase tracking-[1.5px] text-zinc-500 mb-2">OR</div>
                <label class="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl border border-white/10 bg-zinc-900 hover:bg-zinc-800 text-sm font-medium cursor-pointer active:scale-[0.985] transition">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
                  <span>Load local audio file (for stems)</span>
                  <input id="audio-file-input" type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a" class="hidden" />
                </label>
                <div class="text-[11px] text-zinc-500 mt-1.5">WAV, MP3, FLAC, etc. • Processing happens in your browser</div>
              </div>

              <!-- Recent videos -->
              <div id="initial-recent-videos" class="mt-8 hidden max-w-[720px] mx-auto">
                <div class="text-[10px] uppercase tracking-[1.5px] text-emerald-400 mb-2 px-1">Recent videos</div>
                <div id="initial-recent-videos-list"
                     class="bg-zinc-900 border border-white/10 rounded-3xl p-3 text-sm space-y-2"></div>
                <div class="text-[10px] text-zinc-500 mt-2 px-1">Jump back to a video you were working on — all your saved loops and presets come with it.</div>
              </div>

              <!-- Previous stem separations -->
              <div id="initial-previous-stems" class="mt-6 hidden max-w-[720px] mx-auto">
                <div class="text-[10px] uppercase tracking-[1.5px] text-emerald-400 mb-2 px-1">Previous stem separations</div>
                <div id="initial-previous-stems-list"
                     class="bg-zinc-900 border border-white/10 rounded-3xl p-3 text-sm space-y-2"></div>
                <div class="text-[10px] text-zinc-500 mt-2 px-1">Load any previous AI separation directly (audio stays in your browser via OPFS).</div>
              </div>
            </div>

            <!-- Main Player UI -->
            <div id="player-section" class="hidden max-w-[1100px] mx-auto mt-8">
              <!-- Video header -->
              <div class="flex items-start justify-between gap-4 mb-3">
                <div class="min-w-0 flex-1">
                  <div id="video-title" class="text-2xl font-semibold tracking-tight text-white truncate"></div>
                  <div class="flex items-center gap-2 text-sm text-zinc-500 mt-0.5">
                    <span id="video-id-badge" class="font-mono px-2 py-px bg-white/5 rounded"></span>
                    <span id="video-duration" class="tabular-nums"></span>
                  </div>
                </div>
                <button id="change-video-btn"
                        class="shrink-0 mt-1 text-sm flex items-center gap-2 px-4 py-2 rounded-2xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 active:bg-zinc-950 transition">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                  <span>Back</span>
                </button>

                <button id="separate-stems-from-yt"
                        class="shrink-0 mt-1 text-sm flex items-center gap-2 px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium active:bg-emerald-700 transition">
                  Separate Stems
                </button>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-6">
                <!-- Player + Timeline -->
                <div>
                  <div id="player-wrap" 
                       class="relative w-full aspect-video bg-black rounded-3xl overflow-hidden ring-1 ring-white/10 shadow-2xl">
                    <div id="yt-player" class="w-full h-full"></div>
                  </div>

                  <div class="mt-4">
                    <div id="timeline" class="timeline w-full"></div>
                    <div id="timeline-labels" class="timeline-time-labels">
                      <div id="timeline-start-label">0:00</div>
                      <div id="timeline-current" class="font-medium text-emerald-400">0:00</div>
                      <div id="timeline-end-label">0:00</div>
                    </div>
                  </div>

                  <div class="flex items-center justify-between mt-3 text-sm">
                    <div class="flex gap-2">
                      <button id="btn-set-start" class="nudge-btn flex items-center gap-1.5 px-3 py-1.5 text-emerald-400 hover:text-emerald-300">
                        <span class="font-semibold">SET START</span>
                        <span class="text-[10px] opacity-60">( [ )</span>
                      </button>
                      <button id="btn-set-end" class="nudge-btn flex items-center gap-1.5 px-3 py-1.5 text-rose-400 hover:text-rose-300">
                        <span class="font-semibold">SET END</span>
                        <span class="text-[10px] opacity-60">( ] )</span>
                      </button>
                    </div>
                    <div class="text-xs text-zinc-500">Click timeline to seek • Drag handles to adjust loop</div>
                  </div>
                </div>

                <!-- Controls Sidebar -->
                <div class="space-y-4">
                  <div class="bg-zinc-900 border border-white/10 rounded-3xl p-5">
                    <div class="flex items-center justify-between mb-4">
                      <div class="uppercase tracking-[1.5px] text-xs font-semibold text-emerald-400">Loop Region</div>
                      <button id="btn-loop-toggle"
                              class="px-5 py-1 text-xs font-bold rounded-full border transition active:scale-95 bg-emerald-500/10 border-emerald-500/40 text-emerald-400">
                        LOOP OFF
                      </button>
                    </div>

                    <div class="grid grid-cols-2 gap-3">
                      <div>
                        <div class="text-[10px] font-medium text-emerald-400 mb-1.5 tracking-widest">START</div>
                        <div class="flex items-center gap-2">
                          <input id="start-input" type="text" class="time-input" value="0:00" />
                          <button id="nudge-start-minus" class="nudge-btn px-2 py-1 text-xs">-0.5</button>
                          <button id="nudge-start-plus" class="nudge-btn px-2 py-1 text-xs">+0.5</button>
                        </div>
                      </div>
                      <div>
                        <div class="text-[10px] font-medium text-rose-400 mb-1.5 tracking-widest">END</div>
                        <div class="flex items-center gap-2">
                          <input id="end-input" type="text" class="time-input" value="0:00" />
                          <button id="nudge-end-minus" class="nudge-btn px-2 py-1 text-xs">-0.5</button>
                          <button id="nudge-end-plus" class="nudge-btn px-2 py-1 text-xs">+0.5</button>
                        </div>
                      </div>
                    </div>

                    <div class="mt-5 mb-1 text-center">
                      <div class="text-[10px] tracking-[2px] text-zinc-500">CURRENT TIME</div>
                      <div id="current-time" class="font-mono text-5xl font-semibold tabular-nums tracking-tighter text-white mt-1">0:00</div>
                    </div>

                    <div class="grid grid-cols-2 gap-2 mt-2">
                      <button id="btn-play-pause" class="col-span-1 py-3 rounded-2xl bg-white text-zinc-950 font-semibold active:scale-[0.985] flex items-center justify-center gap-2">
                        <span id="play-label">PLAY</span>
                      </button>
                      <button id="btn-restart-loop" class="py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 font-semibold flex items-center justify-center gap-2 border border-white/10">
                        <span>↺</span><span>Restart Loop</span>
                      </button>
                    </div>

                    <button id="btn-full-video" class="mt-2 w-full py-2 text-xs rounded-2xl bg-zinc-950 hover:bg-zinc-800 border border-white/10 text-zinc-400 hover:text-zinc-200 transition flex items-center justify-center gap-2">
                      <span>Use full video (no loop)</span>
                    </button>

                    <div class="mt-5">
                      <div class="flex items-baseline justify-between mb-2 px-0.5">
                        <div class="text-xs font-medium tracking-widest text-zinc-400">SPEED</div>
                        <div class="flex items-center gap-1.5">
                          <button id="speed-dec" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">−</button>
                          <div id="speed-value" class="font-mono text-sm text-emerald-400 min-w-[3.2rem] text-center">1.00×</div>
                          <button id="speed-inc" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">+</button>
                        </div>
                      </div>
                      <div id="speed-chips" class="flex flex-wrap gap-1.5"></div>
                    </div>

                    <!-- Key / Pitch (affects attached stems) -->
                    <div class="mt-4">
                      <div class="flex items-baseline justify-between mb-1.5 px-0.5">
                        <div class="text-xs font-medium tracking-widest text-zinc-400">KEY</div>
                        <div class="flex items-center gap-1.5">
                          <button id="pitch-dec" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">−</button>
                          <div id="pitch-value" class="font-mono text-sm text-emerald-400 min-w-[3.2rem] text-center">0</div>
                          <button id="pitch-inc" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">+</button>
                        </div>
                      </div>
                      <div class="text-[10px] text-zinc-500 px-0.5">Semitones (pre-generated, synced to video)</div>
                    </div>
                  </div>

                  <div class="bg-zinc-900 border border-white/10 rounded-3xl p-5">
                    <div class="flex items-center justify-between mb-3">
                      <div class="text-xs font-semibold tracking-widest text-zinc-400">SAVED LOOPS</div>
                      <button id="save-preset-btn" class="text-[11px] px-3 py-1 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-medium flex items-center gap-1 transition">
                        <span>+</span><span>Save current</span>
                      </button>
                    </div>
                    <div id="presets-list" class="space-y-1.5 max-h-[168px] overflow-auto pr-1 text-sm"></div>
                    <div id="no-presets-hint" class="text-center text-xs text-zinc-500 py-2 italic hidden">No saved sections yet.<br>Save loops for fast switching.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <!-- Shortcuts modal -->
      <div id="shortcuts-modal" class="hidden fixed inset-0 bg-black/70 backdrop-blur z-[300] flex items-center justify-center p-6">
        <div class="bg-zinc-900 border border-white/10 rounded-3xl w-full max-w-md p-6 text-sm">
          <div class="flex justify-between items-center mb-4">
            <div class="font-semibold text-lg tracking-tight">Keyboard Shortcuts</div>
            <button id="close-shortcuts" class="text-xl leading-none text-zinc-400 hover:text-white">×</button>
          </div>
          <div class="grid grid-cols-[auto,1fr] gap-x-6 gap-y-2 text-xs">
            <div class="text-emerald-400 font-mono">SPACE</div><div>Play / Pause</div>
            <div class="text-emerald-400 font-mono">[</div><div>Set loop start at current time</div>
            <div class="text-emerald-400 font-mono">]</div><div>Set loop end at current time</div>
            <div class="text-emerald-400 font-mono">L</div><div>Toggle looping</div>
            <div class="text-emerald-400 font-mono">R</div><div>Restart loop from start</div>
            <div class="text-emerald-400 font-mono">1-6</div><div>Change playback speed (presets)</div>
            <div class="text-emerald-400 font-mono">− + =</div><div>Fine speed ±0.05</div>
            <div class="text-emerald-400 font-mono">← →</div><div>Nudge playhead ±1s</div>
            <div class="text-emerald-400 font-mono">ESC</div><div>Close this dialog</div>
          </div>
          <div class="text-center mt-6 text-[10px] text-zinc-500">Tip: Use the timeline handles for precise visual adjustment</div>
        </div>
      </div>
    `

    // Cache workspace elements
    this.els = {
      loaderSection: document.getElementById('loader-section')!,
      playerSection: document.getElementById('player-section')!,
      urlInput: document.getElementById('url-input') as HTMLInputElement,
      loadBtn: document.getElementById('load-btn')!,
      videoTitle: document.getElementById('video-title')!,
      videoIdBadge: document.getElementById('video-id-badge')!,
      videoDuration: document.getElementById('video-duration')!,
      changeVideoBtn: document.getElementById('change-video-btn')!,
      separateStemsFromYtBtn: document.getElementById('separate-stems-from-yt')!,
      playerWrap: document.getElementById('player-wrap')!,
      ytPlayer: document.getElementById('yt-player')!,
      timeline: document.getElementById('timeline')!,
      timelineLabels: document.getElementById('timeline-labels')!,
      timelineCurrent: document.getElementById('timeline-current')!,
      currentTime: document.getElementById('current-time')!,
      startInput: document.getElementById('start-input') as HTMLInputElement,
      endInput: document.getElementById('end-input') as HTMLInputElement,
      loopToggle: document.getElementById('btn-loop-toggle')!,
      playPause: document.getElementById('btn-play-pause')!,
      playLabel: document.getElementById('play-label')!,
      restartLoop: document.getElementById('btn-restart-loop')!,
      speedChips: document.getElementById('speed-chips')!,
      speedValue: document.getElementById('speed-value')!,
      presetsList: document.getElementById('presets-list')!,
      noPresetsHint: document.getElementById('no-presets-hint')!,
      savePresetBtn: document.getElementById('save-preset-btn')!,
      shortcutsBtn: document.getElementById('shortcuts-btn')!,
      shortcutsModal: document.getElementById('shortcuts-modal')!,
      closeShortcuts: document.getElementById('close-shortcuts')!,
    }

    // Hide the stems button until a video is loaded
    this.els.separateStemsFromYtBtn.classList.add('hidden')

    // Wire workspace back button
    document.getElementById('workspace-back-btn')?.addEventListener('click', () => {
      // Hard navigation to landing — guarantees all audio/iframes are killed
      window.location.href = window.location.pathname
    })

    // Wire Google Drive sync button
    this.setupDriveSyncButton()

    this.attachUIListeners()
    this.renderSpeedChips()

    // Focus the URL input when workspace loads
    setTimeout(() => {
      this.els.urlInput.focus({ preventScroll: true })
    }, 100)
  }

  private attachUIListeners() {
    const e = this.els

    // Loader
    e.loadBtn.addEventListener('click', () => this.loadFromInput())
    e.urlInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.loadFromInput()
    })

    // Example links
    document.querySelectorAll('.example-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url!
        this.loadVideoFromUrl(url)
      })
    })

    // Local audio file input (first step toward browser-powered stem separation)
    const audioFileInput = document.getElementById('audio-file-input') as HTMLInputElement | null
    if (audioFileInput) {
      audioFileInput.addEventListener('change', () => {
        const file = audioFileInput.files?.[0]
        if (file) {
          this.loadLocalAudioFile(file)
        }
        // reset so the same file can be chosen again later
        audioFileInput.value = ''
      })
    }

    // Drag & drop support for audio files anywhere in the loader section
    // (very natural for musicians dropping practice tracks)
    const loader = this.els.loaderSection
    loader.addEventListener('dragover', (e) => {
      e.preventDefault()
      loader.classList.add('!border-emerald-500/60', 'bg-zinc-900/80')
    })
    loader.addEventListener('dragleave', () => {
      loader.classList.remove('!border-emerald-500/60', 'bg-zinc-900/80')
    })
    loader.addEventListener('drop', (e) => {
      e.preventDefault()
      loader.classList.remove('!border-emerald-500/60', 'bg-zinc-900/80')
      const file = e.dataTransfer?.files?.[0]
      if (file && file.type.startsWith('audio/')) {
        this.loadLocalAudioFile(file)
      } else if (file) {
        alert('Please drop an audio file (WAV, MP3, FLAC, etc.)')
      }
    })

    // Show previous stem separations + recent videos on the landing screen (survives refresh)
    this.renderInitialPreviousStems()
    this.renderInitialRecentVideos()

    // Change video
    e.changeVideoBtn.addEventListener('click', () => {
      this.unloadVideo()
      e.loaderSection.classList.remove('hidden')
      e.playerSection.classList.add('hidden')
      e.separateStemsFromYtBtn.classList.add('hidden')
      // Refresh the quick-re-entry lists so the user sees up-to-date recents
      this.renderInitialRecentVideos()
      this.renderInitialPreviousStems()
      e.urlInput.focus()
      e.urlInput.select()
    })

    // Separate stems from the currently loaded YouTube video.
    // The flow now uses a blocking card (Recording → Breaking into stems) and fully
    // decouples the resulting stems: they are saved exactly like local-audio stems
    // (no video relationship) and open the pure independent stem looper UI.
    e.separateStemsFromYtBtn.addEventListener('click', async () => {
      if (!this.currentVideoId) {
        alert('No YouTube video is currently loaded.')
        return
      }

      const videoId = this.currentVideoId

      // Show choice dialog: Browser vs Colab
      const choice = await this.showStemMethodChoice()
      if (!choice) return // user cancelled

      if (choice === 'browser') {
        try {
          await this.startYouTubeStemSeparationForCurrentVideo(videoId)
        } catch (err: any) {
          console.error('[weblooper] YouTube stem separation failed', err)

          const message = err?.message || String(err)

          // Give a nicer message for the common YouTube extraction failures
          if (message.includes('unavailable') || message.includes('private') || message.includes('deleted')) {
            alert(`This video's audio cannot be extracted:\n\n${message}`)
          } else if (message.includes('403') || message.includes('blocked') || message.includes('failed with all') || message.includes('Failed to fetch')) {
            alert(
              'Direct YouTube audio extraction failed (YouTube often blocks this).\n\n' +
              'Recommended reliable method:\n\n' +
              '1. Download high-quality audio using yt-dlp:\n' +
              '   yt-dlp -f bestaudio --extract-audio --audio-format opus "https://youtu.be/' + videoId + '"\n\n' +
              '2. Then use "Load local audio file (for stems)" with the downloaded file.\n\n' +
              'This gives much better results than browser-based extraction.'
            )
          } else {
            alert(`Failed to separate stems from YouTube:\n\n${message}`)
          }
        }
      } else {
        // Colab path
        try {
          await this.startColabStemSeparation(videoId)
        } catch (err: any) {
          // Clean up choice dialog if still visible
          document.querySelectorAll('#stem-choice-buttons')?.forEach(el => el.closest('.fixed')?.remove())
          console.error('[weblooper] Colab stem separation failed', err)
          alert(`Colab stem separation failed:\n\n${err?.message || err}`)
        }
      }
    })

    // Loop toggle
    e.loopToggle.addEventListener('click', () => this.toggleLoop())

    // Set start/end
    document.getElementById('btn-set-start')!.addEventListener('click', () => this.setStartFromCurrent())
    document.getElementById('btn-set-end')!.addEventListener('click', () => this.setEndFromCurrent())

    // Nudge buttons
    document.getElementById('nudge-start-minus')!.addEventListener('click', () => this.nudgeStart(-0.5))
    document.getElementById('nudge-start-plus')!.addEventListener('click', () => this.nudgeStart(0.5))
    document.getElementById('nudge-end-minus')!.addEventListener('click', () => this.nudgeEnd(-0.5))
    document.getElementById('nudge-end-plus')!.addEventListener('click', () => this.nudgeEnd(0.5))

    // Play / Pause
    e.playPause.addEventListener('click', () => this.togglePlayPause())

    // Restart loop
    e.restartLoop.addEventListener('click', () => this.restartLoop())

    // Full video (disable loop region)
    const fullVideoBtn = document.getElementById('btn-full-video')
    if (fullVideoBtn) {
      fullVideoBtn.addEventListener('click', () => this.useFullVideo())
    }

    // Save preset
    e.savePresetBtn.addEventListener('click', () => this.saveCurrentAsPreset())

    // Inputs
    e.startInput.addEventListener('change', () => {
      const val = parseTime(e.startInput.value)
      this.setStart(clamp(val, 0, this.end - 0.1))
    })
    e.endInput.addEventListener('change', () => {
      const val = parseTime(e.endInput.value)
      this.setEnd(clamp(val, this.start + 0.1, this.duration || 9999))
    })

    // Fine speed control (±0.05) - matching stems player UX
    const speedDec = document.getElementById('speed-dec')!
    const speedInc = document.getElementById('speed-inc')!
    speedDec.addEventListener('click', () => {
      const next = Math.max(0.25, Math.round((this.playbackRate - 0.05) * 100) / 100)
      this.setPlaybackRate(next)
    })
    speedInc.addEventListener('click', () => {
      const next = Math.min(2.0, Math.round((this.playbackRate + 0.05) * 100) / 100)
      this.setPlaybackRate(next)
    })

    // Key / Pitch shift (semitones) — uses pre-generated pitch-shifted audio
    const pitchValueEl = document.getElementById('pitch-value')!
    const pitchDec = document.getElementById('pitch-dec')!
    const pitchInc = document.getElementById('pitch-inc')!

    const updateVideoPitchUI = () => {
      pitchValueEl.textContent = this.videoPitch > 0 ? `+${this.videoPitch}` : String(this.videoPitch)
    }

    pitchDec.addEventListener('click', async () => {
      const target = Math.max(-12, this.videoPitch - 1)
      await this.handleVideoPitchChange(target)
      updateVideoPitchUI()
    })

    pitchInc.addEventListener('click', async () => {
      const target = Math.min(12, this.videoPitch + 1)
      await this.handleVideoPitchChange(target)
      updateVideoPitchUI()
    })

    // Shortcuts modal
    e.shortcutsBtn.addEventListener('click', () => this.showShortcuts())
    e.closeShortcuts.addEventListener('click', () => this.hideShortcuts())
    e.shortcutsModal.addEventListener('click', (ev) => {
      if (ev.target === e.shortcutsModal) this.hideShortcuts()
    })

    // Keyboard
    document.addEventListener('keydown', (ev) => this.handleKeyboard(ev))
  }

  private renderSpeedChips() {
    const container = this.els.speedChips
    container.innerHTML = ''

    DEFAULT_SPEEDS.forEach((speed) => {
      const btn = document.createElement('button')
      btn.className = `speed-chip ${speed === 1 ? 'active' : ''}`
      btn.textContent = speed + '×'
      btn.addEventListener('click', () => this.setPlaybackRate(speed))
      container.appendChild(btn)
    })
  }

  private updateSpeedUI() {
    const chips = this.els.speedChips.querySelectorAll('button')
    chips.forEach((chip) => {
      const val = parseFloat(chip.textContent!.replace('×', ''))
      chip.classList.toggle('active', Math.abs(val - this.playbackRate) < 0.01)
    })
    this.els.speedValue.textContent = this.playbackRate.toFixed(2) + '×'
  }

  // ---------- YouTube API ----------
  private initYouTubeAPI() {
    // The script is already in index.html
    window.onYouTubeIframeAPIReady = () => {
      console.log('[weblooper] YouTube IFrame API ready')
    }

    // In case the API is already loaded
    if (window.YT && window.YT.Player) {
      console.log('[weblooper] YouTube API was already available')
    }
  }

  private createPlayer(videoId: string) {
    if (this.player) {
      this.player.destroy()
      this.player = null
    }

    this.player = new window.YT.Player('yt-player', {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        fs: 1,
        playsinline: 1,
      },
      events: {
        onReady: (event: any) => this.onPlayerReady(event),
        onStateChange: (event: any) => this.onPlayerStateChange(event),
        onError: (event: any) => this.onPlayerError(event),
      },
    })
  }

  private onPlayerReady(_event: any) {
    this.playerReady = true

    // Duration can be 0 right after ready on some videos — poll briefly
    const grabDuration = () => {
      const d = this.player?.getDuration?.() || 0
      if (d > 1) {
        this.duration = d
        this.finishPlayerSetup()
      } else {
        // try a few more times
        setTimeout(grabDuration, 180)
      }
    }
    grabDuration()
  }

  private finishPlayerSetup() {
    // Restore saved state or defaults
    const saved = this.currentVideoId ? loadVideoState(this.currentVideoId) : null

    if (saved && saved.start != null && saved.end != null) {
      this.start = saved.start
      this.end = Math.min(saved.end, this.duration)
      this.isLooping = saved.isLooping ?? false
      this.playbackRate = saved.playbackRate ?? 1
      this.presets = saved.presets ?? []
    } else {
      this.start = 0
      this.end = Math.min(30, this.duration) // default 30s practice loop
      this.isLooping = false
      this.playbackRate = 1
      this.presets = []
    }

    this.updateAllUI()
    this.startTimeMonitor()

    // Apply initial rate
    if (this.player) this.player.setPlaybackRate(this.playbackRate)

    // Seek to loop start position but do NOT auto-play.
    // The user must explicitly press play after loading a video.
    if (this.isLooping && this.player) {
      this.seekTo(this.start)
    }
  }

  private onPlayerStateChange(event: any) {
    const state = event.data
    const YT = window.YT

    if (state === YT.PlayerState.ENDED) {
      if (this.isLooping) {
        this.seekTo(this.start)
        setTimeout(() => this.player?.playVideo(), 60)
      }
      // Notify any active recording that the video has ended
      if (this._onVideoEndedDuringCapture) {
        this._onVideoEndedDuringCapture()
        this._onVideoEndedDuringCapture = null
      }
    }

    // Update play/pause label
    this.updatePlayPauseUI(state)
  }

  private onPlayerError(event: any) {
    console.error('YT Player error', event)
    alert('YouTube player error. The video may be unavailable or restricted.')
  }

  private startTimeMonitor() {
    if (this.monitorInterval) window.clearInterval(this.monitorInterval)

    this.monitorInterval = window.setInterval(() => {
      if (!this.playerReady || !this.player) return

      try {
        const time = this.player.getCurrentTime() || 0
        this.lastKnownTime = time

        // Live update current time display
        this.els.currentTime.textContent = formatTime(time, true)
        this.els.timelineCurrent.textContent = formatTime(time, true)

        // Update timeline playhead
        this.updateTimeline()

        // Core loop enforcement (in case onStateChange missed it)
        if (this.isLooping && this.end > this.start) {
          if (time >= this.end - 0.08) {
            this.seekTo(this.start)
          }
        }
      } catch (e) {
        // player might be destroyed
      }
    }, 80) // ~12fps updates, smooth enough
  }

  private stopTimeMonitor() {
    if (this.monitorInterval) {
      window.clearInterval(this.monitorInterval)
      this.monitorInterval = null
    }
  }

  // ---------- Core Controls ----------
  private loadFromInput() {
    const val = this.els.urlInput.value.trim()
    if (!val) return
    this.loadVideoFromUrl(val)
  }

  private async loadVideoFromUrl(urlOrId: string) {
    const id = getYouTubeVideoId(urlOrId)
    if (!id) {
      alert('Could not parse a valid YouTube video ID from that link.')
      return
    }

    this.currentVideoId = id

    // Show player section
    this.els.loaderSection.classList.add('hidden')
    this.els.playerSection.classList.remove('hidden')
    this.els.separateStemsFromYtBtn.classList.remove('hidden')

    // Create the player (will trigger onReady)
    this.createPlayer(id)

    // Fetch title via oEmbed (best effort)
    this.fetchAndSetTitle(id)
  }

  /**
   * Entry point for local audio files.
   * This is the on-ramp for fully client-side stem separation (user provides audio,
   * heavy ML runs in their browser via WASM + WebGPU — zero server compute cost).
   *
   * Current state: real decoding to AudioBuffer works. Stem separation engine
   * integration is the next major piece (see docs/design-stem-separation.md).
   */
  private async loadLocalAudioFile(file: File) {
    console.log('[weblooper] Local audio selected:', file.name, (file.size / 1024 / 1024).toFixed(1), 'MB')

    // Show a temporary loading state in the loader area
    const originalLoaderHTML = this.els.loaderSection.innerHTML
    this.els.loaderSection.innerHTML = `
      <div class="max-w-[720px] mx-auto text-center py-8">
        <div class="text-emerald-400 mb-3">Decoding audio in browser…</div>
        <div class="text-2xl font-semibold tracking-tight">${file.name}</div>
        <div class="text-sm text-zinc-500 mt-1">This stays on your device</div>
      </div>
    `

    try {
      const decoded = await decodeAudioFile(file)
      const minutes = estimateSeparationMinutes(decoded.duration)

      // Replace loader with a nice "ready for stems" summary + actions
      this.els.loaderSection.innerHTML = `
        <div class="max-w-[720px] mx-auto">
          <div class="bg-zinc-900 border border-white/10 rounded-3xl p-8">
            <div class="uppercase tracking-[2px] text-xs text-emerald-400 mb-2">LOCAL AUDIO LOADED</div>
            <div class="text-2xl font-semibold tracking-tight truncate">${decoded.fileName}</div>

            <div class="flex items-center gap-4 text-sm text-zinc-400 mt-2">
              <span>${formatTime(decoded.duration)}</span>
              <span>•</span>
              <span>${decoded.numberOfChannels} ch</span>
              <span>•</span>
              <span>${decoded.sampleRate} Hz</span>
            </div>

            <div class="mt-6 text-sm text-zinc-400">
              Ready for stem separation.<br>
              First-time model download is ~85 MB. All processing happens in your browser.
            </div>

            <div class="mt-6 flex flex-wrap gap-3">
              <button id="btn-separate-stems"
                      class="btn-primary px-6 py-3 rounded-2xl font-semibold active:scale-[0.985] transition">
                Separate Stems (est. ~${minutes} min on this device)
              </button>

              <button id="btn-play-raw-audio"
                      class="px-6 py-3 rounded-2xl border border-white/10 hover:bg-white/5 font-medium transition">
                Play raw audio (no stems yet)
              </button>

              <button id="btn-change-audio-file"
                      class="px-5 py-3 rounded-2xl text-sm text-zinc-400 hover:text-zinc-200 transition">
                Choose different file
              </button>
            </div>
          </div>

          <p class="text-center text-[11px] text-zinc-500 mt-4">
            All processing in your browser. No uploads. No recurring cost.
          </p>
        </div>

        <!-- Previous stem separations (persisted via localStorage + OPFS) -->
        <div id="previous-stems-section" class="max-w-[720px] mx-auto mt-6 hidden">
          <div class="text-xs uppercase tracking-[1.5px] text-emerald-400 mb-2 px-1">PREVIOUS SEPARATIONS</div>
          <div id="previous-stems-list" class="bg-zinc-900 border border-white/10 rounded-3xl p-3 space-y-2 text-sm"></div>
          <div class="text-[10px] text-zinc-500 mt-2 px-1">Click Load to practice a previous separation without re-running the model.</div>
        </div>
      `

      // Wire the new buttons
      const separateBtn = document.getElementById('btn-separate-stems')
      const playRawBtn = document.getElementById('btn-play-raw-audio')
      const changeBtn = document.getElementById('btn-change-audio-file')

      separateBtn?.addEventListener('click', () => {
        // Prevent multiple rapid clicks from creating stacked progress UIs
        if (separateBtn.hasAttribute('disabled')) return
        separateBtn.setAttribute('disabled', 'true')

        this.els.loaderSection.classList.add('hidden')
        this.performStemSeparation(decoded)
      })

      playRawBtn?.addEventListener('click', () => {
        // Quick & dirty playback of the raw decoded audio using Web Audio
        this.playRawDecodedAudio(decoded)
      })

      changeBtn?.addEventListener('click', () => {
        // Restore original loader UI and focus the file input
        this.els.loaderSection.innerHTML = originalLoaderHTML
        // Re-attach listeners by re-rendering would be cleaner, but for now just reload the section
        location.reload() // simplest reliable reset for the spike
      })

      // Populate previous separations list (if any)
      this.renderPreviousStemSessions()

      // Store for later use by the real stem engine
      ;(this as any)._currentDecodedAudio = decoded

    } catch (err) {
      console.error('[weblooper] Audio decode failed', err)
      this.els.loaderSection.innerHTML = originalLoaderHTML
      alert(`Could not decode "${file.name}".\n\nTry a WAV or high-quality MP3. Some protected/encrypted files won't work in the browser.`)
    }
  }

  private playRawDecodedAudio(decoded: { buffer: AudioBuffer; fileName: string }) {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const source = ctx.createBufferSource()
    source.buffer = decoded.buffer
    source.connect(ctx.destination)
    source.start(0)

    // Simple one-shot player notice
    const notice = document.createElement('div')
    notice.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-zinc-900 border border-emerald-500/30 text-emerald-300 text-sm px-4 py-2 rounded-2xl shadow-xl z-[200]'
    notice.textContent = `Playing raw: ${decoded.fileName} (browser Web Audio)`
    document.body.appendChild(notice)

    const cleanup = () => {
      notice.style.transition = 'opacity 150ms'
      notice.style.opacity = '0'
      setTimeout(() => notice.remove(), 150)
      try { ctx.close() } catch {}
    }
    source.onended = cleanup

    // Also allow clicking the notice to stop early
    notice.addEventListener('click', () => {
      try { source.stop() } catch {}
      cleanup()
    }, { once: true })
  }

  /**
   * Render the list of previously saved stem sessions (from localStorage + OPFS).
   * Called after a local audio file is successfully decoded.
   */
  private async renderPreviousStemSessions() {
    const section = document.getElementById('previous-stems-section')
    const listEl = document.getElementById('previous-stems-list')
    if (!section || !listEl) return

    try {
      const { listStemSessions, loadStemSession, deleteStemSession } = await import('./stems')
      const sessions = listStemSessions()

      if (sessions.length === 0) {
        section.classList.add('hidden')
        return
      }

      section.classList.remove('hidden')
      listEl.innerHTML = ''

      sessions.slice(0, 6).forEach((sess) => {
        const row = document.createElement('div')
        row.className = 'flex items-center justify-between gap-3 bg-zinc-950 rounded-2xl px-4 py-2 border border-white/5'

        const date = new Date(sess.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        const label = sess.youtubeVideoTitle 
          ? sess.youtubeVideoTitle 
          : (sess.fileName || 'Unknown session')

        row.innerHTML = `
          <div class="min-w-0">
            <div class="font-medium truncate">${label}</div>
            <div class="text-[10px] text-zinc-500">${date} • ${formatTime(sess.duration)} • ${sess.stemNames.length} stems</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button class="load-prev px-3 py-1 text-xs rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">Load</button>
            <button class="del-prev px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400">Delete</button>
          </div>
        `

        row.querySelector('.load-prev')?.addEventListener('click', async () => {
          const loaded = await loadStemSession(sess.id)
          if (loaded && loaded.stems.length > 0) {
            // Enter practice mode directly with the persisted stems (no re-separation)
            this.els.loaderSection.classList.add('hidden')

            // Always open the pure stem practice view (no video) — regardless of source
            await this.enterStemPracticeWithRealStems(
              { fileName: loaded.meta.fileName || loaded.meta.youtubeVideoTitle || 'Stem Session', duration: loaded.meta.duration },
              loaded.stems,
              loaded.meta,
            )
          } else {
            console.error('[stems] Failed to load persisted session', sess.id, sess.fileName)
            try {
              await deleteStemSession(sess.id)
            } catch {}
            row.remove()
            if (listEl.children.length === 0) section.classList.add('hidden')

            alert(
              `Failed to load the audio data for "${sess.fileName}".\n\n` +
              `Possible causes: OPFS storage was cleared by the browser, disk quota exceeded, or there was an error during the original save.\n\n` +
              `Detailed reason has been logged to the browser console (look for "[stems] loadStemSession failed").\n\n` +
              `The broken entry has been removed. Please generate a fresh separation.`
            )
          }
        })

        row.querySelector('.del-prev')?.addEventListener('click', async () => {
          if (confirm(`Delete saved stems for "${sess.fileName}"?`)) {
            await deleteStemSession(sess.id)
            row.remove()
            // If list becomes empty, hide the section
            if (listEl.children.length === 0) section.classList.add('hidden')
          }
        })

        listEl.appendChild(row)
      })
    } catch (e) {
      console.warn('[weblooper] Could not render previous stem sessions', e)
      section.classList.add('hidden')
    }
  }

  /**
   * Version for the initial landing screen (shown on every page load / refresh).
   * This is what makes "previous work survives refresh" visible immediately.
   */
  private async renderInitialPreviousStems() {
    const section = document.getElementById('initial-previous-stems')
    const listEl = document.getElementById('initial-previous-stems-list')
    if (!section || !listEl) return

    try {
      const { listStemSessions, loadStemSession, deleteStemSession } = await import('./stems')
      const localSessions = listStemSessions()

      // Also fetch cloud sessions if signed in
      let cloudSessions: import('./drive').CloudSession[] = []
      let userIsSignedIn = false
      try {
        const { isSignedIn, fetchCloudSessions } = await import('./drive')
        userIsSignedIn = isSignedIn()
        if (userIsSignedIn) {
          cloudSessions = await fetchCloudSessions()
        }
      } catch {}

      // Merge: local sessions first, then cloud-only sessions
      const localIds = new Set(localSessions.map(s => s.id))
      const cloudIds = new Set(cloudSessions.map(s => s.id))
      const cloudOnlySessions = cloudSessions.filter(cs => !localIds.has(cs.id))

      const allSessions = [
        ...localSessions.map(s => ({ ...s, source: 'local' as const })),
        ...cloudOnlySessions.map(s => ({ ...s, source: 'cloud' as const })),
      ]

      if (allSessions.length === 0) {
        section.classList.add('hidden')
        return
      }

      section.classList.remove('hidden')
      listEl.innerHTML = ''

      allSessions.slice(0, 10).forEach((sess) => {
        const row = document.createElement('div')
        row.className = 'flex items-center justify-between gap-3 bg-zinc-950 rounded-2xl px-4 py-2 border border-white/5'

        const date = new Date(sess.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        const label = sess.youtubeVideoTitle 
          ? sess.youtubeVideoTitle 
          : (sess.fileName || 'Unknown session')

        // Determine session state
        const isLocal = sess.source === 'local'
        const isSynced = isLocal && userIsSignedIn && cloudIds.has(sess.id)
        const isCloudOnly = sess.source === 'cloud'
        const isLocalOnly = isLocal && (!userIsSignedIn || !cloudIds.has(sess.id))

        const cloudBadge = isCloudOnly
          ? '<span class="badge-cloud text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">cloud</span>'
          : isSynced
            ? '<span class="badge-synced text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">synced</span>'
            : ''

        // Show sync button for local sessions not yet in cloud (only if signed in)
        const showSyncBtn = isLocalOnly && userIsSignedIn

        // Delete button text depends on state
        let delBtnText: string
        let delBtnClass: string
        if (isSynced) {
          // Local + synced: first action is "Remove from device" (no confirm)
          delBtnText = 'Remove from device'
          delBtnClass = 'del-init px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-amber-400'
        } else if (isCloudOnly) {
          // Cloud only: "Delete" with confirm
          delBtnText = 'Delete'
          delBtnClass = 'del-init px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400'
        } else {
          // Local only: "Delete" no confirm
          delBtnText = 'Delete'
          delBtnClass = 'del-init px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400'
        }

        row.innerHTML = `
          <div class="min-w-0">
            <div class="font-medium truncate flex items-center gap-2">${label} ${cloudBadge}</div>
            <div class="text-[10px] text-zinc-500">${date} • ${formatTime(sess.duration)} • ${sess.stemNames.length} stems</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${showSyncBtn ? '<button class="sync-init px-2 py-1 text-xs rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20" title="Upload to Google Drive"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></button>' : ''}
            <button class="load-init px-3 py-1 text-xs rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">${isCloudOnly ? 'Download' : 'Load'}</button>
            <button class="${delBtnClass}">${delBtnText}</button>
          </div>
        `

        row.querySelector('.load-init')?.addEventListener('click', async () => {
          if (sess.source === 'cloud') {
            // Download from cloud
            await this.loadCloudSession(sess as import('./drive').CloudSession)
          } else {
            // Load from local OPFS
            const loaded = await loadStemSession(sess.id)
            if (loaded && loaded.stems.length > 0) {
              this.els.loaderSection.classList.add('hidden')

              // Always open the pure stem practice view (no video)
              await this.enterStemPracticeWithRealStems(
                { fileName: loaded.meta.fileName || loaded.meta.youtubeVideoTitle || 'Stem Session', duration: loaded.meta.duration },
                loaded.stems,
                loaded.meta,
              )
            } else {
              console.error('[stems] Failed to load persisted session', sess.id, sess.fileName)
              try {
                await deleteStemSession(sess.id)
              } catch {}
              row.remove()
              if (listEl.children.length === 0) section.classList.add('hidden')

              alert(
                `Failed to load the audio data for "${sess.fileName}".\n\n` +
                `Possible causes: OPFS storage was cleared by the browser, disk quota exceeded, or there was an error during the original save.\n\n` +
                `The broken entry has been removed. Please generate a fresh separation.`
              )
            }
          }
        })

        // Delete/Remove button handler
        row.querySelector('.del-init')?.addEventListener('click', async () => {
          if (isSynced) {
            // Local + synced → "Remove from device": delete local only, transform row to cloud-only
            await deleteStemSession(sess.id)

            // Transform the row in-place to a cloud-only row
            const loadBtn = row.querySelector('.load-init') as HTMLButtonElement
            const delBtn = row.querySelector('.del-init') as HTMLButtonElement
            const badgeEl = row.querySelector('.badge-synced')
            const syncBtn = row.querySelector('.sync-init')

            // Update load button
            if (loadBtn) loadBtn.textContent = 'Download'

            // Remove synced badge, add cloud badge
            if (badgeEl) {
              badgeEl.className = 'text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20'
              badgeEl.textContent = 'cloud'
            }

            // Remove sync button if present
            if (syncBtn) syncBtn.remove()

            // Transform delete button to cloud delete (with confirm)
            delBtn.textContent = 'Delete'
            delBtn.className = 'del-init px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400'

            // Replace the old event listener by cloning
            const newDelBtn = delBtn.cloneNode(true) as HTMLButtonElement
            delBtn.replaceWith(newDelBtn)
            newDelBtn.addEventListener('click', async () => {
              if (confirm(`Permanently delete "${sess.fileName || label}" from Google Drive?`)) {
                const { deleteCloudSession } = await import('./drive')
                await deleteCloudSession(sess.id)
                row.remove()
                if (listEl.children.length === 0) section.classList.add('hidden')
              }
            })

            // Update the load button to download from cloud
            const newLoadBtn = loadBtn.cloneNode(true) as HTMLButtonElement
            loadBtn.replaceWith(newLoadBtn)
            newLoadBtn.addEventListener('click', async () => {
              const cloudSession = cloudSessions.find(cs => cs.id === sess.id)
              if (cloudSession) {
                await this.loadCloudSession(cloudSession)
              }
            })

          } else if (isCloudOnly) {
            // Cloud only → confirm then delete from Drive
            if (confirm(`Permanently delete "${sess.fileName || label}" from Google Drive?`)) {
              const { deleteCloudSession } = await import('./drive')
              await deleteCloudSession(sess.id)
              row.remove()
              if (listEl.children.length === 0) section.classList.add('hidden')
            }
          } else {
            // Local only → just delete, no confirm
            await deleteStemSession(sess.id)
            row.remove()
            if (listEl.children.length === 0) section.classList.add('hidden')
          }
        })

        // Sync button for local sessions not yet in cloud
        const syncInitBtn = row.querySelector('.sync-init') as HTMLButtonElement | null
        if (syncInitBtn) {
          syncInitBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            syncInitBtn.disabled = true
            syncInitBtn.innerHTML = '<span class="text-[10px]">...</span>'

            try {
              // Load stems from OPFS
              const loaded = await loadStemSession(sess.id)
              if (!loaded || loaded.stems.length === 0) {
                syncInitBtn.innerHTML = '<span class="text-[10px] text-rose-400">!</span>'
                return
              }

              const { uploadStemSession } = await import('./drive')
              await uploadStemSession(
                sess,
                loaded.stems,
                (p) => {
                  if (p.phase === 'done') {
                    // Replace sync button with synced badge
                    syncInitBtn.remove()
                    const badge = document.createElement('span')
                    badge.className = 'badge-synced text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    badge.textContent = 'synced'
                    row.querySelector('.font-medium')?.appendChild(badge)

                    // Update delete button to "Remove from device"
                    const delBtn = row.querySelector('.del-init') as HTMLButtonElement | null
                    if (delBtn) {
                      delBtn.textContent = 'Remove from device'
                      delBtn.className = 'del-init px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-amber-400'
                    }
                  }
                },
              )
            } catch (err) {
              console.error('[drive-sync] List item sync failed:', err)
              syncInitBtn.disabled = false
              syncInitBtn.innerHTML = '<span class="text-[10px] text-rose-400">!</span>'
            }
          })
        }

        listEl.appendChild(row)
      })
    } catch (e) {
      console.warn('[weblooper] Could not render initial previous stem sessions', e)
      section?.classList.add('hidden')
    }
  }

  /**
   * Load a stem session from Google Drive (cloud-only session).
   */
  private async loadCloudSession(session: import('./drive').CloudSession) {
    try {
      const { downloadStemSession } = await import('./drive')

      // Show a loading indicator
      const loaderSection = this.els.loaderSection
      const prevHTML = loaderSection.innerHTML
      loaderSection.innerHTML = `
        <div class="text-center py-12">
          <div class="text-emerald-400 text-xs tracking-[2px] mb-2">DOWNLOADING FROM CLOUD</div>
          <div class="text-xl font-semibold tracking-tight mb-2">${session.fileName || 'Stem Session'}</div>
          <div id="cloud-download-status" class="text-sm text-zinc-400">Downloading stems...</div>
          <div class="mt-4 h-2 bg-zinc-800 rounded-full overflow-hidden max-w-[400px] mx-auto">
            <div id="cloud-download-bar" class="h-2 bg-emerald-500 w-[5%] transition-all"></div>
          </div>
        </div>
      `

      const statusEl = document.getElementById('cloud-download-status')
      const barEl = document.getElementById('cloud-download-bar')

      const stems = await downloadStemSession(session, (p) => {
        if (statusEl) statusEl.textContent = p.message
        if (barEl && p.percent !== undefined) barEl.style.width = `${p.percent}%`
      })

      if (stems && stems.length > 0) {
        // Also save to OPFS for future local access (cache), preserving the cloud session ID
        try {
          const { saveStemSession } = await import('./stems')
          await saveStemSession(
            {
              fileName: session.fileName,
              duration: session.duration,
              stemNames: session.stemNames,
              model: session.model,
              youtubeVideoId: session.youtubeVideoId,
              youtubeVideoTitle: session.youtubeVideoTitle,
              presets: session.presets,   // Carry saved loops/presets from cloud
            },
            stems,
            session.id,  // Preserve cloud ID so deduplication works
          )
        } catch (e) {
          console.warn('[drive-sync] Failed to cache cloud session locally:', e)
        }

        // Hide loader and open stem player
        loaderSection.classList.add('hidden')
        await this.enterStemPracticeWithRealStems(
          { fileName: session.fileName || 'Cloud Session', duration: session.duration },
          stems,
          session,
        )
      } else {
        // Restore loader
        loaderSection.innerHTML = prevHTML
        alert('Failed to download stems from cloud. The session may have been deleted.')
      }
    } catch (err: any) {
      console.error('[drive-sync] Cloud session load failed:', err)
      alert(`Failed to load cloud session: ${err.message}`)
    }
  }

  /**
   * Small helper to re-enable the "Separate Stems" button after the user
   * cancels or hits an error and is sent back to the action card.
   */
  private reEnableSeparateStemsButton() {
    const btn = document.getElementById('btn-separate-stems')
    if (btn) btn.removeAttribute('disabled')
  }

  /**
   * Read the recent video entries (sorted by lastVisited desc) from localStorage.
   * Used by the home-screen "Recent videos" quick-re-entry list.
   */
  private getRecentVideoEntries(limit = 10) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return []
      const all = JSON.parse(raw)
      const entries = Object.values(all).map(sanitizeVideoState) as any[]
      entries.sort((a: any, b: any) => (b.lastVisited || 0) - (a.lastVisited || 0))
      return entries.slice(0, limit)
    } catch {
      return []
    }
  }

  /**
   * Render the "Recent videos" list on the initial landing screen.
   * This gives users a one-click way to jump back to videos they were looping,
   * with all their custom loops, presets, and settings restored automatically.
   */
  private async renderInitialRecentVideos() {
    const section = document.getElementById('initial-recent-videos')
    const listEl = document.getElementById('initial-recent-videos-list')
    if (!section || !listEl) return

    try {
      // Also fetch cloud video states if signed in (lightweight JSON)
      let cloudStates: Record<string, any> = {}
      let userIsSignedIn = false
      try {
        const { isSignedIn, fetchCloudVideoStates } = await import('./drive')
        userIsSignedIn = isSignedIn()
        if (userIsSignedIn) {
          cloudStates = await fetchCloudVideoStates()
        }
      } catch {}

      // === Merge cloud updates into existing local video states ===
      // This is the key fix: if a video already exists locally, we still pull
      // newer loop points / presets from the cloud version (based on lastVisited
      // or presence of presets). This makes saved loops appear on other devices.
      if (userIsSignedIn && Object.keys(cloudStates).length > 0) {
        try {
          let localAll = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
          let changed = false

          for (const [id, cloudRaw] of Object.entries(cloudStates)) {
            const cloud = sanitizeVideoState(cloudRaw)
            const local = sanitizeVideoState(localAll[id] || {})

            const cloudVisited = cloud.lastVisited || 0
            const localVisited = local.lastVisited || 0

            const cloudHasPresets = Array.isArray(cloud.presets) && cloud.presets.length > 0
            const localHasPresets = Array.isArray(local.presets) && local.presets.length > 0

            // Pull cloud data if it's newer, or if cloud has presets that local is missing
            if (cloudVisited > localVisited || (cloudHasPresets && !localHasPresets)) {
              localAll[id] = sanitizeVideoState({
                ...local,
                ...cloud,
                lastVisited: Math.max(cloudVisited, localVisited, Date.now())
              })
              changed = true
            }
          }

          if (changed) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(localAll))
          }
        } catch (e) {
          console.warn('[video-sync] Failed to merge cloud video states into local', e)
        }
      }

      // Re-read local after possible merge so the list reflects fresh data
      const localEntries = this.getRecentVideoEntries(20)

      const localIds = new Set(localEntries.map((e: any) => e.videoId))
      const cloudOnlyIds = Object.keys(cloudStates).filter(id => !localIds.has(id))

      const cloudOnlyEntries = cloudOnlyIds.map(id => ({
        ...sanitizeVideoState(cloudStates[id] || {}),
        videoId: id,
        source: 'cloud' as const,
      }))

      const allEntries = [
        ...localEntries.map((e: any) => ({ ...e, source: 'local' as const })),
        ...cloudOnlyEntries,
      ]

      if (allEntries.length === 0) {
        section.classList.add('hidden')
        return
      }

      section.classList.remove('hidden')
      listEl.innerHTML = ''

      allEntries.slice(0, 12).forEach((entry: any) => {
        const row = document.createElement('div')
        row.className = 'flex items-center justify-between gap-3 bg-zinc-950 rounded-2xl px-4 py-2 border border-white/5'

        const date = entry.lastVisited
          ? new Date(entry.lastVisited).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : ''
        const label = entry.title || `YouTube ${entry.videoId}`
        const presetCount = Array.isArray(entry.presets) ? entry.presets.length : 0
        const meta = presetCount > 0
          ? `${date} • ${presetCount} saved loop${presetCount === 1 ? '' : 's'}`
          : date

        const isLocal = entry.source === 'local'
        const isSynced = isLocal && userIsSignedIn && (cloudStates as any)[entry.videoId]
        const isCloudOnly = entry.source === 'cloud'
        const isLocalOnly = isLocal && (!userIsSignedIn || !(cloudStates as any)[entry.videoId])

        const cloudBadge = isCloudOnly
          ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">cloud</span>'
          : isSynced
            ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">synced</span>'
            : ''

        const showSyncBtn = isLocalOnly && userIsSignedIn

        let delBtnText: string
        let delBtnClass: string
        if (isSynced) {
          delBtnText = 'Remove from device'
          delBtnClass = 'del-recent px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-amber-400'
        } else if (isCloudOnly) {
          delBtnText = 'Delete'
          delBtnClass = 'del-recent px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400'
        } else {
          delBtnText = 'Delete'
          delBtnClass = 'del-recent px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400'
        }

        row.innerHTML = `
          <div class="min-w-0">
            <div class="font-medium truncate flex items-center gap-2">${label} ${cloudBadge}</div>
            <div class="text-[10px] text-zinc-500">${meta || 'Previously loaded'}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${showSyncBtn ? '<button class="sync-video px-2 py-1 text-xs rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20" title="Upload to Google Drive"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></button>' : ''}
            <button class="load-recent px-3 py-1 text-xs rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">${isCloudOnly ? 'Download' : 'Load'}</button>
            <button class="${delBtnClass}">${delBtnText}</button>
          </div>
        `

        // Load / Download
        row.querySelector('.load-recent')?.addEventListener('click', async () => {
          if (isCloudOnly) {
            // Merge cloud state into localStorage, then load.
            // Sanitize to avoid writing UI-only fields (e.g. "source") into the persisted state.
            try {
              const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
              const clean = sanitizeVideoState(entry)
              all[entry.videoId] = { ...clean, lastVisited: Date.now() }
              localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
            } catch {}
          }
          this.els.loaderSection.classList.add('hidden')
          this.loadVideoFromUrl(entry.videoId)
        })

        // Delete / Remove
        row.querySelector('.del-recent')?.addEventListener('click', async () => {
          const doRemoveLocal = async () => {
            try {
              const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
              delete all[entry.videoId]
              localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
            } catch {}
            row.remove()
            if (listEl.children.length === 0) section.classList.add('hidden')
          }

          if (isSynced) {
            // Remove local only — transform row to cloud-only
            await doRemoveLocal()

            // Re-render to reflect the new state (simplest reliable path)
            this.renderInitialRecentVideos()
          } else if (isCloudOnly) {
            if (confirm(`Permanently delete "${label}" from Google Drive?`)) {
              const { deleteCloudVideoState } = await import('./drive')
              await deleteCloudVideoState(entry.videoId)
              row.remove()
              if (listEl.children.length === 0) section.classList.add('hidden')
            }
          } else {
            // Local only
            if (confirm(`Remove "${label}" from recent videos?`)) {
              await doRemoveLocal()
            }
          }
        })

        // Per-item Sync to cloud
        const syncBtn = row.querySelector('.sync-video') as HTMLButtonElement | null
        if (syncBtn) {
          syncBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            syncBtn.disabled = true
            syncBtn.innerHTML = '<span class="text-[10px]">...</span>'

            try {
              const { uploadVideoStates } = await import('./drive')
              // Read the freshest local states and push everything
              const raw = localStorage.getItem(STORAGE_KEY) || '{}'
              const localMap = JSON.parse(raw)
              await uploadVideoStates(localMap)

              // Refresh list so it shows as synced
              this.renderInitialRecentVideos()
            } catch (err) {
              console.error('[drive-sync] Video sync failed:', err)
              syncBtn.innerHTML = '<span class="text-[10px] text-rose-400">!</span>'
              syncBtn.disabled = false
            }
          })
        }

        listEl.appendChild(row)
      })
    } catch (e) {
      console.warn('[weblooper] Could not render initial recent videos with cloud', e)
      // Fallback to local-only render
      const entries = this.getRecentVideoEntries(10)
      if (entries.length === 0) {
        section.classList.add('hidden')
        return
      }
      section.classList.remove('hidden')
      listEl.innerHTML = ''
      // Simple fallback rendering (old behavior)
      entries.forEach((entry: any) => {
        const row = document.createElement('div')
        row.className = 'flex items-center justify-between gap-3 bg-zinc-950 rounded-2xl px-4 py-2 border border-white/5'
        const label = entry.title || `YouTube ${entry.videoId}`
        row.innerHTML = `
          <div class="min-w-0">
            <div class="font-medium truncate">${label}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button class="load-recent px-3 py-1 text-xs rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">Load</button>
            <button class="del-recent px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400">Delete</button>
          </div>
        `
        row.querySelector('.load-recent')?.addEventListener('click', () => {
          this.els.loaderSection.classList.add('hidden')
          this.loadVideoFromUrl(entry.videoId)
        })
        row.querySelector('.del-recent')?.addEventListener('click', () => {
          if (confirm(`Remove "${label}" from recent videos?`)) {
            try {
              const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
              delete all[entry.videoId]
              localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
            } catch {}
            row.remove()
            if (listEl.children.length === 0) section.classList.add('hidden')
          }
        })
        listEl.appendChild(row)
      })
    }
  }

  /**
   * Actual heavy work (model download + inference).
   */
  /**
   * Public-friendly entry point: Start stem separation from a YouTube URL or video ID.
   * This can be used from the loader when the user pastes a YouTube link.
   */
  async startStemSeparationFromYouTube(urlOrVideoId: string) {
    const videoId = this.extractYouTubeVideoId(urlOrVideoId);
    if (!videoId) {
      throw new Error('Invalid YouTube URL or video ID');
    }
    await this.startYouTubeStemSeparation(videoId);
  }

  /**
   * Advanced: Get available audio formats for a YouTube video (useful for future format picker).
   */
  async getYouTubeAudioFormats(urlOrVideoId: string) {
    const videoId = this.extractYouTubeVideoId(urlOrVideoId);
    if (!videoId) throw new Error('Invalid YouTube URL or video ID');

    const { getYouTubeVideoAudioInfo } = await import('./youtube');
    return await getYouTubeVideoAudioInfo(videoId);
  }

  private extractYouTubeVideoId(input: string): string | null {
    // Handles youtu.be, youtube.com/watch, youtube.com/embed, etc.
    const match = input.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/) || input.match(/^([0-9A-Za-z_-]{11})$/);
    return match ? match[1] : null;
  }

  /**
   * Show a choice dialog letting the user pick between browser-based and Colab-based
   * stem separation. Returns 'browser' | 'colab' | null (cancelled).
   */
  private showStemMethodChoice(): Promise<'browser' | 'colab' | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'fixed inset-0 bg-black/70 backdrop-blur z-[400] flex items-center justify-center p-6'
      overlay.innerHTML = `
        <div class="bg-zinc-900 border border-white/10 rounded-3xl p-6 max-w-md w-full">
          <div class="text-lg font-semibold text-emerald-400 mb-3">Separate Stems</div>
          <div class="text-sm text-zinc-400 mb-5">Choose how to split this track into stems (drums, bass, guitar, piano, vocals, other):</div>
          <div id="stem-choice-buttons" class="space-y-3">
            <button id="stem-choice-colab" class="w-full text-left px-4 py-3 rounded-2xl border border-blue-500/30 bg-blue-500/5 hover:border-blue-500/50 hover:bg-blue-500/10 transition-colors">
              <div class="text-sm font-medium text-white flex items-center gap-2">In Google Colab (free GPU) <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 uppercase tracking-wide">Recommended</span></div>
              <div class="text-xs text-zinc-400 mt-0.5">Opens a notebook on a free T4 GPU. ~2-4 min. No tab capture needed. Requires Google sign-in.</div>
            </button>
            <button id="stem-choice-browser" class="w-full text-left px-4 py-3 rounded-2xl border border-white/10 hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors">
              <div class="text-sm font-medium text-white">In Browser (WebGPU)</div>
              <div class="text-xs text-zinc-400 mt-0.5">Uses your GPU via WebAssembly. ~3-5 min. Requires tab audio capture.</div>
            </button>
          </div>
          <div class="mt-4 text-right">
            <button id="stem-choice-cancel" class="text-xs text-zinc-400 hover:text-white">Cancel</button>
          </div>
        </div>
      `

      const close = (result: 'browser' | 'colab' | null) => {
        overlay.remove()
        resolve(result)
      }

      overlay.querySelector('#stem-choice-browser')!.addEventListener('click', () => close('browser'))
      overlay.querySelector('#stem-choice-colab')!.addEventListener('click', () => {
        // Show loading state immediately so user sees feedback
        const buttonsEl = overlay.querySelector('#stem-choice-buttons')!
        buttonsEl.innerHTML = `
          <div class="flex items-center gap-3 py-4 px-2">
            <div class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-sm text-zinc-300">Preparing Colab session (creating Drive folder + notebook)...</span>
          </div>
        `
        // Hide cancel button during prep
        const cancelBtn = overlay.querySelector('#stem-choice-cancel') as HTMLElement
        if (cancelBtn) cancelBtn.style.display = 'none'
        // Resolve but keep overlay visible — startColabStemSeparation will remove it
        resolve('colab')
      })
      overlay.querySelector('#stem-choice-cancel')!.addEventListener('click', () => close(null))
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null) })

      document.body.appendChild(overlay)
    })
  }

  /**
   * Start Colab-based stem separation for the current YouTube video.
   * Creates a session in Drive, uploads the pre-configured notebook, opens Colab,
   * then polls Drive for finished stems and auto-loads them.
   */
  private async startColabStemSeparation(videoId: string) {
    const { isSignedIn, signIn } = await import('./drive')
    if (!isSignedIn()) {
      await signIn()
      if (!isSignedIn()) {
        throw new Error('Google sign-in is required for Colab stem separation.')
      }
    }

    const ytTitle = (this.els.videoTitle?.textContent || '').trim() || `YouTube ${videoId}`
    const videoDuration = this.duration || this.player?.getDuration?.() || 0
    const sessionId = `colab-stems-${videoId}-${Date.now().toString(36)}`

    // Create placeholder session folder in Drive
    const { createStemColabSession, createStemColabNotebook, checkStemColabStatus, downloadStemFile } = await import('./drive/sync')
    const folderId = await createStemColabSession(sessionId, videoId, ytTitle, videoDuration)

    // Upload the pre-configured notebook
    const notebookFileId = await createStemColabNotebook(sessionId, folderId, videoId)
    const colabUrl = `https://colab.research.google.com/drive/${notebookFileId}`

    // Open Colab in a new tab
    const colabStartedAt = new Date().toISOString()

    // Remove the choice dialog (it was kept open to show the loading spinner)
    document.querySelectorAll('#stem-choice-buttons')?.forEach(el => el.closest('.fixed')?.remove())

    // Show a progress/waiting modal
    const overlay = document.createElement('div')
    overlay.className = 'fixed inset-0 bg-black/70 backdrop-blur z-[400] flex items-center justify-center p-6'
    overlay.setAttribute('data-colab-stem-modal', 'true')
    overlay.innerHTML = `
      <div class="bg-zinc-900 border border-white/10 rounded-3xl p-6 max-w-lg w-full">
        <div class="text-lg font-semibold text-blue-400 mb-3">Colab Stem Separation</div>
        <div class="text-sm text-zinc-300 space-y-2">
          <div>A ready-to-run notebook has been uploaded to your Drive.</div>
          <div class="text-xs text-zinc-400">In Colab: Runtime &rarr; Change type &rarr; T4 GPU &rarr; Run all.</div>
          <div class="text-xs text-zinc-500">Session: <span class="font-mono">${sessionId.slice(0, 20)}…</span></div>
          <div class="flex items-center gap-2 mt-3 text-xs text-emerald-400">
            <div class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></div>
            <span id="colab-stem-poll-status">Watching Drive for finished stems (auto-loads when Colab finishes)…</span>
          </div>
        </div>
        <div class="mt-5 flex flex-wrap gap-3">
          <button id="open-colab-stem-btn" class="px-4 py-2 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">Open in Colab</button>
          <button id="cancel-colab-stem-btn" class="px-4 py-2 rounded-2xl border border-white/20 hover:bg-white/5 text-sm text-zinc-300">Cancel</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    // Wire buttons
    overlay.querySelector('#open-colab-stem-btn')!.addEventListener('click', () => {
      window.open(colabUrl, '_blank')
    })

    // Auto-open Colab
    setTimeout(() => { try { window.open(colabUrl, '_blank') } catch {} }, 300)

    // Polling state
    let pollingInterval: ReturnType<typeof setInterval> | null = null
    let pollingTimeout: ReturnType<typeof setTimeout> | null = null
    const POLL_INTERVAL_MS = 15_000
    const POLL_MAX_MS = 10 * 60_000

    const stopPolling = () => {
      if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null }
      if (pollingTimeout) { clearTimeout(pollingTimeout); pollingTimeout = null }
    }

    const closeModal = () => {
      stopPolling()
      overlay.remove()
    }

    overlay.querySelector('#cancel-colab-stem-btn')!.addEventListener('click', closeModal)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal() })

    // Poll for results
    const pollForStems = async () => {
      try {
        const result = await checkStemColabStatus(folderId, colabStartedAt)
        if (!result) return

        // Stems are ready! Download them all
        stopPolling()
        const pollStatusEl = overlay.querySelector('#colab-stem-poll-status')
        if (pollStatusEl) pollStatusEl.textContent = 'Stems ready! Downloading…'

        const stemNames = result.stemNames // e.g. ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other']
        const audioCtx = new AudioContext({ sampleRate: 44100 })
        const stems: Array<{ name: string; buffer: AudioBuffer }> = []

        for (const name of stemNames) {
          const data = await downloadStemFile(folderId, name)
          if (!data) {
            console.warn(`[colab-stems] Could not download ${name}.webm`)
            continue
          }
          const decoded = await audioCtx.decodeAudioData(data)
          stems.push({ name, buffer: decoded })
        }
        audioCtx.close()

        if (stems.length === 0) {
          closeModal()
          alert('Colab finished but no stem files could be downloaded.')
          return
        }

        closeModal()

        // Hide video player UI before entering stem practice (avoid duplicate UI)
        this.els.playerSection.classList.add('hidden')
        this.els.loaderSection.classList.add('hidden')

        // Save to OPFS + enter stem player (reuse existing infra)
        // Preserve the original colab session ID so it matches the manifest entry
        const { saveStemSession } = await import('./stems')
        await saveStemSession(
          {
            youtubeVideoId: videoId,
            youtubeVideoTitle: ytTitle,
            fileName: `YouTube — ${ytTitle}`,
            duration: videoDuration || stems[0].buffer.duration,
            stemNames: stems.map(s => s.name),
            model: 'colab-htdemucs_6s',
          },
          stems,
          sessionId,  // preserve the colab session ID
        )

        // Update the manifest entry with stemNames (it was already added in createStemColabSession)
        try {
          const { updateCloudStemMeta } = await import('./drive')
          await updateCloudStemMeta(sessionId, { stemNames: stems.map(s => s.name) })
        } catch {}

        // Enter stem player
        this.enterStemPracticeWithRealStems(
          { fileName: `YouTube — ${ytTitle}`, duration: videoDuration || stems[0].buffer.duration },
          stems,
          {
            id: sessionId,
            fileName: `YouTube — ${ytTitle}`,
            duration: videoDuration || stems[0].buffer.duration,
            stemNames: stems.map(s => s.name),
            model: 'colab-htdemucs_6s',
            createdAt: Date.now(),
            youtubeVideoId: videoId,
            youtubeVideoTitle: ytTitle,
          },
        )

      } catch (err) {
        console.debug('[colab-stems poll] Error:', err)
      }
    }

    pollingInterval = setInterval(pollForStems, POLL_INTERVAL_MS)
    pollingTimeout = setTimeout(() => {
      stopPolling()
      const pollStatusEl = overlay.querySelector('#colab-stem-poll-status')
      if (pollStatusEl) pollStatusEl.textContent = 'Polling timed out (10 min). Check Colab manually and reload.'
    }, POLL_MAX_MS)
  }

  /**
   * Start stem separation for a YouTube video that is **already loaded**.
   *
   * - The normal video UI is replaced by a dedicated blocking card (user cannot touch the video).
   * - Card shows "Recording..." (tab audio capture) then transitions to "Breaking into stems...".
   * - On success we save the stems with the youtubeVideoId so key/pitch shift can find them later.
   * - We immediately launch the pure independent stem looper (enterStemPracticeWithRealStems)
   *   with full timeline, loop controls, mixer, speed, etc. — zero sync with the YouTube player.
   *
   * The underlying YouTube player iframe stays mounted (but visually hidden) only long enough
   * for the tab audio capture to record clean audio while the video plays at 1x.
   */
  private async startYouTubeStemSeparationForCurrentVideo(videoId: string) {
    // Hide the entire YouTube player UI (video + timeline + controls) so the user
    // cannot touch or see the video at all during the recording + separation process.
    this.els.playerSection.classList.add('hidden')

    // Capture the title before we hide (best effort for the stem session label)
    const ytTitle = (this.els.videoTitle?.textContent || '').trim() || `YouTube ${videoId}`

    const videoDuration = this.duration || this.player?.getDuration?.() || 0
    const timeEstimate = videoDuration > 0
      ? ` (~${Math.floor(videoDuration / 60)}:${(Math.ceil(videoDuration) % 60).toString().padStart(2, '0')})`
      : ''

    // CRITICAL: Force-disable looping for the entire capture.
    // If the user previously had LOOP ON, the time monitor + onPlayerStateChange would
    // keep seeking back to the loop start, so we would only ever record a tiny repeated
    // section instead of the full track. Recording must always be linear from 0.
    const prevIsLooping = this.isLooping
    const prevLoopStart = this.start
    const prevLoopEnd = this.end
    this.isLooping = false
    this.stopTimeMonitor()

    // Snapshot the current YouTube player volume/mute state.
    // We will force 100% volume (unmuted) during the recording so the tab audio capture
    // always gets the full, clean audio level regardless of what the user had set before.
    let prevVolume = 100
    let prevMuted = false
    try {
      if (this.player && this.playerReady) {
        prevVolume = this.player.getVolume?.() ?? 100
        prevMuted = this.player.isMuted?.() ?? false
      }
    } catch {} 

    // Force the iframe player to 100% volume (unmuted) for the capture.
    // This guarantees the recorded audio for stem separation is at the intended level.
    try {
      if (this.player && this.playerReady) {
        this.player.unMute?.()
        this.player.setVolume?.(100)
      }
    } catch {}

    // Create the single blocking progress card (styled exactly like the local-audio flow).
    // This card lives in the main content area and completely replaces the video experience.
    const area = document.createElement('div')
    area.id = 'yt-stem-capture-progress'
    area.className = 'max-w-[720px] mx-auto'
    this.els.playerSection.parentElement!.appendChild(area)

    // Initial card content — Recording phase
    area.innerHTML = `
      <div class="bg-zinc-900 border border-white/10 rounded-3xl p-8">
        <div class="text-emerald-400 text-xs tracking-[2px] mb-1">YOUTUBE STEM SEPARATION</div>
        <div class="text-2xl font-semibold tracking-tight mb-2" id="yt-card-title">Recording audio from tab${timeEstimate}</div>
        <div class="text-sm text-zinc-400 mb-4">The video is hidden during capture. Stems will open in the looper when done.</div>

        <div class="h-2 bg-zinc-800 rounded-full overflow-hidden mb-3">
          <div id="yt-card-bar" class="h-2 bg-emerald-500 w-[5%] transition-all"></div>
        </div>
        <div id="yt-card-status" class="text-sm text-zinc-400">Requesting tab audio access…</div>

        <div class="mt-6 flex gap-3">
          <button id="yt-stop-rec" class="text-sm text-emerald-400 hover:text-emerald-300 hidden">
            ■ Stop Recording (use what we captured)
          </button>
          <button id="yt-cancel" class="text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
        </div>
      </div>
    `

    const progressBar = area.querySelector('#yt-card-bar') as HTMLElement
    const statusEl = area.querySelector('#yt-card-status') as HTMLElement
    const titleEl = area.querySelector('#yt-card-title') as HTMLElement
    const cancelBtn = area.querySelector('#yt-cancel') as HTMLButtonElement
    const stopBtn = area.querySelector('#yt-stop-rec') as HTMLButtonElement

    let cancelled = false
    const abortController = new AbortController()
    const originalPlaybackRate = this.playbackRate

    // Watchdog interval that keeps re-asserting 100% volume during the entire recording.
    // YouTube can (and does) sometimes re-apply its own volume state mid-playback.
    let volumeLockInterval: number | null = null

    const cleanupAndRestorePlayer = () => {
      // Stop the volume lock first
      if (volumeLockInterval) {
        clearInterval(volumeLockInterval)
        volumeLockInterval = null
      }
      this._onVideoEndedDuringCapture = null
      try { this.restorePlaybackStateAfterCapture(originalPlaybackRate) } catch {}
      // Restore whatever loop state the user had before they clicked "Separate Stems"
      this.isLooping = prevIsLooping
      if (prevIsLooping) {
        this.start = prevLoopStart
        this.end = prevLoopEnd
      }
      // Restore the original volume/mute state the user had before capture started
      try {
        if (this.player && this.playerReady) {
          if (prevMuted) {
            this.player.mute?.()
          } else {
            this.player.unMute?.()
          }
          this.player.setVolume?.(prevVolume)
        }
      } catch {}
      this.updateAllUI()
      this.startTimeMonitor()
      area.remove()
      this.els.playerSection.classList.remove('hidden')
    }

    // Cancel = discard everything and go back to the video
    cancelBtn.addEventListener('click', () => {
      cancelled = true
      abortController.abort()
      cleanupAndRestorePlayer()
    })

    // Stop Recording early → capture resolves with whatever audio we have so far
    stopBtn.addEventListener('click', () => {
      abortController.abort()
    })

    // Auto-stop recording when the YouTube video reaches ENDED state
    this._onVideoEndedDuringCapture = () => {
      abortController.abort()
    }

    try {
      // ============================================
      // PHASE 1: Tab audio capture (recording)
      // ============================================
      statusEl.textContent = `Requesting tab audio access${timeEstimate}`
      progressBar.style.width = '3%'

      const { youtubeVideoToAudioBuffer } = await import('./youtube')

      const result = await youtubeVideoToAudioBuffer(videoId, (message, percent) => {
        if (cancelled) return
        // During recording the message is already the pretty "Recording... 0:12 elapsed, ~3:45 remaining"
        statusEl.textContent = message
        if (percent !== undefined) {
          // Capture owns the first ~40% of the overall progress bar
          const capped = Math.min(40, Math.max(3, percent * 0.4))
          progressBar.style.width = `${capped}%`
        }
      }, {
        durationSeconds: videoDuration,
        signal: abortController.signal,
        onPermissionGranted: async () => {
          // Permission granted — start the (hidden) YouTube player so we capture clean audio from t=0.
          // Double-ensure looping is off for this playback (recording must be linear).
          this.isLooping = false
          if (this.player && this.playerReady) {
            try {
              // Force 100% volume (unmuted) right before playback begins for the capture.
              // This guarantees the tab audio we record is at full intended level.
              this.player.unMute?.()
              this.player.setVolume?.(100)

              this.player.seekTo(0, true)
              this.player.setPlaybackRate(1)
              this.playbackRate = 1
              this.player.playVideo()

              // Start a periodic volume watchdog for the entire duration of the recording.
              // YouTube can (and does) re-apply its own volume state mid-playback on music content.
              // We re-force 100% every ~1.2 s so the captured audio is guaranteed full level.
              if (volumeLockInterval) clearInterval(volumeLockInterval)
              volumeLockInterval = window.setInterval(() => {
                try {
                  if (this.player && this.playerReady) {
                    this.player.unMute?.()
                    this.player.setVolume?.(100)
                  }
                } catch {}
              }, 1200)
            } catch {}
            await new Promise(r => setTimeout(r, 450))
          }
          // Reveal the early-stop button now that recording is actually running
          stopBtn.classList.remove('hidden')
        },
      })

      if (cancelled) return

      // Recording is finished (full or early-stop). Clear the video-ended hook.
      this._onVideoEndedDuringCapture = null

      // Recording is finished (full or early-stop). Stop the volume watchdog immediately.
      if (volumeLockInterval) {
        clearInterval(volumeLockInterval)
        volumeLockInterval = null
      }

      // We have the audio buffer. Stop the hidden player immediately.
      this.restorePlaybackStateAfterCapture(originalPlaybackRate)

      // ============================================
      // PHASE 2: Transition the SAME card to AI separation
      // ============================================
      titleEl.textContent = 'Breaking into stems — 6-stem AI separation'
      statusEl.textContent = 'Starting 6-stem AI separation (WebGPU)…'
      progressBar.style.width = '40%'

      // Insert the exact same heavy-workload warning the local audio flow uses
      const warning = document.createElement('div')
      warning.className = 'my-5 rounded-2xl bg-amber-950/40 border border-amber-500/30 px-4 py-3 text-amber-300 text-xs'
      warning.innerHTML = `
        <strong>Heavy workload warning:</strong> This runs a full 6-stem AI model locally using WebGPU.
        It can take many minutes and will make your browser (and sometimes the whole machine) slow or unresponsive until it finishes.
        Best experience is usually in Chrome on a machine with a decent GPU. Safari often times out or is slower.
      `
      // Insert the warning right after the progress bar area
      const barContainer = progressBar.parentElement
      if (barContainer) barContainer.after(warning)

      const { createBestStemEngine } = await import('./stems')
      const engine = await createBestStemEngine()

      if (!engine) {
        area.innerHTML = `
          <div class="bg-zinc-900 border border-white/10 rounded-3xl p-8 text-center">
            <div class="text-rose-400 mb-3">Stem separation requires WebGPU (not available in this browser).</div>
            <div class="text-sm text-zinc-400">Try Chrome or Edge with a GPU-capable device.</div>
            <button id="yt-close-err" class="mt-4 px-5 py-2 rounded-2xl border border-white/10 text-sm">Go back to video</button>
          </div>
        `
        area.querySelector('#yt-close-err')?.addEventListener('click', () => {
          area.remove()
          this.els.playerSection.classList.remove('hidden')
        })
        return
      }

      // Monotonic + simulated progress (exact same pattern as performStemSeparation for local audio)
      let lastRealProgress = 0.40
      let lastRealProgressTime = Date.now()
      let displayedProgress = 0.40
      let isEstimating = false
      let simulatedInterval: number | null = null

      const updateProgress = (progress: number, stage: string, isReal = true) => {
        const now = Date.now()
        const isMeaningfulAdvance = isReal && (progress - lastRealProgress) >= 0.012

        if (isReal) {
          if (isMeaningfulAdvance) {
            lastRealProgress = progress
            lastRealProgressTime = now
          }
          if (isEstimating) {
            if (progress > displayedProgress + 0.03) {
              isEstimating = false
              if (simulatedInterval) {
                clearInterval(simulatedInterval)
                simulatedInterval = null
              }
            } else {
              progressBar.style.width = `${Math.max(40, displayedProgress * 100)}%`
              return
            }
          }
        }

        if (isMeaningfulAdvance && simulatedInterval) {
          clearInterval(simulatedInterval)
          simulatedInterval = null
          isEstimating = false
        }

        const effective = Math.max(progress, displayedProgress)
        displayedProgress = effective
        progressBar.style.width = `${Math.max(40, effective * 100)}%`

        if (isEstimating) {
          statusEl.textContent = `${stage} — ${Math.round(displayedProgress * 100)}% (estimating)`
        } else {
          statusEl.textContent = `${stage} — ${(progress * 100).toFixed(0)}%`
        }
      }

      const startSimulatedProgressRamp = (estimatedSeconds: number) => {
        if (simulatedInterval) clearInterval(simulatedInterval)

        const startP = Math.max(displayedProgress, lastRealProgress, 0.40)
        const targetP = 0.92
        const durationMs = Math.max(estimatedSeconds * 1000, 45_000)
        const stepMs = 2400
        const increment = (targetP - startP) / (durationMs / stepMs)

        let current = startP
        displayedProgress = current

        simulatedInterval = window.setInterval(() => {
          if (Date.now() - lastRealProgressTime > 4500) {
            current = Math.min(targetP, current + increment)
            displayedProgress = Math.max(displayedProgress, current)
            isEstimating = true
            const displayStage = statusEl.textContent?.split(' — ')[0] || 'Running inference'
            progressBar.style.width = `${Math.max(40, displayedProgress * 100)}%`
            statusEl.textContent = `${displayStage} — ${Math.round(displayedProgress * 100)}% (estimating)`
          } else {
            if (simulatedInterval) {
              clearInterval(simulatedInterval)
              simulatedInterval = null
              isEstimating = false
            }
          }
        }, stepMs)
      }

      const stemResult = await engine.separate(result.decoded.buffer, {
        signal: abortController.signal,
        onProgress: (progress: number, stage: string) => {
          if (cancelled) return
          // Separation owns 40% → 95% of the bar
          const total = 0.40 + progress * 0.55
          updateProgress(total, stage, true)

          const now = Date.now()
          const timeSince = now - lastRealProgressTime
          const stuck = progress >= 0.18 && progress < 0.85 && timeSince > 2200
          if (stuck && !simulatedInterval) {
            engine.estimateProcessingTime?.(result.decoded.duration).then(est => {
              if (!simulatedInterval) {
                isEstimating = true
                startSimulatedProgressRamp(est ?? 180)
              }
            }).catch(() => {
              if (!simulatedInterval) {
                isEstimating = true
                startSimulatedProgressRamp(180)
              }
            })
          }
        },
      })

      if (cancelled) return

      if (simulatedInterval) {
        clearInterval(simulatedInterval)
        simulatedInterval = null
      }
      isEstimating = false
      progressBar.style.width = '95%'
      statusEl.textContent = 'Saving stems...'

      // ============================================
      // SUCCESS — save DECOUPLED (no video relationship) and open pure stem UI
      // ============================================
      const tracksForPlayer = stemResult.stems.map(s => ({ name: s.name, buffer: s.audioBuffer }))

      let audioPersistenceSucceeded = true
      let ytSavedSessionId: string | undefined
      try {
        const { saveStemSession } = await import('./stems')
        const savedId = await saveStemSession(
          {
            youtubeVideoId: videoId,
            youtubeVideoTitle: ytTitle,
            fileName: `YouTube — ${ytTitle}`,
            duration: result.decoded.duration,
            stemNames: stemResult.stems.map(s => s.name),
            model: 'demucs-rs htdemucs_6s',
          },
          tracksForPlayer
        )
        ytSavedSessionId = savedId

        // Background upload to Google Drive (non-blocking)
        this.backgroundUploadToCloud(
          {
            id: savedId,
            youtubeVideoId: videoId,
            youtubeVideoTitle: ytTitle,
            fileName: `YouTube — ${ytTitle}`,
            duration: result.decoded.duration,
            stemNames: stemResult.stems.map(s => s.name),
            model: 'demucs-rs htdemucs_6s',
            createdAt: Date.now(),
          },
          tracksForPlayer,
        )
      } catch (e: any) {
        audioPersistenceSucceeded = false
        if (e?.code === 'AUDIO_PERSISTENCE_FAILED') {
          console.error('[weblooper] YouTube stems saved but audio could not be persisted for reload.', e)
        } else {
          console.error('[weblooper] Failed to persist YouTube-derived stem session', e)
        }
      }

      if (!audioPersistenceSucceeded) {
        const notice = document.createElement('div')
        notice.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-amber-900 text-amber-100 text-sm px-5 py-3 rounded-2xl shadow-xl z-[300] border border-amber-500/50 max-w-[620px] text-center'
        notice.innerHTML = `
          Separation succeeded, but the stems could <strong>not</strong> be saved for later loading.<br>
          This is almost always because browser storage quota was exceeded.<br>
          <span class="text-xs opacity-75">You can still use the stems in this session.</span>
        `
        document.body.appendChild(notice)
        setTimeout(() => notice.remove(), 14000)
      }

      // Remove the capture card — we are done with YouTube for this flow
      area.remove()

      // Launch the completely independent stem looper (full timeline, loop handles, mixer, speed, keyboard, etc.)
      // No video, no sync, no attachment — exactly like a local audio stem session.
      this.enterStemPracticeWithRealStems(
        { fileName: `YouTube — ${ytTitle}`, duration: result.decoded.duration },
        tracksForPlayer,
        ytSavedSessionId ? {
          id: ytSavedSessionId,
          fileName: `YouTube — ${ytTitle}`,
          duration: result.decoded.duration,
          stemNames: stemResult.stems.map(s => s.name),
          model: 'demucs-rs htdemucs_6s',
          createdAt: Date.now(),
        } : undefined,
      )

      console.log('[weblooper] YouTube stem separation complete — stems are fully decoupled (no video relationship)')

    } catch (err: any) {
      if (cancelled) return
      cleanupAndRestorePlayer()
      throw err
    }
  }

  /**
   * Start stem separation from a YouTube URL when no video is currently loaded.
   * Loads the video first, then triggers the stem separation flow.
   */
  private async startYouTubeStemSeparation(videoId: string) {
    // First, load the video so the YouTube player is active
    // (tab audio capture needs the player to be playing)
    this.els.loaderSection.classList.add('hidden')
    this.els.playerSection.classList.remove('hidden')
    this.loadVideoFromUrl(videoId)

    // Wait for player to be ready
    await new Promise<void>((resolve) => {
      const checkReady = setInterval(() => {
        if (this.playerReady && this.player) {
          clearInterval(checkReady)
          resolve()
        }
      }, 200)
      // Timeout after 10 seconds
      setTimeout(() => { clearInterval(checkReady); resolve() }, 10000)
    })

    // Now use the same flow as "video already playing" path
    await this.startYouTubeStemSeparationForCurrentVideo(videoId)
  }

  /**
   * Previously required a page reload to enable cross-origin isolation (COOP/COEP headers)
   * for SharedArrayBuffer. This is NO LONGER NEEDED because demucs-rs uses WebGPU compute
   * shaders (single-threaded WASM), not SharedArrayBuffer/threads.
   * Kept as a no-op stub in case external code references it.
   */
  // @ts-ignore - Retained for documentation purposes; the reload-based isolation is eliminated.
  private async ensureCrossOriginIsolation(): Promise<void> {
    return
  }

  private async performStemSeparation(
    decoded: { buffer: AudioBuffer; fileName: string; duration: number }
  ) {
    // demucs-rs uses WebGPU compute shaders (single-threaded WASM).
    // No cross-origin isolation needed — works alongside YouTube iframes.

    // Always hide the original loader card (the one with the action buttons)
    // This prevents the "card stays on top" problem and makes re-entrancy safer.
    this.els.loaderSection.classList.add('hidden')

    // Remove any previous separation progress UI so we don't pile multiple cards
    document.querySelectorAll('#stem-separation-progress').forEach(el => el.remove())

    const area = document.createElement('div')
    area.id = 'stem-separation-progress'
    area.className = 'max-w-[720px] mx-auto'
    this.els.playerSection.parentElement!.appendChild(area)

    const engine = await import('./stems').then(m => m.createBestStemEngine())

    if (!engine) {
      area.innerHTML = `
        <div class="bg-zinc-900 border border-white/10 rounded-3xl p-8 text-center">
          <div class="text-rose-400 mb-4">Stem separation is not supported in this browser yet.</div>
          <button class="px-6 py-2 rounded-2xl border border-white/10" id="close-sep">Go back</button>
        </div>
      `
      area.querySelector('#close-sep')?.addEventListener('click', () => {
        area.remove()
        this.els.loaderSection.classList.remove('hidden')
        this.reEnableSeparateStemsButton()
      })
      return
    }

    area.innerHTML = `
      <div class="bg-zinc-900 border border-white/10 rounded-3xl p-8">
        <div class="text-emerald-400 text-xs tracking-[2px] mb-1">BROWSER-POWERED AI SEPARATION</div>
        <div class="text-2xl font-semibold tracking-tight mb-6">${decoded.fileName}</div>

        <div class="mb-3 rounded-2xl bg-amber-950/40 border border-amber-500/30 px-4 py-3 text-amber-300 text-xs">
          <strong>Heavy workload warning:</strong> This runs a full 6-stem AI model locally using WebGPU.
          It can take many minutes and will make your browser (and sometimes the whole machine) slow or unresponsive until it finishes.
          Best experience is usually in Chrome on a machine with a decent GPU. Safari often times out or is slower.
        </div>

        <div id="sep-progress-container">
          <div class="h-2 bg-zinc-800 rounded-full overflow-hidden mb-3">
            <div id="sep-progress-bar" class="h-2 bg-emerald-500 w-0 transition-all"></div>
          </div>
          <div id="sep-status" class="text-sm text-zinc-400">Preparing 6-stem separation (guitar + piano) — demucs-rs only</div>
        </div>

        <div class="mt-6 text-sm">
          <div class="text-emerald-400 font-medium mb-1">Target stems (htdemucs_6s via demucs-rs):</div>
          <div class="text-zinc-400">Drums • Bass • Guitar • Piano • Vocals • Other</div>
        </div>

        <div class="mt-6 text-xs text-zinc-500">
          First run downloads ~84 MB model. Everything runs locally in your browser.
        </div>

        <button id="cancel-sep" class="mt-6 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
      </div>
    `

    const progressBar = area.querySelector('#sep-progress-bar') as HTMLElement
    const statusEl = area.querySelector('#sep-status') as HTMLElement
    const cancelBtn = area.querySelector('#cancel-sep') as HTMLButtonElement

    let cancelled = false
    const abortController = new AbortController()

    // Shared across startSeparation / retry / cancel / error paths
    let simulatedInterval: number | null = null

    const startSeparation = async () => {
      try {
        // Track real progress so we can do "simulated slow advance" during long inference
        // when the underlying WASM model doesn't report fine-grained progress.
        let lastRealProgress = 0
        let lastRealProgressTime = Date.now()
        let displayedProgress = 0   // Never let the bar go backwards
        let isEstimating = false

        const updateProgress = (progress: number, stage: string, isReal = true) => {
          const now = Date.now()
          const isMeaningfulAdvance = isReal && (progress - lastRealProgress) >= 0.012

          if (isReal) {
            if (isMeaningfulAdvance) {
              lastRealProgress = progress
              lastRealProgressTime = now
            }

            // If we are in estimation mode, only accept a real update if it is
            // meaningfully ahead of what we're displaying. This prevents the
            // constant 22% heartbeats from snapping the bar backwards.
            if (isEstimating) {
              if (progress > displayedProgress + 0.03) {
                // Real progress jumped — stop estimating and trust it
                isEstimating = false
                if (simulatedInterval) {
                  clearInterval(simulatedInterval)
                  simulatedInterval = null
                }
                displayedProgress = progress
              } else {
                // Low-value update while estimating → ignore for the bar
                progressBar.style.width = `${Math.max(5, displayedProgress * 100)}%`
                return
              }
            }
          }

          if (isMeaningfulAdvance && simulatedInterval) {
            clearInterval(simulatedInterval)
            simulatedInterval = null
            isEstimating = false
          }

          const effectiveProgress = Math.max(progress, displayedProgress)
          displayedProgress = effectiveProgress

          progressBar.style.width = `${Math.max(5, effectiveProgress * 100)}%`

          // During estimation we want the UI to show the estimated value,
          // not the raw stuck model value.
          if (isEstimating) {
            statusEl.textContent = `${stage} — ${Math.round(displayedProgress * 100)}% (estimating)`
          } else {
            statusEl.textContent = `${stage} — ${(progress * 100).toFixed(0)}%`
          }
        }

        const startSimulatedProgressRamp = (estimatedSeconds: number) => {
          // During the heavy inference phase the demucs-rs WASM often stops sending
          // useful progress callbacks. We gently advance the bar so it doesn't look stuck.
          if (simulatedInterval) clearInterval(simulatedInterval)

          const startP = Math.max(displayedProgress, lastRealProgress, 0.22)
          const targetP = 0.92
          const durationMs = Math.max(estimatedSeconds * 1000, 45_000)
          const stepMs = 2400
          const increment = (targetP - startP) / (durationMs / stepMs)

          let current = startP
          displayedProgress = current   // seed it

          simulatedInterval = window.setInterval(() => {
            if (Date.now() - lastRealProgressTime > 4500) {
              current = Math.min(targetP, current + increment)
              displayedProgress = Math.max(displayedProgress, current)
              isEstimating = true

              const displayStage = statusEl.textContent?.split(' — ')[0] || 'Running inference'
              progressBar.style.width = `${Math.max(5, displayedProgress * 100)}%`
              statusEl.textContent = `${displayStage} — ${Math.round(displayedProgress * 100)}% (estimating)`
            } else {
              if (simulatedInterval) {
                clearInterval(simulatedInterval)
                simulatedInterval = null
                isEstimating = false
              }
            }
          }, stepMs)
        }

        const result = await engine.separate(decoded.buffer, {
          signal: abortController.signal,
          onProgress: (progress: number, stage: string) => {
            updateProgress(progress, stage, true)

            const now = Date.now()
            // Start the simulated ramp once we're in the long inference phase
            // and we haven't seen a meaningful advance recently.
            const timeSinceLastAdvance = now - lastRealProgressTime
            const inStuckInference = progress >= 0.18 && progress < 0.85 && timeSinceLastAdvance > 2200

            if (inStuckInference && !simulatedInterval) {
              engine.estimateProcessingTime?.(decoded.duration).then(est => {
                if (!simulatedInterval) {
                  isEstimating = true
                  startSimulatedProgressRamp(est ?? 180)
                }
              }).catch(() => {
                if (!simulatedInterval) {
                  isEstimating = true
                  startSimulatedProgressRamp(180)
                }
              })
            }
          },
        })

        if (cancelled) return

        if (simulatedInterval) {
          clearInterval(simulatedInterval)
          simulatedInterval = null
        }
        isEstimating = false
        area.remove()
        const tracksForPlayer = result.stems.map(s => ({ name: s.name, buffer: s.audioBuffer }))

        // Persist so user can come back to this separation later without re-running the model
        let audioPersistenceSucceeded = true
        let localSavedSessionId: string | undefined
        try {
          const { saveStemSession } = await import('./stems')
          const savedId = await saveStemSession(
            {
              fileName: decoded.fileName,
              duration: decoded.duration,
              stemNames: result.stems.map(s => s.name),
              model: 'demucs-rs htdemucs_6s',
            },
            tracksForPlayer
          )
          localSavedSessionId = savedId
          console.log('[weblooper] Stem session fully persisted (metadata + OPFS audio)', savedId)

          // Background upload to Google Drive (non-blocking)
          this.backgroundUploadToCloud(
            {
              id: savedId,
              fileName: decoded.fileName,
              duration: decoded.duration,
              stemNames: result.stems.map(s => s.name),
              model: 'demucs-rs htdemucs_6s',
              createdAt: Date.now(),
            },
            tracksForPlayer,
          )
        } catch (e: any) {
          audioPersistenceSucceeded = false
          if (e?.code === 'AUDIO_PERSISTENCE_FAILED') {
            console.error('[weblooper] Stem separation succeeded but audio could not be saved for future loading.', e)
          } else {
            console.error('[weblooper] Failed to persist stem session', e)
          }
        }

        if (!audioPersistenceSucceeded) {
          const notice = document.createElement('div')
          notice.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-amber-900 text-amber-100 text-sm px-5 py-3 rounded-2xl shadow-xl z-[300] border border-amber-500/50 max-w-[620px] text-center'
          notice.innerHTML = `
            Separation succeeded, but the stems could <strong>not</strong> be saved for later loading.<br>
            This is almost always because browser storage quota was exceeded (6 full stems = several hundred MB of raw audio).<br>
            <span class="text-xs opacity-75">You can still use the stems in this session. See console for details.</span>
          `
          document.body.appendChild(notice)
          setTimeout(() => notice.remove(), 16000)
        }

        this.enterStemPracticeWithRealStems(decoded, tracksForPlayer, localSavedSessionId ? {
          id: localSavedSessionId,
          fileName: decoded.fileName,
          duration: decoded.duration,
          stemNames: result.stems.map(s => s.name),
          model: 'demucs-rs htdemucs_6s',
          createdAt: Date.now(),
        } : undefined)
      } catch (err: any) {
        if (simulatedInterval) {
          clearInterval(simulatedInterval)
          simulatedInterval = null
        }
        if (!cancelled) {
          console.error('[weblooper] 6-stem separation failed', err)
          const msg = err.message || 'Unknown error'

          statusEl.innerHTML = `
            <div class="text-rose-400 font-medium">6-stem separation failed</div>
            <div class="text-xs mt-2 text-zinc-400 whitespace-pre-wrap max-h-48 overflow-auto p-2 bg-black/40 rounded-lg border border-white/10">${msg}</div>

            <div class="flex gap-3 mt-4">
              <button id="retry-sep" 
                      class="flex-1 py-2 rounded-2xl bg-emerald-500 text-emerald-950 font-semibold">
                Retry
              </button>
              <button id="close-error" 
                      class="px-4 py-2 rounded-2xl border border-white/10">
                Cancel
              </button>
            </div>
          `

          progressBar.style.backgroundColor = '#f87171'

          const retryBtn = statusEl.querySelector('#retry-sep') as HTMLButtonElement
          const closeBtn = statusEl.querySelector('#close-error') as HTMLButtonElement

          closeBtn.addEventListener('click', () => {
            area.remove()
            this.els.loaderSection.classList.remove('hidden')
            this.reEnableSeparateStemsButton()
          })

          retryBtn.addEventListener('click', () => {
            if (simulatedInterval) {
              clearInterval(simulatedInterval)
              simulatedInterval = null
            }
            statusEl.innerHTML = `<div class="text-sm text-zinc-400">Retrying...</div>`
            progressBar.style.backgroundColor = '#10b981'
            progressBar.style.width = '5%'
            startSeparation()
          })
        }
      }
    }

    cancelBtn.addEventListener('click', () => {
      cancelled = true
      abortController.abort()
      if (simulatedInterval) {
        clearInterval(simulatedInterval)
        simulatedInterval = null
      }
      area.remove()
      this.els.loaderSection.classList.remove('hidden')
      this.reEnableSeparateStemsButton()
    })

    // Start separation
    startSeparation()
  }

  /**
   * Enter stem practice mode with *real* separated stems from the AI model.
   */
  private async enterStemPracticeWithRealStems(
    decoded: { fileName: string; duration: number },
    realStems: Array<{ name: string; buffer: AudioBuffer }>,
    sessionMeta?: import('./stems/persistence').StemSessionMeta,
  ) {
    const stemArea = document.createElement('div')
    stemArea.id = 'stem-practice-area'
    stemArea.className = 'max-w-[1100px] mx-auto'
    this.els.playerSection.parentElement!.appendChild(stemArea)

    const stemTracks = realStems.map(s => ({ name: s.name, buffer: s.buffer }))

    const { StemPlayer } = await import('./stems')
    const stemPlayer = new StemPlayer()
    stemPlayer.loadStems(stemTracks)

    // ---------- Persistence ----------
    // Key for saving loop state + presets for this specific stem session
    // Simple hash to create a safe localStorage key from any filename (including Unicode)
    let hash = 0
    for (let i = 0; i < decoded.fileName.length; i++) {
      hash = ((hash << 5) - hash + decoded.fileName.charCodeAt(i)) | 0
    }
    const storageKey = 'weblooper_stem_state_' + Math.abs(hash).toString(36)

    interface StemLoopState {
      start: number
      end: number
      isLooping: boolean
      playbackRate: number
      pitchSemitones?: number
      presets: LoopPreset[]
    }

    function loadStemState(): StemLoopState | null {
      try {
        const raw = localStorage.getItem(storageKey)
        return raw ? JSON.parse(raw) : null
      } catch { return null }
    }

    function saveStemState(state: StemLoopState) {
      try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch {}
    }

    // Restore saved state or defaults
    const savedState = loadStemState()
    let loopStart = savedState?.start ?? 0
    let loopEnd = savedState?.end ?? decoded.duration
    let isLooping = savedState?.isLooping ?? false
    let currentRate = savedState?.playbackRate ?? 1
    let currentPitch = savedState?.pitchSemitones ?? 0

    // Seed presets from central session meta if available (enables cross-device sync via Drive)
    // Fall back to (or merge with) the per-stem local practice state.
    let presets: LoopPreset[] = []
    if (sessionMeta?.presets && sessionMeta.presets.length > 0) {
      presets = [...sessionMeta.presets]
    } else if (savedState?.presets) {
      presets = [...savedState.presets]
    }

    stemPlayer.setLoop(loopStart, loopEnd)
    stemPlayer.setIsLooping(isLooping)
    await stemPlayer.setPlaybackRate(currentRate)
    if (currentPitch !== 0) {
      await stemPlayer.setPitch(currentPitch)
    }

    function persistStemState() {
      saveStemState({ start: loopStart, end: loopEnd, isLooping, playbackRate: currentRate, pitchSemitones: currentPitch, presets })
    }

    // ---------- UI ----------
    stemArea.innerHTML = `
      <div class="mb-3 flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-emerald-400 text-xs tracking-[1.5px] font-semibold">STEM PRACTICE</div>
          <div class="text-2xl font-semibold tracking-tight truncate">${decoded.fileName}</div>
          <div class="flex items-center gap-2 text-sm text-zinc-500 mt-0.5">
            <span class="tabular-nums">${formatTime(decoded.duration)}</span>
            <span>•</span>
            <span>${realStems.length} stems</span>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 mt-1">
          <button id="stem-sync-drive-btn"
                  class="hidden text-sm flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 active:bg-blue-500/30 transition"
                  title="Upload this session to Google Drive">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span id="stem-sync-drive-label">Sync to Drive</span>
          </button>

          <button id="exit-stem-real"
                  class="text-sm flex items-center gap-2 px-4 py-2 rounded-2xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 active:bg-zinc-950 transition">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            <span>Back</span>
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-6">
        <!-- Left: Mixer + Timeline -->
        <div>
          <!-- Stem Mixer -->
          <div id="real-mixer-container" class="mb-4"></div>

          <!-- Lyrics + Chords Panel (real implementation starting point) -->
          <div id="real-lyrics-panel" class="mb-4"></div>

          <!-- Timeline with draggable loop handles -->
          <div id="stem-timeline-real" class="timeline w-full"></div>
          <div id="stem-timeline-labels" class="timeline-time-labels">
            <div id="stem-timeline-start-label">0:00</div>
            <div id="stem-time-current-real" class="font-medium text-emerald-400">0:00</div>
            <div id="stem-timeline-end-label">${formatTime(decoded.duration)}</div>
          </div>

          <div class="flex items-center justify-between mt-3 text-sm">
            <div class="flex gap-2">
              <button id="stem-set-start-real" class="nudge-btn flex items-center gap-1.5 px-3 py-1.5 text-emerald-400 hover:text-emerald-300">
                <span class="font-semibold">SET START</span>
                <span class="text-[10px] opacity-60">( [ )</span>
              </button>
              <button id="stem-set-end-real" class="nudge-btn flex items-center gap-1.5 px-3 py-1.5 text-rose-400 hover:text-rose-300">
                <span class="font-semibold">SET END</span>
                <span class="text-[10px] opacity-60">( ] )</span>
              </button>
            </div>
            <div class="text-xs text-zinc-500">Click timeline to seek • Drag handles to adjust loop</div>
          </div>
        </div>

        <!-- Right: Controls Sidebar (mirrors video view) -->
        <div class="space-y-4">
          <div class="bg-zinc-900 border border-white/10 rounded-3xl p-5">
            <div class="flex items-center justify-between mb-4">
              <div class="uppercase tracking-[1.5px] text-xs font-semibold text-emerald-400">Loop Region</div>
              <button id="stem-loop-toggle-real"
                      class="px-5 py-1 text-xs font-bold rounded-full border transition active:scale-95 bg-emerald-500/10 border-emerald-500/40 text-emerald-400">
                LOOP OFF
              </button>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="text-[10px] font-medium text-emerald-400 mb-1.5 tracking-widest">START</div>
                <div class="flex items-center gap-2">
                  <input id="stem-start-input" type="text" class="time-input" value="${formatTime(loopStart)}" />
                  <button id="stem-nudge-start-minus" class="nudge-btn px-2 py-1 text-xs">-0.5</button>
                  <button id="stem-nudge-start-plus" class="nudge-btn px-2 py-1 text-xs">+0.5</button>
                </div>
              </div>
              <div>
                <div class="text-[10px] font-medium text-rose-400 mb-1.5 tracking-widest">END</div>
                <div class="flex items-center gap-2">
                  <input id="stem-end-input" type="text" class="time-input" value="${formatTime(loopEnd)}" />
                  <button id="stem-nudge-end-minus" class="nudge-btn px-2 py-1 text-xs">-0.5</button>
                  <button id="stem-nudge-end-plus" class="nudge-btn px-2 py-1 text-xs">+0.5</button>
                </div>
              </div>
            </div>

            <div class="mt-5 mb-1 text-center">
              <div class="text-[10px] tracking-[2px] text-zinc-500">CURRENT TIME</div>
              <div id="stem-current-time" class="font-mono text-5xl font-semibold tabular-nums tracking-tighter text-white mt-1">0:00</div>
            </div>

            <div class="grid grid-cols-2 gap-2 mt-2">
              <button id="stem-play-real" class="col-span-1 py-3 rounded-2xl bg-white text-zinc-950 font-semibold active:scale-[0.985] flex items-center justify-center gap-2">
                <span id="stem-play-label">PLAY</span>
              </button>
              <button id="stem-restart-real" class="py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 font-semibold flex items-center justify-center gap-2 border border-white/10">
                <span>↺</span><span>Restart Loop</span>
              </button>
            </div>

            <button id="stem-full-track-real" class="mt-2 w-full py-2 text-xs rounded-2xl bg-zinc-950 hover:bg-zinc-800 border border-white/10 text-zinc-400 hover:text-zinc-200 transition flex items-center justify-center gap-2">
              <span>Use full track (no loop)</span>
            </button>

            <div class="mt-5">
              <div class="flex items-baseline justify-between mb-2 px-0.5">
                <div class="text-xs font-medium tracking-widest text-zinc-400">SPEED</div>
                <div class="flex items-center gap-1.5">
                  <button id="stem-speed-dec-real" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">−</button>
                  <div id="stem-speed-real" class="font-mono text-sm text-emerald-400 min-w-[3.2rem] text-center">${currentRate.toFixed(2)}×</div>
                  <button id="stem-speed-inc-real" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">+</button>
                </div>
              </div>
              <div id="stem-speed-real-chips" class="flex flex-wrap gap-1.5"></div>
            </div>

            <!-- Key / Pitch Shift -->
            <div class="mt-4">
              <div class="flex items-baseline justify-between mb-2 px-0.5">
                <div class="text-xs font-medium tracking-widest text-zinc-400">KEY</div>
                <div class="flex items-center gap-1.5">
                  <button id="stem-pitch-dec-real" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">−</button>
                  <div id="stem-pitch-real" class="font-mono text-sm text-emerald-400 min-w-[3.2rem] text-center">0</div>
                  <button id="stem-pitch-inc-real" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">+</button>
                </div>
              </div>
              <div class="text-[10px] text-zinc-500 px-0.5">Semitones (±12 = 1 octave)</div>
            </div>
          </div>

          <div class="bg-zinc-900 border border-white/10 rounded-3xl p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="text-xs font-semibold tracking-widest text-zinc-400">SAVED LOOPS</div>
              <button id="stem-save-preset-btn" class="text-[11px] px-3 py-1 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-medium flex items-center gap-1 transition">
                <span>+</span><span>Save current</span>
              </button>
            </div>
            <div id="stem-presets-list" class="space-y-1.5 max-h-[168px] overflow-auto pr-1 text-sm"></div>
            <div id="stem-no-presets-hint" class="text-center text-xs text-zinc-500 py-2 italic hidden">No saved sections yet.<br>Save loops for fast switching.</div>
          </div>
        </div>
      </div>
    `

    // ---------- Element refs ----------
    const timeline = document.getElementById('stem-timeline-real')!
    const timeEl = document.getElementById('stem-time-current-real')!
    const currentTimeDisplay = document.getElementById('stem-current-time')!
    const playBtn = document.getElementById('stem-play-real')!
    const playLabel = document.getElementById('stem-play-label')!
    const restartBtn = document.getElementById('stem-restart-real')!
    const loopToggleBtn = document.getElementById('stem-loop-toggle-real')!
    const setStartBtn = document.getElementById('stem-set-start-real')!
    const setEndBtn = document.getElementById('stem-set-end-real')!
    const fullTrackBtn = document.getElementById('stem-full-track-real')!
    const startInput = document.getElementById('stem-start-input') as HTMLInputElement
    const endInput = document.getElementById('stem-end-input') as HTMLInputElement
    const timelineStartLabel = document.getElementById('stem-timeline-start-label')!
    const presetsListEl = document.getElementById('stem-presets-list')!
    const noPresetsHint = document.getElementById('stem-no-presets-hint')!
    const savePresetBtn = document.getElementById('stem-save-preset-btn')!

    // Pitch elements (hoisted early to avoid TDZ when updatePitchUI is called in initial state)
    const pitchLabel = document.getElementById('stem-pitch-real')!
    const pitchDecBtn = document.getElementById('stem-pitch-dec-real')!
    const pitchIncBtn = document.getElementById('stem-pitch-inc-real')!

    function updatePitchUI() {
      pitchLabel.textContent = currentPitch > 0 ? `+${currentPitch}` : String(currentPitch)
      persistStemState()
    }

    // Build timeline with handles
    timeline.innerHTML = `
      <div class="timeline-track"></div>
      <div class="timeline-loop" id="real-loop-region"></div>
      <div class="timeline-playhead" id="real-playhead"></div>
      <div class="timeline-handle start" id="real-handle-start" title="Drag to set loop start"></div>
      <div class="timeline-handle end" id="real-handle-end" title="Drag to set loop end"></div>
    `

    // ---------- Loop UI ----------
    function updateLoopUI() {
      if (isLooping) {
        loopToggleBtn.textContent = 'LOOP ON'
        loopToggleBtn.className = 'px-5 py-1 text-xs font-bold rounded-full border transition active:scale-95 bg-emerald-500 text-emerald-950 border-emerald-400'
      } else {
        loopToggleBtn.textContent = 'LOOP OFF'
        loopToggleBtn.className = 'px-5 py-1 text-xs font-bold rounded-full border transition active:scale-95 bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
      }

      const region = document.getElementById('real-loop-region') as HTMLElement
      const hStart = document.getElementById('real-handle-start') as HTMLElement
      const hEnd = document.getElementById('real-handle-end') as HTMLElement

      if (region && hStart && hEnd) {
        const pct = (t: number) => Math.max(0, Math.min(100, (t / decoded.duration) * 100))
        const left = pct(loopStart)
        const width = Math.max(pct(loopEnd) - left, 0.6)

        region.style.left = `${left}%`
        region.style.width = `${width}%`
        hStart.style.left = `${left}%`
        hEnd.style.left = `${pct(loopEnd)}%`
      }

      startInput.value = formatTime(loopStart)
      endInput.value = formatTime(loopEnd)
      timelineStartLabel.textContent = formatTime(loopStart)

      // Update restart button label based on loop state
      const rLabel = restartBtn.querySelector('span:last-child')
      if (rLabel) {
        rLabel.textContent = isLooping ? 'Restart Loop' : 'Restart'
      }
    }

    function applyLoopToPlayer() {
      stemPlayer.setLoop(loopStart, loopEnd)
      stemPlayer.setIsLooping(isLooping)
      updateLoopUI()
      persistStemState()
    }

    // ---------- Presets ----------
    function renderStemPresets() {
      presetsListEl.innerHTML = ''

      if (presets.length === 0) {
        noPresetsHint.classList.remove('hidden')
        return
      }
      noPresetsHint.classList.add('hidden')

      presets.forEach((preset, index) => {
        const isActive = Math.abs(preset.start - loopStart) < 0.3 && Math.abs(preset.end - loopEnd) < 0.3
        const el = document.createElement('div')
        el.className = `preset-item ${isActive ? 'active' : ''}`
        el.innerHTML = `
          <div class="flex-1 min-w-0">
            <div class="preset-name">${preset.name}</div>
            <div class="preset-time">${formatTime(preset.start)} — ${formatTime(preset.end)}</div>
          </div>
          <div class="preset-actions">
            <button data-action="load" class="px-2 py-1 text-emerald-400 hover:text-emerald-300" title="Load this loop">→</button>
            <button data-action="delete" class="px-1.5 py-1 text-rose-400/70 hover:text-rose-400" title="Delete">×</button>
          </div>
        `

        el.addEventListener('click', (ev) => {
          if ((ev.target as HTMLElement).closest('button')) return
          loadStemPreset(preset)
        })

        el.querySelector('[data-action="load"]')?.addEventListener('click', (e) => {
          e.stopPropagation()
          loadStemPreset(preset)
        })

        el.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
          e.stopPropagation()
          if (confirm(`Delete "${preset.name}"?`)) {
            presets.splice(index, 1)
            renderStemPresets()
            persistStemState()
          }
        })

        presetsListEl.appendChild(el)
      })
    }

    function loadStemPreset(preset: LoopPreset) {
      loopStart = preset.start
      loopEnd = preset.end
      applyLoopToPlayer()
      stemPlayer.seek(loopStart)
      if (isLooping) {
        stemPlayer.play()
      }
      renderStemPresets()
    }

    function saveStemPreset() {
      const defaultName = `Loop ${formatTime(loopStart)}–${formatTime(loopEnd)}`
      const name = prompt('Name this loop section:', defaultName)
      if (!name) return

      const newPreset: LoopPreset = {
        id: generateId(),
        name: name.trim(),
        start: loopStart,
        end: loopEnd,
      }

      // Deduplicate (same range ±0.2s)
      presets = presets.filter(p =>
        !(Math.abs(p.start - newPreset.start) < 0.2 && Math.abs(p.end - newPreset.end) < 0.2)
      )
      presets.unshift(newPreset)
      renderStemPresets()
      persistStemState()

      // Also persist to central StemSessionMeta so presets travel with cloud sync
      if (sessionMeta?.id) {
        import('./stems').then(({ updateStemSessionPresets }) => {
          updateStemSessionPresets(sessionMeta.id, presets)

          import('./drive').then(({ isSignedIn, isSessionInCloud, updateCloudStemMeta }) => {
            if (isSignedIn() && isSessionInCloud(sessionMeta.id)) {
              updateCloudStemMeta(sessionMeta.id, { presets }).catch(() => {})
            }
          }).catch(() => {})
        }).catch((e) => {
          console.warn('[stems] Failed to sync preset to central meta / cloud', e)
        })
      }
    }

    // ---------- Initial UI state ----------
    updateLoopUI()
    renderStemPresets()
    updatePitchUI()

    // Ensure practice local state (including any cloud-seeded presets) is persisted
    persistStemState()

    // ---------- Timeline interaction ----------
    timeline.addEventListener('click', (e) => {
      const rect = timeline.getBoundingClientRect()
      let pct = (e.clientX - rect.left) / rect.width
      pct = Math.max(0, Math.min(1, pct))
      let seekTo = pct * decoded.duration
      if (isLooping) {
        seekTo = Math.max(loopStart, Math.min(seekTo, loopEnd))
      }
      stemPlayer.seek(seekTo)
    })

    // Draggable loop handles
    let dragging: 'start' | 'end' | null = null

    const onPointerMove = (ev: PointerEvent) => {
      if (!dragging) return
      const rect = timeline.getBoundingClientRect()
      let pct = (ev.clientX - rect.left) / rect.width
      pct = Math.max(0, Math.min(1, pct))
      const seconds = pct * decoded.duration

      if (dragging === 'start') {
        const newStart = Math.min(seconds, loopEnd - 0.2)
        if (Math.abs(newStart - loopStart) > 0.02) {
          loopStart = Math.max(0, newStart)
          applyLoopToPlayer()
        }
      } else {
        const newEnd = Math.max(seconds, loopStart + 0.2)
        if (Math.abs(newEnd - loopEnd) > 0.02) {
          loopEnd = Math.min(decoded.duration, newEnd)
          applyLoopToPlayer()
        }
      }
    }

    const onPointerUp = () => {
      if (dragging) {
        dragging = null
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', onPointerUp)
        document.body.style.cursor = ''
      }
    }

    const startHandle = document.getElementById('real-handle-start')!
    const endHandle = document.getElementById('real-handle-end')!

    startHandle.addEventListener('pointerdown', (ev) => {
      dragging = 'start'
      document.body.style.cursor = 'ew-resize'
      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp, { once: true })
      ev.preventDefault()
    })
    endHandle.addEventListener('pointerdown', (ev) => {
      dragging = 'end'
      document.body.style.cursor = 'ew-resize'
      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp, { once: true })
      ev.preventDefault()
    })

    // ---------- Transport ----------
    playBtn.addEventListener('click', () => stemPlayer.togglePlayPause())
    restartBtn.addEventListener('click', () => {
      stemPlayer.restart()
    })

    loopToggleBtn.addEventListener('click', () => {
      isLooping = !isLooping
      applyLoopToPlayer()
    })

    setStartBtn.addEventListener('click', () => {
      const cur = (window as any).__currentStemTime || loopStart
      loopStart = Math.max(0, Math.min(cur, loopEnd - 0.2))
      applyLoopToPlayer()
    })

    setEndBtn.addEventListener('click', () => {
      const cur = (window as any).__currentStemTime || loopEnd
      loopEnd = Math.min(decoded.duration, Math.max(cur, loopStart + 0.2))
      applyLoopToPlayer()
    })

    fullTrackBtn.addEventListener('click', () => {
      loopStart = 0
      loopEnd = decoded.duration
      isLooping = false
      applyLoopToPlayer()
      stemPlayer.seek(0)
    })

    // Nudge buttons
    document.getElementById('stem-nudge-start-minus')!.addEventListener('click', () => {
      loopStart = Math.max(0, loopStart - 0.5)
      applyLoopToPlayer()
    })
    document.getElementById('stem-nudge-start-plus')!.addEventListener('click', () => {
      loopStart = Math.min(loopEnd - 0.2, loopStart + 0.5)
      applyLoopToPlayer()
    })
    document.getElementById('stem-nudge-end-minus')!.addEventListener('click', () => {
      loopEnd = Math.max(loopStart + 0.2, loopEnd - 0.5)
      applyLoopToPlayer()
    })
    document.getElementById('stem-nudge-end-plus')!.addEventListener('click', () => {
      loopEnd = Math.min(decoded.duration, loopEnd + 0.5)
      applyLoopToPlayer()
    })

    // Time inputs (manual entry)
    startInput.addEventListener('change', () => {
      const val = parseTime(startInput.value)
      loopStart = clamp(val, 0, loopEnd - 0.1)
      applyLoopToPlayer()
    })
    endInput.addEventListener('change', () => {
      const val = parseTime(endInput.value)
      loopEnd = clamp(val, loopStart + 0.1, decoded.duration)
      applyLoopToPlayer()
    })

    // Save preset
    savePresetBtn.addEventListener('click', () => saveStemPreset())

    // ---------- Speed ----------
    const speedChips = document.getElementById('stem-speed-real-chips')!
    const speedLabel = document.getElementById('stem-speed-real')!

    function updateSpeed() {
      currentRate = stemPlayer.getCurrentPlaybackRate()
      speedLabel.textContent = currentRate.toFixed(2) + '×'
      speedChips.querySelectorAll('button').forEach(btn => {
        const v = parseFloat(btn.textContent!.replace('×', ''))
        btn.classList.toggle('active', Math.abs(v - currentRate) < 0.01)
      })
      persistStemState()
    }

    ;[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].forEach(s => {
      const b = document.createElement('button')
      b.className = `speed-chip ${Math.abs(s - currentRate) < 0.01 ? 'active' : ''}`
      b.textContent = s + '×'
      b.onclick = () => { stemPlayer.setPlaybackRate(s); updateSpeed() }
      speedChips.appendChild(b)
    })

    // Fine speed control (±0.05)
    const speedDecBtn = document.getElementById('stem-speed-dec-real')!
    const speedIncBtn = document.getElementById('stem-speed-inc-real')!
    speedDecBtn.onclick = () => {
      const next = Math.max(0.25, Math.round((stemPlayer.getCurrentPlaybackRate() - 0.05) * 100) / 100)
      stemPlayer.setPlaybackRate(next); updateSpeed()
    }
    speedIncBtn.onclick = () => {
      const next = Math.min(2.0, Math.round((stemPlayer.getCurrentPlaybackRate() + 0.05) * 100) / 100)
      stemPlayer.setPlaybackRate(next); updateSpeed()
    }

    // Wire pitch buttons (elements were already gotten earlier)
    pitchDecBtn.onclick = async () => {
      currentPitch = Math.max(-12, currentPitch - 1)
      await stemPlayer.setPitch(currentPitch)
      updatePitchUI()
    }

    pitchIncBtn.onclick = async () => {
      currentPitch = Math.min(12, currentPitch + 1)
      await stemPlayer.setPitch(currentPitch)
      updatePitchUI()
    }

    // ---------- Mixer ----------
    const mixerC = document.getElementById('real-mixer-container')!
    const { createStemMixerUI } = await import('./stems')
    createStemMixerUI({ container: mixerC, player: stemPlayer })

    // ---------- Real Lyrics + Chords Panel (Phase 0 integration) ----------
    const lyricsContainer = document.getElementById('real-lyrics-panel')!
    const { LyricPanel } = await import('./lyrics')

    let lyricPanel: InstanceType<typeof LyricPanel> | null = null

    // Simple styled dialog helpers matching the app's dark zinc theme
    function createDialogOverlay() {
      const overlay = document.createElement('div')
      overlay.className = 'fixed inset-0 bg-black/70 backdrop-blur z-[400] flex items-center justify-center p-6'
      return overlay
    }

    function showInfoDialog(title: string, htmlContent: string): Promise<void> {
      return new Promise((resolve) => {
        const overlay = createDialogOverlay()
        overlay.innerHTML = `
          <div class="bg-zinc-900 border border-white/10 rounded-3xl p-6 max-w-md w-full">
            <div class="text-lg font-semibold text-emerald-400 mb-3">${title}</div>
            <div class="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">${htmlContent}</div>
            <div class="mt-5 flex justify-end">
              <button class="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium">OK</button>
            </div>
          </div>
        `
        const btn = overlay.querySelector('button')!
        const close = () => { overlay.remove(); resolve() }
        btn.onclick = close
        overlay.onclick = (e) => { if (e.target === overlay) close() }
        document.body.appendChild(overlay)
      })
    }

    const loadColabResults = async () => {
      if (!lyricPanel || !sessionMeta?.id) return;
      try {
        const { loadLyricTrackFromCloud } = await import('./drive/sync');
        const track = await loadLyricTrackFromCloud(sessionMeta.id);
        if (track) {
          const { updateStemSessionLyricTrack } = await import('./stems');
          updateStemSessionLyricTrack(sessionMeta.id, track);
          const { isSignedIn, isSessionInCloud, updateCloudStemMeta } = await import('./drive');
          if (isSignedIn() && sessionMeta.id && isSessionInCloud(sessionMeta.id)) {
            updateCloudStemMeta(sessionMeta.id, { lyricTrack: track }).catch(() => {});
          }
          lyricPanel.setTrack(track);
          await showInfoDialog('Loaded from Colab', 'Lyrics with timing have been loaded from your Drive (Colab results).');
        } else {
          await showInfoDialog('No results yet', 'No lyricTrack.json found in the Drive folder yet. Finish running the notebook and try again.');
        }
      } catch (e) {
        console.error(e);
        await showInfoDialog('Error', 'Failed to load Colab results from Drive.');
      }
    };

    lyricPanel = new LyricPanel({
      container: lyricsContainer,
      onLoadColabResults: loadColabResults,

      onColabRequest: async () => {
        if (!lyricPanel) return

        const vocalsStem = realStems.find(s => s.name.toLowerCase().includes('vocal'))
        if (!vocalsStem) {
          await showInfoDialog('No vocals stem', 'Please separate stems first.')
          return
        }

        let folderId = ''
        try {
          const { fetchCloudSessions } = await import('./drive/sync')
          const cloudSessions = await fetchCloudSessions()
          const cloudSess = cloudSessions.find((s: any) => s.id === sessionMeta?.id)
          if (cloudSess?.driveFolderId) folderId = cloudSess.driveFolderId
        } catch {}

        if (!folderId) {
          // Try a best-effort background upload so the folder (and vocals.webm) exist for Colab.
          // This is the common case right after separation.
          try {
            const { isSignedIn, uploadStemSession } = await import('./drive')
            if (isSignedIn() && sessionMeta?.id) {
              // Build a minimal meta from what we have in scope
              const meta = {
                id: sessionMeta.id,
                fileName: sessionMeta.fileName || 'Stem Session',
                duration: sessionMeta.duration || vocalsStem.buffer.duration,
                stemNames: realStems.map(s => s.name),
                model: sessionMeta.model || 'demucs-rs htdemucs_6s',
                createdAt: sessionMeta.createdAt || Date.now(),
                youtubeVideoId: sessionMeta.youtubeVideoId,
                youtubeVideoTitle: sessionMeta.youtubeVideoTitle,
              }
              await uploadStemSession(meta as any, realStems)
              // Re-lookup
              const { fetchCloudSessions: refetch } = await import('./drive/sync')
              const fresh = await refetch()
              const hit = fresh.find((s: any) => s.id === sessionMeta?.id)
              if (hit?.driveFolderId) folderId = hit.driveFolderId
            }
          } catch (e) {
            console.warn('[Colab] Could not auto-upload session for folderId:', e)
          }
        }

        if (!folderId) {
          await showInfoDialog(
            'Drive folder needed',
            'This stem session has not been synced to Google Drive yet.\n\n' +
            'Click the "Synced" / Drive button in the header to upload, then try "Run in my Colab" again.\n\n' +
            'Colab needs the vocals file in your Drive to process it.'
          )
          return
        }

        // --- AUTO: create the pre-filled notebook in the user's Drive session folder ---
        const panel = lyricPanel
        panel.setGenerating(true, 'Preparing Colab notebook (uploading ready .ipynb to your Drive)...')

        let colabFileId = ''
        let colabUrl = ''
        try {
          const { createColabNotebookForSession } = await import('./drive/sync')
          colabFileId = await createColabNotebookForSession(sessionMeta!.id, folderId)
          colabUrl = `https://colab.research.google.com/drive/${colabFileId}`
        } catch (err: any) {
          panel.setGenerating(false)
          console.error('[Colab] Notebook auto-upload failed:', err)
          await showInfoDialog('Colab prep failed', 'Could not create the notebook in Drive.\n\n' + (err?.message || err))
          return
        }

        panel.setGenerating(false)

        // Best-effort: copy the folder ID (useful as a fallback if user wants to look at the folder)
        try { await navigator.clipboard.writeText(folderId) } catch {}

        // --- Start polling Drive for Colab results ---
        let pollingInterval: ReturnType<typeof setInterval> | null = null
        let pollingTimeout: ReturnType<typeof setTimeout> | null = null
        const POLL_INTERVAL_MS = 15_000  // check every 15 seconds
        const POLL_MAX_MS = 10 * 60_000  // stop after 10 minutes
        const colabStartedAt = new Date().toISOString()  // used to reject stale results

        const stopPolling = () => {
          if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null }
          if (pollingTimeout) { clearTimeout(pollingTimeout); pollingTimeout = null }
          panel.setGenerating(false)
        }

        const pollForResults = async () => {
          try {
            const { loadLyricTrackFromCloud } = await import('./drive/sync')
            const track = await loadLyricTrackFromCloud(sessionMeta!.id)
            if (track) {
              // Check if this is a fresh result (processedAt must be after we started polling)
              const processedAt = track.metadata?.processedAt
              if (processedAt && new Date(processedAt) < new Date(colabStartedAt)) {
                // Stale result from a previous run — keep polling
                console.debug('[Colab poll] Found stale result (processedAt:', processedAt, '< colabStartedAt:', colabStartedAt, '). Ignoring.')
                return
              }
              if (!processedAt) {
                // No processedAt — likely old format from before this fix. Still stale.
                console.debug('[Colab poll] Found result without processedAt — likely stale. Ignoring.')
                return
              }
              // Fresh result! Stop polling and load it
              stopPolling()
              const { updateStemSessionLyricTrack } = await import('./stems')
              updateStemSessionLyricTrack(sessionMeta!.id, track)
              const { isSignedIn, isSessionInCloud, updateCloudStemMeta } = await import('./drive')
              if (isSignedIn() && sessionMeta!.id && isSessionInCloud(sessionMeta!.id)) {
                updateCloudStemMeta(sessionMeta!.id, { lyricTrack: track }).catch(() => {})
              }
              lyricPanel!.setTrack(track)
              // Close the modal if still open
              const modal = document.querySelector('[data-colab-modal]')
              if (modal) modal.remove()
              await showInfoDialog('Lyrics ready!', 'Colab finished processing. Lyrics with timing have been loaded automatically.')
            }
          } catch (e) {
            // Polling errors are silent — we'll try again next interval
            console.debug('[Colab poll] Error checking for results:', e)
          }
        }

        // Start the polling loop
        pollingInterval = setInterval(pollForResults, POLL_INTERVAL_MS)
        // Auto-stop after 10 minutes
        pollingTimeout = setTimeout(stopPolling, POLL_MAX_MS)

        // Show a compact, styled "ready" dialog (no more long manual steps)
        const overlay = document.createElement('div')
        overlay.className = 'fixed inset-0 bg-black/70 backdrop-blur z-[400] flex items-center justify-center p-6'
        overlay.setAttribute('data-colab-modal', 'true')
        overlay.innerHTML = `
          <div class="bg-zinc-900 border border-white/10 rounded-3xl p-6 max-w-lg w-full">
            <div class="text-lg font-semibold text-blue-400 mb-3">Colab notebook ready</div>
            <div class="text-sm text-zinc-300 space-y-2">
              <div>A ready-to-run notebook has been uploaded to your Drive session folder with <code>SESSION_FOLDER_ID</code> already filled in.</div>
              <div class="font-mono text-[11px] bg-zinc-950 p-1.5 rounded break-all text-emerald-400">${folderId}</div>
              <div class="text-xs text-zinc-400">It is now open in a new tab. In Colab: Runtime &rarr; GPU (T4) &rarr; Run all.</div>
              <div class="flex items-center gap-2 mt-2 text-xs text-emerald-400">
                <div class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></div>
                <span>Watching Drive for results (auto-loads when Colab finishes)</span>
              </div>
            </div>
            <div class="mt-5 flex flex-wrap gap-3">
              <button id="open-colab-btn" class="px-4 py-2 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">Open in Colab</button>
              <button id="copy-id-btn" class="px-4 py-2 rounded-2xl border border-white/20 hover:bg-white/5 text-sm">Copy Folder ID</button>
              <button id="load-now-btn" class="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm ml-auto">Load now</button>
            </div>
            <div class="mt-4 text-right">
              <button id="close-colab-modal" class="text-xs text-zinc-400 hover:text-white">Close (keeps watching)</button>
            </div>
          </div>
        `
        document.body.appendChild(overlay)

        const close = () => overlay.remove()
        overlay.querySelector('#close-colab-modal')!.addEventListener('click', close)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

        overlay.querySelector('#open-colab-btn')!.addEventListener('click', () => {
          if (colabUrl) window.open(colabUrl, '_blank')
        })
        overlay.querySelector('#copy-id-btn')!.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(folderId); await showInfoDialog('Copied', 'Folder ID copied.'); }
          catch { await showInfoDialog('Folder ID', folderId); }
        })
        overlay.querySelector('#load-now-btn')!.addEventListener('click', () => {
          close()
          stopPolling()
          loadColabResults()
        })

        // Make it "having the colab ready" — auto-open the tab for the user
        if (colabUrl) {
          // Small delay so the dialog is visible first (feels intentional)
          setTimeout(() => { try { window.open(colabUrl, '_blank') } catch {} }, 250)
        }

        // Show a waiting state in the lyric panel (behind the modal)
        panel.setGenerating(true, 'Waiting for Colab results (auto-loads when ready)...')
      },
      onProvideLyricsRequest: async () => {
        if (!lyricPanel) return

        const vocalsStem = realStems.find(s => s.name.toLowerCase().includes('vocal'))
        if (!vocalsStem) {
          await showInfoDialog('No vocals stem', 'Please separate stems first.')
          return
        }

        // Check if we already have a LyricTrack with timing (from Colab or prior generation).
        // If so, we only replace the TEXT in each segment — preserving the timing structure.
        const existingTrack = lyricPanel.getTrack()

        if (existingTrack && existingTrack.segments.length > 0) {
          // --- TEXT-ONLY CORRECTION MODE ---
          const segCount = existingTrack.segments.length
          const currentLines = existingTrack.segments.map(s => s.text).join('\n')

          const lyricsText = prompt(
            `Your current track has ${segCount} timed segments. ` +
            `Paste corrected lyrics below — the timing will be preserved, only text is updated.\n\n` +
            `If your lyrics have fewer lines (e.g. chorus not repeated), matching lines will be applied to all similar segments.\n\n` +
            `Current lyrics:\n${currentLines}`
          )

          if (!lyricsText || lyricsText.trim().length === 0) return

          // Split user input into lines (filter empty)
          const userLines = lyricsText.split('\n').map(l => l.trim()).filter(l => l.length > 0)

          // Build updated segments by matching user lines to existing segments.
          // If line counts match exactly: 1-to-1 replacement.
          // If user has fewer lines (chorus not duplicated): use similarity matching
          // so repeated sections get the same corrected text.
          const updatedSegments = [...existingTrack.segments]

          if (userLines.length === segCount) {
            // Exact match — simple 1:1 replacement
            for (let i = 0; i < segCount; i++) {
              updatedSegments[i] = { ...updatedSegments[i], text: userLines[i], source: 'user' }
            }
          } else {
            // Mismatch — use similarity to map user lines to segments.
            // This handles the common case where the user doesn't repeat the chorus.
            const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()

            const similarity = (a: string, b: string): number => {
              const na = normalize(a)
              const nb = normalize(b)
              if (na === nb) return 1.0
              if (!na || !nb) return 0

              // Trigram-based similarity
              const trigrams = (s: string): Set<string> => {
                const t = new Set<string>()
                for (let i = 0; i <= s.length - 3; i++) t.add(s.slice(i, i + 3))
                return t
              }
              const ta = trigrams(na)
              const tb = trigrams(nb)
              if (ta.size === 0 || tb.size === 0) return 0
              let intersection = 0
              for (const t of ta) { if (tb.has(t)) intersection++ }
              return (2 * intersection) / (ta.size + tb.size)
            }

            // For each existing segment, find the best matching user line
            for (let i = 0; i < segCount; i++) {
              const existingText = updatedSegments[i].text
              let bestScore = 0
              let bestLine = existingText // default: keep original if no good match

              for (const userLine of userLines) {
                const score = similarity(existingText, userLine)
                if (score > bestScore) {
                  bestScore = score
                  bestLine = userLine
                }
              }

              // Only replace if similarity is reasonable (>0.3) — otherwise keep original
              if (bestScore > 0.3) {
                updatedSegments[i] = { ...updatedSegments[i], text: bestLine, source: 'user' }
              }
            }
          }

          const updatedTrack: typeof existingTrack = {
            ...existingTrack,
            segments: updatedSegments,
            lastEditedAt: Date.now(),
          }

          // Persist
          if (sessionMeta?.id) {
            const { updateStemSessionLyricTrack } = await import('./stems')
            updateStemSessionLyricTrack(sessionMeta.id, updatedTrack)

            import('./drive').then(({ isSignedIn, isSessionInCloud, updateCloudStemMeta }) => {
              if (isSignedIn() && sessionMeta.id && isSessionInCloud(sessionMeta.id)) {
                updateCloudStemMeta(sessionMeta.id, { lyricTrack: updatedTrack }).catch(() => {})
              }
            }).catch(() => {})
          }

          lyricPanel.setTrack(updatedTrack)
          return
        }

        // --- NO EXISTING TRACK: Cannot correct lyrics without timing data ---
        await showInfoDialog(
          'No timed lyrics to correct',
          'To use your own lyrics, first generate a timed track using "Run in my Colab" (free GPU). ' +
          'The Colab notebook creates the timing structure, then you can correct the text here.\n\n' +
          'Click "Run in my Colab" to get started.'
        )
      },
      onEditRequest: () => {
        console.log('[Lyrics] Edit requested (not implemented yet)')
      }
    })

    // If a lyric track already exists for this session, load it
    if (sessionMeta?.lyricTrack) {
      lyricPanel.setTrack(sessionMeta.lyricTrack)
    } else if (sessionMeta?.id) {
      // Auto-load Colab results (lyricTrack.json sidecar) if present in Drive.
      // This makes previously-processed sessions "just work" on re-open without clicking Load.
      import('./drive').then(async ({ isSignedIn, isSessionInCloud }) => {
        if (isSignedIn() && isSessionInCloud(sessionMeta.id)) {
          try {
            const { loadLyricTrackFromCloud } = await import('./drive/sync')
            const track = await loadLyricTrackFromCloud(sessionMeta.id)
            if (track && lyricPanel) {
              const { updateStemSessionLyricTrack } = await import('./stems')
              updateStemSessionLyricTrack(sessionMeta.id, track)
              lyricPanel.setTrack(track)
            }
          } catch (e) {
            console.warn('[Lyrics] Auto-load from Colab/Drive failed (non-fatal):', e)
          }
        }
      }).catch(() => {})
    }

    // ---------- StemPlayer events ----------
    const unsub = stemPlayer.on((ev) => {
      if (ev.type === 'time') {
        const t = ev.time
        ;(window as any).__currentStemTime = t
        timeEl.textContent = formatTime(t, true)
        currentTimeDisplay.textContent = formatTime(t, true)

        // Feed time to the real lyrics panel
        lyricPanel?.setCurrentTime(t)

        const ph = document.getElementById('real-playhead') as HTMLElement
        if (ph) ph.style.left = `${(t / decoded.duration) * 100}%`

        // Keep loop region + handles in sync
        const region = document.getElementById('real-loop-region') as HTMLElement
        const hS = document.getElementById('real-handle-start') as HTMLElement
        const hE = document.getElementById('real-handle-end') as HTMLElement
        if (region && hS && hE) {
          const pct = (x: number) => Math.max(0, Math.min(100, (x / decoded.duration) * 100))
          const left = pct(loopStart)
          const w = Math.max(pct(loopEnd) - left, 0.6)
          region.style.left = `${left}%`
          region.style.width = `${w}%`
          hS.style.left = `${left}%`
          hE.style.left = `${pct(loopEnd)}%`
        }
      }

      if (ev.type === 'play' || ev.type === 'pause') {
        playLabel.textContent = stemPlayer.isCurrentlyPlaying() ? 'PAUSE' : 'PLAY'
      }
    })

    // ---------- Keyboard shortcuts ----------
    const keyHandler = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return
      const key = ev.key.toLowerCase()

      switch (key) {
        case ' ':
          ev.preventDefault()
          stemPlayer.togglePlayPause()
          break
        case '[':
          ev.preventDefault()
          {
            const cur = (window as any).__currentStemTime ?? 0
            loopStart = Math.max(0, Math.min(cur, loopEnd - 0.2))
            applyLoopToPlayer()
          }
          break
        case ']':
          ev.preventDefault()
          {
            const cur = (window as any).__currentStemTime ?? decoded.duration
            loopEnd = Math.min(decoded.duration, Math.max(cur, loopStart + 0.2))
            applyLoopToPlayer()
          }
          break
        case 'l':
          ev.preventDefault()
          isLooping = !isLooping
          applyLoopToPlayer()
          break
        case 'r':
          ev.preventDefault()
          stemPlayer.restart()
          break
        case 'arrowleft':
          ev.preventDefault()
          {
            const cur = (window as any).__currentStemTime ?? 0
            stemPlayer.seek(Math.max(0, cur - 1))
          }
          break
        case 'arrowright':
          ev.preventDefault()
          {
            const cur = (window as any).__currentStemTime ?? 0
            stemPlayer.seek(Math.min(decoded.duration, cur + 1))
          }
          break
        case 'escape':
          this.hideShortcuts()
          break
        case '?':
          ev.preventDefault()
          this.showShortcuts()
          break
        case '1': stemPlayer.setPlaybackRate(0.25); updateSpeed(); break
        case '2': stemPlayer.setPlaybackRate(0.75); updateSpeed(); break
        case '3': stemPlayer.setPlaybackRate(1); updateSpeed(); break
        case '4': stemPlayer.setPlaybackRate(1.25); updateSpeed(); break
        case '5': stemPlayer.setPlaybackRate(1.5); updateSpeed(); break
        case '6': stemPlayer.setPlaybackRate(2); updateSpeed(); break
        case '-': {
          const next = Math.max(0.25, Math.round((stemPlayer.getCurrentPlaybackRate() - 0.05) * 100) / 100)
          stemPlayer.setPlaybackRate(next); updateSpeed(); break
        }
        case '=':
        case '+': {
          const next = Math.min(2.0, Math.round((stemPlayer.getCurrentPlaybackRate() + 0.05) * 100) / 100)
          stemPlayer.setPlaybackRate(next); updateSpeed(); break
        }
      }
    }
    document.addEventListener('keydown', keyHandler, { capture: false })

    // ---------- Sync to Drive button ----------
    const syncBtn = document.getElementById('stem-sync-drive-btn') as HTMLButtonElement | null
    const syncLabel = document.getElementById('stem-sync-drive-label')
    if (syncBtn && syncLabel && sessionMeta) {
      // Check if user is signed in and session isn't already synced
      import('./drive').then(({ isSignedIn, isSessionInCloud, uploadStemSession }) => {
        if (!isSignedIn()) return
        if (isSessionInCloud(sessionMeta.id)) {
          // Already synced — show indicator
          syncBtn.classList.remove('hidden')
          syncBtn.disabled = true
          syncBtn.className = syncBtn.className.replace('bg-blue-500/10', 'bg-emerald-500/10')
            .replace('text-blue-400', 'text-emerald-400')
            .replace('border-blue-500/30', 'border-emerald-500/30')
            .replace('hover:bg-blue-500/20', '')
            .replace('active:bg-blue-500/30', '')
          syncLabel.textContent = 'Synced'
          return
        }

        // Show the button — not yet synced
        syncBtn.classList.remove('hidden')
        syncBtn.addEventListener('click', async () => {
          syncBtn.disabled = true
          syncLabel.textContent = 'Syncing...'

          try {
            await uploadStemSession(sessionMeta, realStems, (p) => {
              if (p.phase === 'encoding') syncLabel.textContent = p.message
              else if (p.phase === 'uploading') syncLabel.textContent = p.message
              else if (p.phase === 'done') {
                syncLabel.textContent = 'Synced'
                syncBtn.className = syncBtn.className.replace('bg-blue-500/10', 'bg-emerald-500/10')
                  .replace('text-blue-400', 'text-emerald-400')
                  .replace('border-blue-500/30', 'border-emerald-500/30')
              } else if (p.phase === 'error') {
                syncLabel.textContent = 'Sync failed'
                syncBtn.disabled = false
              }
            })
          } catch (err) {
            console.error('[drive-sync] Manual sync failed:', err)
            syncLabel.textContent = 'Sync failed'
            syncBtn.disabled = false
          }
        })
      }).catch(() => {})
    }

    // ---------- Exit ----------
    document.getElementById('exit-stem-real')!.addEventListener('click', () => {
      document.removeEventListener('keydown', keyHandler, { capture: false } as any)
      unsub()
      stemPlayer.dispose()
      stemArea.remove()
      this.els.loaderSection.classList.remove('hidden')
      this.reEnableSeparateStemsButton()
      // Refresh lists so user sees this session in the recent stems
      this.renderInitialPreviousStems()
      this.renderInitialRecentVideos()
    })

    console.log('%c[weblooper] Real stems loaded into StemPlayer (full controls + presets)', 'color:#166534')
  }

  /**
   * Demo stem mode (uses same audio duplicated as 6 stems for UI testing).
   * Real separation will replace these with actual demucs-rs 6-stem outputs.
   */
  // @ts-expect-error - demo code path kept for future reference / internal testing
  private async _enterStemPracticeMode(decoded: { buffer: AudioBuffer; fileName: string; duration: number }) {
    // Hide loader completely
    this.els.loaderSection.classList.add('hidden')

    // Create or show a dedicated stem practice area
    let stemArea = document.getElementById('stem-practice-area')
    if (!stemArea) {
      stemArea = document.createElement('div')
      stemArea.id = 'stem-practice-area'
      stemArea.className = 'max-w-[1100px] mx-auto'
      this.els.playerSection.parentElement!.appendChild(stemArea)
    }
    stemArea.innerHTML = ''
    stemArea.classList.remove('hidden')

    // === Create fake stems (demo) ===
    // In the real future this will come from the StemEngine after separation.
    const makeFakeStem = (name: string): StemTrack => {
      // For the spike we just reuse the same buffer.
      // Later: each stem will have its own isolated AudioBuffer.
      return { name, buffer: decoded.buffer }
    }

    const fakeStems: StemTrack[] = [
      makeFakeStem('Full Mix'),
      makeFakeStem('Drums / Low'),
      makeFakeStem('Vocals / Mid'),
      makeFakeStem('Other / High'),
    ]

    // === Instantiate the real StemPlayer ===
    const stemPlayer = new StemPlayer()
    stemPlayer.loadStems(fakeStems)
    // Default: full track, no loop (user can enable + set region with controls)
    stemPlayer.setLoop(0, decoded.duration)
    stemPlayer.setIsLooping(false)

    // === Build the UI ===
    stemArea.innerHTML = `
      <div class="mb-3 flex items-center justify-between">
        <div>
          <div class="text-emerald-400 text-xs tracking-[1.5px] font-semibold">STEM PRACTICE MODE</div>
          <div class="text-2xl font-semibold tracking-tight truncate max-w-[600px]">${decoded.fileName}</div>
        </div>
        <button id="exit-stem-mode"
                class="text-sm px-4 py-2 rounded-2xl border border-white/10 hover:bg-zinc-900">Exit Stem Mode</button>
      </div>

      <!-- Big transport (reuses familiar patterns) -->
      <div class="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-6">
        <!-- Left: Timeline + big controls -->
        <div>
          <div id="stem-timeline" class="timeline w-full"></div>
          <div class="flex justify-between text-xs text-zinc-500 mt-1 px-1 font-mono tabular-nums">
            <div id="stem-time-start">0:00</div>
            <div id="stem-time-current" class="text-emerald-400 font-medium">0:00</div>
            <div id="stem-time-end">${formatTime(decoded.duration)}</div>
          </div>

          <div class="flex gap-2 mt-4">
            <button id="stem-play-pause"
                    class="flex-1 py-3 rounded-2xl bg-white text-zinc-950 font-semibold active:scale-[0.985]">
              PAUSE
            </button>
            <button id="stem-restart-loop"
                    class="flex-1 py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 font-semibold border border-white/10">
              ↺ Restart
            </button>
          </div>

          <div class="mt-3 text-xs text-zinc-500">Click timeline to seek • Drag handles coming soon</div>
        </div>

        <!-- Right: Stem Mixer -->
        <div id="stem-mixer-container"></div>
      </div>

      <!-- Speed chips (reuse same speeds) -->
      <div class="mt-6">
        <div class="flex items-center justify-between text-xs text-zinc-400 mb-2">
          <span class="tracking-widest">SPEED</span>
          <div class="flex items-center gap-1.5">
            <button id="stem-speed-dec" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">−</button>
            <span id="stem-speed-value" class="font-mono text-emerald-400 min-w-[3.2rem] text-center">1.00×</span>
            <button id="stem-speed-inc" class="w-6 h-6 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-zinc-300 text-xs font-bold flex items-center justify-center transition">+</button>
          </div>
        </div>
        <div id="stem-speed-chips" class="flex flex-wrap gap-1.5"></div>
      </div>

      <div class="mt-4 text-[10px] text-amber-400/70">
        Demo stems (temporary). Primary engine is now demucs-rs 6-stem (guitar + piano). Real separation coming online shortly.
      </div>
    `

    // === Wire timeline (simple clickable version for now) ===
    const timeline = document.getElementById('stem-timeline')!
    const timeCurrent = document.getElementById('stem-time-current')!
    const timeStart = document.getElementById('stem-time-start')!
    const timeEnd = document.getElementById('stem-time-end')!

    // Build simple timeline track
    timeline.innerHTML = `
      <div class="timeline-track"></div>
      <div class="timeline-loop" id="stem-timeline-loop"></div>
      <div class="timeline-playhead" id="stem-timeline-playhead"></div>
    `

    timeline.addEventListener('click', (ev) => {
      const rect = timeline.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      stemPlayer.seek(pct * decoded.duration)
    })

    // === Wire transport buttons ===
    const playBtn = document.getElementById('stem-play-pause')!
    const restartBtn = document.getElementById('stem-restart-loop')!

    playBtn.addEventListener('click', () => stemPlayer.togglePlayPause())
    restartBtn.addEventListener('click', () => stemPlayer.restart())

    // === Speed chips ===
    const speedContainer = document.getElementById('stem-speed-chips')!
    const speedValue = document.getElementById('stem-speed-value')!
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

    speeds.forEach(speed => {
      const btn = document.createElement('button')
      btn.className = `speed-chip ${speed === 1 ? 'active' : ''}`
      btn.textContent = speed + '×'
      btn.addEventListener('click', () => {
        stemPlayer.setPlaybackRate(speed)
        updateSpeedUI()
      })
      speedContainer.appendChild(btn)
    })

    // Fine speed control (±0.05)
    const speedDecBtnDemo = document.getElementById('stem-speed-dec')!
    const speedIncBtnDemo = document.getElementById('stem-speed-inc')!
    speedDecBtnDemo.onclick = () => {
      const next = Math.max(0.25, Math.round((stemPlayer.getCurrentPlaybackRate() - 0.05) * 100) / 100)
      stemPlayer.setPlaybackRate(next); updateSpeedUI()
    }
    speedIncBtnDemo.onclick = () => {
      const next = Math.min(2.0, Math.round((stemPlayer.getCurrentPlaybackRate() + 0.05) * 100) / 100)
      stemPlayer.setPlaybackRate(next); updateSpeedUI()
    }

    function updateSpeedUI() {
      const current = stemPlayer.getCurrentPlaybackRate()
      speedValue.textContent = current.toFixed(2) + '×'
      speedContainer.querySelectorAll('button').forEach(btn => {
        const val = parseFloat(btn.textContent!.replace('×', ''))
        btn.classList.toggle('active', Math.abs(val - current) < 0.01)
      })
    }

    // === Stem Mixer ===
    const mixerContainer = document.getElementById('stem-mixer-container')!
    createStemMixerUI({
      container: mixerContainer,
      player: stemPlayer,
      onClose: () => {
        // For now just leave it open — user can reset mix inside
      }
    })

    // === Listen to StemPlayer events and drive the UI ===
    const unsub = stemPlayer.on((event) => {
      if (event.type === 'time') {
        const t = event.time
        timeCurrent.textContent = formatTime(t, true)

        // Update playhead
        const playhead = document.getElementById('stem-timeline-playhead') as HTMLElement
        if (playhead && decoded.duration > 0) {
          const pct = (t / decoded.duration) * 100
          playhead.style.left = `${pct}%`
        }

        // Update loop region (simple)
        const loopRegion = document.getElementById('stem-timeline-loop') as HTMLElement
        if (loopRegion) {
          const { start, end } = stemPlayer.getLoopRegion()
          const left = (start / decoded.duration) * 100
          const width = ((end - start) / decoded.duration) * 100
          loopRegion.style.left = `${left}%`
          loopRegion.style.width = `${Math.max(width, 0.5)}%`
        }
      }

      if (event.type === 'play' || event.type === 'pause') {
        playBtn.textContent = stemPlayer.isCurrentlyPlaying() ? 'PAUSE' : 'PLAY'
      }

      if (event.type === 'loop-jump') {
        // visual feedback if desired
      }
    })

    // Initial UI state
    timeStart.textContent = formatTime(0)
    timeEnd.textContent = formatTime(decoded.duration)
    playBtn.textContent = 'PLAY'
    updateSpeedUI()

    // Seed initial loop region visual
    const loopRegion = document.getElementById('stem-timeline-loop') as HTMLElement
    if (loopRegion) {
      const { start, end } = stemPlayer.getLoopRegion()
      const left = (start / decoded.duration) * 100
      const width = ((end - start) / decoded.duration) * 100
      loopRegion.style.left = `${left}%`
      loopRegion.style.width = `${Math.max(width, 0.5)}%`
    }

    // Exit button
    document.getElementById('exit-stem-mode')!.addEventListener('click', () => {
      unsub()
      stemPlayer.dispose()
      stemArea!.remove()
      this.els.loaderSection.classList.remove('hidden')
      this.reEnableSeparateStemsButton()
      // Show original loader content again (quick & dirty for spike)
      location.reload()
    })

    // Keyboard support inside stem mode (reuse many of the same keys)
    const keyHandler = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement) return

      switch (ev.key.toLowerCase()) {
        case ' ':
          ev.preventDefault()
          stemPlayer.togglePlayPause()
          break
        case 'r':
          ev.preventDefault()
          stemPlayer.restart()
          break
        case '1': stemPlayer.setPlaybackRate(0.25); updateSpeedUI(); break
        case '2': stemPlayer.setPlaybackRate(0.75); updateSpeedUI(); break
        case '3': stemPlayer.setPlaybackRate(1); updateSpeedUI(); break
        case '4': stemPlayer.setPlaybackRate(1.25); updateSpeedUI(); break
        case '5': stemPlayer.setPlaybackRate(1.5); updateSpeedUI(); break
        case '6': stemPlayer.setPlaybackRate(2); updateSpeedUI(); break
        case '-': {
          const next = Math.max(0.25, Math.round((stemPlayer.getCurrentPlaybackRate() - 0.05) * 100) / 100)
          stemPlayer.setPlaybackRate(next); updateSpeedUI(); break
        }
        case '=':
        case '+': {
          const next = Math.min(2.0, Math.round((stemPlayer.getCurrentPlaybackRate() + 0.05) * 100) / 100)
          stemPlayer.setPlaybackRate(next); updateSpeedUI(); break
        }
      }
    }
    document.addEventListener('keydown', keyHandler, { once: false })

    // Store for cleanup if needed
    ;(window as any).__currentStemPlayer = stemPlayer

    console.log('%c[weblooper] Entered Stem Practice Mode (demo stems + real StemPlayer)', 'color:#166534')
  }

  private async fetchAndSetTitle(videoId: string) {
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
      )
      if (res.ok) {
        const data = await res.json()
        const title = data.title || `YouTube video ${videoId}`
        this.els.videoTitle.textContent = title
        // Persist the title so the "Recent videos" list on the home screen shows nice names
        saveVideoState(videoId, { title })
      } else {
        this.els.videoTitle.textContent = `YouTube video ${videoId}`
      }
    } catch {
      this.els.videoTitle.textContent = `YouTube video ${videoId}`
    }
    this.els.videoIdBadge.textContent = videoId
  }

  private unloadVideo() {
    // Stop pitch-shifted audio playback
    this.stopPitchPlayback()
    this.videoPitch = 0
    this._pitchRawBuffer = null
    this.stopTimeMonitor()
    if (this.player) {
      try { this.player.pauseVideo() } catch {}
      try { this.player.stopVideo() } catch {}
    }

    // Force-kill YouTube iframe audio by blanking src before any DOM removal.
    // This is the most reliable way to stop YouTube audio — the iframe's media
    // pipeline shuts down immediately when src changes to about:blank.
    document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu"]').forEach(el => {
      try { (el as HTMLIFrameElement).src = 'about:blank' } catch {}
      el.remove()
    })

    if (this.player) {
      try { this.player.destroy() } catch {}
      this.player = null
    }
    this.playerReady = false
    this.currentVideoId = null
    this.duration = 0
    this.start = 0
    this.end = 0
    this.isLooping = false
    this.presets = []
    this.lastKnownTime = 0

    // Reset timeline so it rebuilds cleanly for next video
    if (this.els?.timeline) {
      this.els.timeline.innerHTML = ''
      delete this.els.timeline.dataset.initialized
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pitch Shift for YouTube Video — Pre-generated approach
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Handle a pitch/key change request for the current YouTube video.
   * If pitch is 0, stop pitch playback and unmute YouTube.
   * Otherwise, load (or generate) the pitch-shifted audio and play it synced to video.
   *
   * Priority order:
   * 1. Local OPFS cache (instant)
   * 2. Google Drive (download if available)
   * 3. Generate from raw audio (local or Drive)
   * 4. Record audio first, then generate
   */
  private async handleVideoPitchChange(semitones: number) {
    if (!this.currentVideoId) return

    // If returning to original key, just stop pitch playback and unmute YouTube
    if (semitones === 0) {
      this.videoPitch = 0
      this.stopPitchPlayback()
      this._pitchRawBuffer = null
      try { this.player?.unMute?.() } catch {}
      return
    }

    const videoId = this.currentVideoId
    const tempo = this.playbackRate
    const needsTempo = Math.abs(tempo - 1.0) >= 0.01

    // Check if we already have this pitch cached locally
    const { hasPitchedAudio, loadPitchedAudio, hasRawAudio, loadRawAudio, saveRawAudio, savePitchedAudio } = await import('./audio/pitch-cache')

    if (hasPitchedAudio(videoId, semitones)) {
      const opusData = await loadPitchedAudio(videoId, semitones)
      if (opusData) {
        const buffer = await this.decodeOpusToBuffer(opusData)

        // If speed != 1.0, we need to time-stretch the pitched buffer
        if (needsTempo) {
          // We need the raw buffer for re-stretching on future speed changes
          await this.ensurePitchRawBufferLoaded(videoId)
          const { timeStretch } = await import('./audio/time-stretch')
          const playbackBuffer = timeStretch(buffer, tempo, 0) // already pitched, just stretch tempo
          this.videoPitch = semitones
          this.startPitchPlayback(playbackBuffer)
        } else {
          // Also load raw buffer in background for future speed changes
          this.ensurePitchRawBufferLoaded(videoId)
          this.videoPitch = semitones
          this.startPitchPlayback(buffer)
        }
        return
      }
    }

    // Check Google Drive for the pitched file
    try {
      const { isSignedIn, getPitchCacheEntry, downloadPitchedAudio, downloadPitchRawAudio } = await import('./drive')
      if (isSignedIn()) {
        const cloudEntry = getPitchCacheEntry(videoId)

        // Try downloading the exact pitch from Drive
        if (cloudEntry?.generatedKeys.includes(semitones)) {
          const pitchValueEl = document.getElementById('pitch-value')
          if (pitchValueEl) pitchValueEl.textContent = '...'

          const opusData = await downloadPitchedAudio(videoId, semitones)
          if (opusData) {
            // Save locally for future use
            await savePitchedAudio(videoId, semitones, opusData)
            const buffer = await this.decodeOpusToBuffer(opusData)

            if (needsTempo) {
              await this.ensurePitchRawBufferLoaded(videoId)
              const { timeStretch } = await import('./audio/time-stretch')
              const playbackBuffer = timeStretch(buffer, tempo, 0)
              this.videoPitch = semitones
              this.startPitchPlayback(playbackBuffer)
            } else {
              this.ensurePitchRawBufferLoaded(videoId)
              this.videoPitch = semitones
              this.startPitchPlayback(buffer)
            }
            return
          }
        }

        // Try downloading raw audio from Drive to generate locally
        if (!hasRawAudio(videoId) && cloudEntry?.hasRaw) {
          const pitchValueEl = document.getElementById('pitch-value')
          if (pitchValueEl) pitchValueEl.textContent = '...'

          const rawOpusData = await downloadPitchRawAudio(videoId)
          if (rawOpusData) {
            await saveRawAudio(videoId, rawOpusData, cloudEntry.duration)
            const rawBuffer = await this.decodeOpusToBuffer(rawOpusData)
            await this.generateAndPlayPitchedAudio(videoId, semitones, rawBuffer)
            return
          }
        }
      }
    } catch (err) {
      console.warn('[pitch] Drive check failed, falling back to local:', err)
    }

    // Check if raw audio exists locally
    if (hasRawAudio(videoId)) {
      const rawOpusData = await loadRawAudio(videoId)
      if (rawOpusData) {
        const rawBuffer = await this.decodeOpusToBuffer(rawOpusData)
        await this.generateAndPlayPitchedAudio(videoId, semitones, rawBuffer)
        return
      }
    }

    // Nothing available — need to record the audio first
    const shouldRecord = await this.showPitchRecordingDialog()
    if (!shouldRecord) return

    const rawBuffer = await this.recordRawAudioForPitchShift(videoId)
    if (!rawBuffer) return

    // Encode and save raw audio locally
    const { encodeToOpusWebM } = await import('./audio/opus-encoder')
    const rawOpus = await encodeToOpusWebM(rawBuffer, { bitrate: 128_000 })
    await saveRawAudio(videoId, rawOpus, rawBuffer.duration)

    // Background upload raw to Drive
    this.backgroundUploadPitchRaw(videoId, rawOpus, rawBuffer.duration)

    // Generate the requested pitch
    await this.generateAndPlayPitchedAudio(videoId, semitones, rawBuffer)
  }

  /**
   * Generate a pitch-shifted version from raw audio, save it, and start playback.
   * Also uploads to Drive in the background.
   * If the current playback rate != 1.0, the playback buffer is additionally time-stretched.
   */
  private async generateAndPlayPitchedAudio(videoId: string, semitones: number, rawBuffer: AudioBuffer) {
    // Save raw buffer for future speed changes
    this._pitchRawBuffer = rawBuffer

    // Show a brief generating indicator
    const pitchValueEl = document.getElementById('pitch-value')
    if (pitchValueEl) pitchValueEl.textContent = '...'

    try {
      const { timeStretch } = await import('./audio/time-stretch')
      const { encodeToOpusWebM } = await import('./audio/opus-encoder')
      const { savePitchedAudio } = await import('./audio/pitch-cache')

      // Pitch shift (tempo = 1.0, just change pitch) — this is what we store/cache
      const shifted = timeStretch(rawBuffer, 1.0, semitones)

      // Encode to Opus for storage (always store at tempo=1.0)
      const opusData = await encodeToOpusWebM(shifted, { bitrate: 128_000 })
      await savePitchedAudio(videoId, semitones, opusData)

      // Background upload to Drive
      this.backgroundUploadPitchedAudio(videoId, semitones, opusData)

      // For playback: if current speed != 1.0, apply tempo stretch on top of pitch shift
      const tempo = this.playbackRate
      const needsTempo = Math.abs(tempo - 1.0) >= 0.01
      const playbackBuffer = needsTempo ? timeStretch(rawBuffer, tempo, semitones) : shifted

      // Start playback
      this.videoPitch = semitones
      this.startPitchPlayback(playbackBuffer)

      console.log(`[pitch] Generated and cached pitch ${semitones > 0 ? '+' : ''}${semitones} for ${videoId} (tempo=${tempo})`)
    } catch (err) {
      console.error('[pitch] Failed to generate pitch-shifted audio:', err)
      if (pitchValueEl) pitchValueEl.textContent = 'ERR'
    }
  }

  /**
   * Ensure the raw AudioBuffer for the current video is loaded into memory.
   * Needed for re-stretching when speed changes while pitch is active.
   */
  private async ensurePitchRawBufferLoaded(videoId: string): Promise<void> {
    if (this._pitchRawBuffer) return

    try {
      const { loadRawAudio } = await import('./audio/pitch-cache')
      const rawOpusData = await loadRawAudio(videoId)
      if (rawOpusData) {
        this._pitchRawBuffer = await this.decodeOpusToBuffer(rawOpusData)
      }
    } catch (err) {
      console.warn('[pitch] Failed to load raw buffer for speed changes:', err)
    }
  }

  /** Background upload raw audio to Drive (non-blocking). */
  private async backgroundUploadPitchRaw(videoId: string, opusData: ArrayBuffer, duration: number) {
    try {
      const { isSignedIn, uploadPitchRawAudio } = await import('./drive')
      if (!isSignedIn()) return
      await uploadPitchRawAudio(videoId, opusData, duration)
    } catch (err) {
      console.warn('[pitch] Background raw upload failed:', err)
    }
  }

  /** Background upload pitched audio to Drive (non-blocking). */
  private async backgroundUploadPitchedAudio(videoId: string, semitones: number, opusData: ArrayBuffer) {
    try {
      const { isSignedIn, uploadPitchedAudio } = await import('./drive')
      if (!isSignedIn()) return
      await uploadPitchedAudio(videoId, semitones, opusData)
    } catch (err) {
      console.warn('[pitch] Background pitch upload failed:', err)
    }
  }

  /**
   * Start playing a pitch-shifted (and possibly time-stretched) audio buffer synced to YouTube.
   * Mutes YouTube audio and plays the buffer using Web Audio API.
   *
   * The buffer is always pre-stretched to match the current playbackRate, so we play it
   * at rate=1.0 in the AudioBufferSourceNode. Drift correction converts between
   * "logical time" (video position) and "buffer time" (position in the stretched buffer).
   */
  private startPitchPlayback(buffer: AudioBuffer) {
    // Stop any existing pitch playback
    this.stopPitchPlayback()

    // Mute YouTube
    try { this.player?.mute?.() } catch {}

    // Create audio context
    const ctx = new AudioContext()
    this._pitchAudioContext = ctx

    const rate = this.playbackRate

    // Convert between logical time (video position) and buffer time
    const logicalToBuffer = (logicalTime: number): number => {
      if (Math.abs(rate - 1.0) < 0.01) return logicalTime
      return logicalTime / rate
    }
    const bufferToLogical = (bufferElapsed: number): number => {
      if (Math.abs(rate - 1.0) < 0.01) return bufferElapsed
      return bufferElapsed * rate
    }

    // Track position for drift calculation
    let pitchStartCtxTime = ctx.currentTime
    let pitchStartLogicalOffset = 0  // logical (video) time when we started

    const restartFrom = (logicalOffset: number) => {
      if (this._pitchAudioSource) {
        try { this._pitchAudioSource.stop() } catch {}
      }
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      const bufferOffset = logicalToBuffer(logicalOffset)
      const clampedOffset = Math.max(0, Math.min(bufferOffset, buffer.duration - 0.01))
      source.start(0, clampedOffset)
      this._pitchAudioSource = source
      pitchStartCtxTime = ctx.currentTime
      pitchStartLogicalOffset = logicalOffset
    }

    // Get current YouTube state and start from there if playing
    const ytTime = this.player?.getCurrentTime?.() ?? 0
    const ytState = this.player?.getPlayerState?.()
    const YT = window.YT

    if (YT && ytState === YT.PlayerState.PLAYING) {
      restartFrom(ytTime)
    }

    // Sync with YouTube: poll for play/pause and time drift
    this._pitchSyncInterval = window.setInterval(() => {
      if (!this.player || !this._pitchAudioContext) return

      try {
        const state = this.player.getPlayerState?.()
        if (!window.YT) return

        const isPlaying = state === window.YT.PlayerState.PLAYING

        if (isPlaying && this._pitchAudioContext.state === 'suspended') {
          this._pitchAudioContext.resume()
          const t = this.player.getCurrentTime?.() ?? 0
          restartFrom(t)
        } else if (!isPlaying && this._pitchAudioContext.state === 'running') {
          this._pitchAudioContext.suspend()
        }

        // Drift correction while playing
        if (isPlaying && this._pitchAudioSource) {
          const ytNow = this.player.getCurrentTime?.() ?? 0
          const bufferElapsed = ctx.currentTime - pitchStartCtxTime
          // Since buffer is pre-stretched, elapsed buffer time maps to logical time via bufferToLogical
          const audioLogicalPos = pitchStartLogicalOffset + bufferToLogical(bufferElapsed)

          if (Math.abs(ytNow - audioLogicalPos) > 0.15) {
            restartFrom(ytNow)
          }
        }
      } catch {
        // ignore transient errors
      }
    }, 100)
  }

  /**
   * Stop pitch-shifted audio playback and clean up resources.
   */
  private stopPitchPlayback() {
    if (this._pitchSyncInterval) {
      clearInterval(this._pitchSyncInterval)
      this._pitchSyncInterval = null
    }
    if (this._pitchAudioSource) {
      try { this._pitchAudioSource.stop() } catch {}
      this._pitchAudioSource = null
    }
    if (this._pitchAudioContext) {
      try { this._pitchAudioContext.close() } catch {}
      this._pitchAudioContext = null
    }
  }

  /**
   * Decode an Opus/WebM ArrayBuffer back to an AudioBuffer.
   */
  private async decodeOpusToBuffer(opusData: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = new AudioContext()
    const buffer = await ctx.decodeAudioData(opusData.slice(0))  // slice to avoid detached buffer issues
    try { await ctx.close() } catch {}
    return buffer
  }

  /**
   * Show a dialog informing the user that audio needs to be recorded for pitch shift.
   * Returns true if user wants to proceed, false if cancelled.
   */
  private showPitchRecordingDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4'
      overlay.innerHTML = `
        <div class="bg-zinc-900 border border-white/10 rounded-3xl p-8 max-w-[480px] w-full">
          <div class="text-emerald-400 text-xs tracking-[2px] mb-2">KEY CHANGE</div>
          <div class="text-xl font-semibold tracking-tight mb-3">Audio recording needed</div>
          <div class="text-sm text-zinc-400 mb-6 leading-relaxed">
            To change the key, we need to capture the audio from this video first.
            The video will play once from the beginning at normal speed while we record.
            This only needs to be done once — after that, any key change is instant.
          </div>
          <div class="flex gap-3 justify-end">
            <button id="pitch-rec-cancel" class="px-4 py-2 rounded-xl border border-white/10 text-sm text-zinc-400 hover:text-white transition">Cancel</button>
            <button id="pitch-rec-start" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm text-white font-medium transition">Start Recording</button>
          </div>
        </div>
      `
      document.body.appendChild(overlay)

      overlay.querySelector('#pitch-rec-cancel')!.addEventListener('click', () => {
        overlay.remove()
        resolve(false)
      })
      overlay.querySelector('#pitch-rec-start')!.addEventListener('click', () => {
        overlay.remove()
        resolve(true)
      })
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove()
          resolve(false)
        }
      })
    })
  }

  /**
   * Record raw audio from the current YouTube video for pitch shifting.
   * Similar to the stem separation recording, but skips the AI separation step.
   * Returns the captured AudioBuffer, or null if cancelled/failed.
   */
  private async recordRawAudioForPitchShift(_videoId: string): Promise<AudioBuffer | null> {
    const videoDuration = this.duration || this.player?.getDuration?.() || 0
    if (videoDuration <= 0) {
      alert('Cannot determine video duration. Try playing the video first.')
      return null
    }

    const timeEstimate = ` (~${Math.floor(videoDuration / 60)}:${(Math.ceil(videoDuration) % 60).toString().padStart(2, '0')})`

    // Show recording overlay
    const overlay = document.createElement('div')
    overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4'
    overlay.innerHTML = `
      <div class="bg-zinc-900 border border-white/10 rounded-3xl p-8 max-w-[520px] w-full">
        <div class="text-emerald-400 text-xs tracking-[2px] mb-1">RECORDING AUDIO</div>
        <div class="text-xl font-semibold tracking-tight mb-2">Capturing video audio${timeEstimate}</div>
        <div class="text-sm text-zinc-400 mb-4">Please wait while the video plays. Do not switch tabs.</div>
        <div class="h-2 bg-zinc-800 rounded-full overflow-hidden mb-3">
          <div id="pitch-rec-bar" class="h-2 bg-emerald-500 w-[3%] transition-all"></div>
        </div>
        <div id="pitch-rec-status" class="text-sm text-zinc-400">Requesting tab audio access...</div>
        <div class="mt-5">
          <button id="pitch-rec-cancel" class="text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const progressBar = overlay.querySelector('#pitch-rec-bar') as HTMLElement
    const statusEl = overlay.querySelector('#pitch-rec-status') as HTMLElement
    const abortController = new AbortController()

    overlay.querySelector('#pitch-rec-cancel')!.addEventListener('click', () => {
      abortController.abort()
    })

    // Disable looping during recording
    const prevIsLooping = this.isLooping
    this.isLooping = false
    this.stopTimeMonitor()

    // Save and force volume
    let prevVolume = 100, prevMuted = false
    try {
      if (this.player && this.playerReady) {
        prevVolume = this.player.getVolume?.() ?? 100
        prevMuted = this.player.isMuted?.() ?? false
      }
    } catch {}

    // Set up auto-stop when video ends
    this._onVideoEndedDuringCapture = () => {
      abortController.abort()
    }

    try {
      const { captureTabAudio } = await import('./youtube/tab-audio-capture')

      const result = await captureTabAudio({
        durationSeconds: videoDuration,
        signal: abortController.signal,
        onPermissionGranted: async () => {
          // Start video from beginning at 1x
          if (this.player && this.playerReady) {
            this.player.unMute?.()
            this.player.setVolume?.(100)
            this.player.seekTo(0, true)
            this.player.setPlaybackRate(1)
            this.player.playVideo()
          }
          await new Promise(r => setTimeout(r, 450))
        },
        onProgress: (info) => {
          if (info.phase === 'recording') {
            statusEl.textContent = info.message
            if (info.percent !== undefined) {
              progressBar.style.width = `${Math.min(95, info.percent)}%`
            }
          } else if (info.phase === 'processing') {
            statusEl.textContent = 'Processing...'
            progressBar.style.width = '95%'
          }
        },
      })

      this._onVideoEndedDuringCapture = null
      overlay.remove()

      // Restore player state
      this.isLooping = prevIsLooping
      try {
        if (this.player && this.playerReady) {
          this.player.pauseVideo?.()
          if (prevMuted) this.player.mute?.(); else this.player.unMute?.()
          this.player.setVolume?.(prevVolume)
        }
      } catch {}
      this.startTimeMonitor()

      return result.buffer
    } catch (err: any) {
      this._onVideoEndedDuringCapture = null
      overlay.remove()

      // Restore player state
      this.isLooping = prevIsLooping
      try {
        if (this.player && this.playerReady) {
          this.player.pauseVideo?.()
          if (prevMuted) this.player.mute?.(); else this.player.unMute?.()
          this.player.setVolume?.(prevVolume)
        }
      } catch {}
      this.startTimeMonitor()

      if (err.message?.includes('cancelled') || err.message?.includes('abort')) {
        return null
      }
      console.error('[pitch] Recording failed:', err)
      alert(`Failed to record audio: ${err.message}`)
      return null
    }
  }

  private setStart(seconds: number) {
    this.start = clamp(seconds, 0, this.duration - 0.5)
    if (this.end <= this.start) this.end = Math.min(this.start + 5, this.duration)

    this.updateAllUI()
    this.persistState()

    // If currently playing and loop on, jump into the new region
    if (this.isLooping && this.playerReady) {
      const t = this.player.getCurrentTime()
      if (t < this.start || t > this.end) this.seekTo(this.start)
    }
  }

  private setEnd(seconds: number) {
    this.end = clamp(seconds, this.start + 0.2, this.duration)
    this.updateAllUI()
    this.persistState()
  }

  private setStartFromCurrent() {
    if (!this.playerReady) return
    const t = this.player.getCurrentTime() || this.lastKnownTime
    this.setStart(t)
  }

  private setEndFromCurrent() {
    if (!this.playerReady) return
    const t = this.player.getCurrentTime() || this.lastKnownTime
    this.setEnd(t)
  }

  private nudgeStart(delta: number) {
    this.setStart(this.start + delta)
  }

  private nudgeEnd(delta: number) {
    this.setEnd(this.end + delta)
  }

  private toggleLoop() {
    this.isLooping = !this.isLooping
    this.updateLoopToggleUI()
    this.persistState()

    if (this.isLooping && this.playerReady) {
      const t = this.player.getCurrentTime()
      if (t < this.start || t >= this.end) {
        this.seekTo(this.start)
      }
    }
  }

  private setPlaybackRate(rate: number) {
    this.playbackRate = rate
    if (this.playerReady && this.player) {
      this.player.setPlaybackRate(rate)
    }
    this.updateSpeedUI()
    this.persistState()

    // If pitch playback is active, re-stretch the buffer for the new tempo
    if (this.videoPitch !== 0 && this._pitchRawBuffer) {
      this.restretchPitchForTempo(rate)
    }
  }

  /**
   * Re-process the raw audio buffer with the current pitch + new tempo,
   * then restart pitch playback. Shows a brief "stretching" indicator.
   * Uses a generation counter to discard stale results if speed changes rapidly.
   */
  private async restretchPitchForTempo(tempo: number) {
    const rawBuffer = this._pitchRawBuffer
    if (!rawBuffer) return

    const generation = ++this._pitchStretchGeneration

    const pitchValueEl = document.getElementById('pitch-value')
    if (pitchValueEl) pitchValueEl.textContent = '...'

    try {
      const { timeStretch } = await import('./audio/time-stretch')

      // Yield to keep UI responsive before heavy processing
      await new Promise(resolve => setTimeout(resolve, 0))

      // Check if a newer stretch was requested while we were waiting
      if (generation !== this._pitchStretchGeneration) return

      // Pure pitch shift (no tempo change) when speed is 1x
      // Otherwise combine tempo stretch + pitch shift
      const needsTempo = Math.abs(tempo - 1.0) >= 0.01
      const stretched = timeStretch(rawBuffer, needsTempo ? tempo : 1.0, this.videoPitch)

      // Check again after processing — another speed change might have happened
      if (generation !== this._pitchStretchGeneration) return

      // Restart playback with the new buffer from the current YouTube position
      this.startPitchPlayback(stretched)

      // Update pitch display
      if (pitchValueEl) pitchValueEl.textContent = this.videoPitch > 0 ? `+${this.videoPitch}` : String(this.videoPitch)

      console.log(`[pitch] Re-stretched for tempo=${tempo}, pitch=${this.videoPitch}`)
    } catch (err) {
      if (generation !== this._pitchStretchGeneration) return
      console.error('[pitch] Failed to re-stretch audio:', err)
      if (pitchValueEl) pitchValueEl.textContent = 'ERR'
    }
  }

  /**
   * Restore original playback state after a tab audio capture session.
   * Resets speed to 1x (or the user's original rate), pauses the video,
   * and seeks back to the start.
   */
  private restorePlaybackStateAfterCapture(originalRate: number) {
    if (this.player && this.playerReady) {
      try {
        this.player.setPlaybackRate(originalRate)
        this.player.pauseVideo()
        this.player.seekTo(0, true)
      } catch {}
    }
    this.playbackRate = originalRate
    this.updateSpeedUI()
  }

  private togglePlayPause() {
    if (!this.playerReady || !this.player) return

    const state = this.player.getPlayerState()
    const YT = window.YT

    if (state === YT.PlayerState.PLAYING) {
      this.player.pauseVideo()
    } else {
      this.player.playVideo()
    }
  }

  private updatePlayPauseUI(ytState?: number) {
    const YT = window.YT
    const isPlaying = ytState === YT.PlayerState.PLAYING

    this.els.playLabel.textContent = isPlaying ? 'PAUSE' : 'PLAY'
  }

  private restartLoop() {
    if (!this.playerReady) return
    const target = this.isLooping ? this.start : 0
    this.seekTo(target)
    setTimeout(() => {
      if (this.player) this.player.playVideo()
    }, 30)
  }

  private useFullVideo() {
    if (!this.playerReady || this.duration <= 0) return
    this.isLooping = false
    this.start = 0
    this.end = this.duration
    this.updateAllUI()
    this.persistState()
  }

  private seekTo(seconds: number) {
    if (!this.playerReady) return
    this.player.seekTo(seconds, true)
    // Force immediate UI feedback
    this.els.currentTime.textContent = formatTime(seconds, true)
  }

  // ---------- Timeline (simple clickable version + future drag) ----------
  private updateTimeline() {
    const container = this.els.timeline
    if (!container || this.duration <= 0) return

    // Build once
    if (!container.dataset.initialized) {
      container.innerHTML = `
        <div class="timeline-track"></div>
        <div class="timeline-loop" id="timeline-loop-region"></div>
        <div class="timeline-playhead" id="timeline-playhead"></div>
        <div class="timeline-handle start" id="handle-start" title="Drag start point"></div>
        <div class="timeline-handle end" id="handle-end" title="Drag end point"></div>
      `
      container.dataset.initialized = 'true'

      // Click to seek
      container.addEventListener('click', (ev) => {
        const rect = container.getBoundingClientRect()
        const pct = clamp((ev.clientX - rect.left) / rect.width, 0, 1)
        const seekTo = pct * this.duration

        // If loop active, clamp seek inside loop
        if (this.isLooping) {
          this.seekTo(clamp(seekTo, this.start, this.end))
        } else {
          this.seekTo(seekTo)
        }
      })

      // Draggable handles
      this.makeHandleDraggable('handle-start', true)
      this.makeHandleDraggable('handle-end', false)
    }

    const loopRegion = container.querySelector('#timeline-loop-region') as HTMLElement
    const playhead = container.querySelector('#timeline-playhead') as HTMLElement
    const hStart = container.querySelector('#handle-start') as HTMLElement
    const hEnd = container.querySelector('#handle-end') as HTMLElement

    const pct = (t: number) => clamp((t / this.duration) * 100, 0, 100)

    // Loop region
    const left = pct(this.start)
    const width = pct(this.end) - left
    loopRegion.style.left = `${left}%`
    loopRegion.style.width = `${Math.max(width, 0.6)}%`

    // Playhead
    const playPct = pct(this.lastKnownTime)
    playhead.style.left = `${playPct}%`

    // Handles
    hStart.style.left = `${left}%`
    hEnd.style.left = `${pct(this.end)}%`

    // Labels
    this.els.timelineLabels.querySelector('#timeline-start-label')!.textContent = formatTime(this.start)
    this.els.timelineLabels.querySelector('#timeline-end-label')!.textContent = formatTime(this.end)
  }

  private makeHandleDraggable(handleId: string, isStart: boolean) {
    const container = this.els.timeline
    const handle = container.querySelector('#' + handleId) as HTMLElement

    let dragging = false

    const onPointerMove = (ev: PointerEvent) => {
      if (!dragging || this.duration <= 0) return

      const rect = container.getBoundingClientRect()
      let pct = (ev.clientX - rect.left) / rect.width
      pct = clamp(pct, 0, 1)
      const seconds = pct * this.duration

      if (isStart) {
        const newStart = clamp(seconds, 0, this.end - 0.15)
        if (Math.abs(newStart - this.start) > 0.02) {
          this.start = newStart
          this.updateInputs()
          this.updateTimeline()
        }
      } else {
        const newEnd = clamp(seconds, this.start + 0.15, this.duration)
        if (Math.abs(newEnd - this.end) > 0.02) {
          this.end = newEnd
          this.updateInputs()
          this.updateTimeline()
        }
      }
    }

    const onPointerUp = () => {
      if (!dragging) return
      dragging = false
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      this.persistState()
    }

    handle.addEventListener('pointerdown', (ev) => {
      dragging = true
      document.body.style.cursor = 'ew-resize'
      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp, { once: true })
      ev.preventDefault()
    })

    // Touch friendly
    handle.addEventListener('touchstart', () => {
      document.body.style.cursor = 'ew-resize'
    }, { passive: true })
  }

  private updateInputs() {
    this.els.startInput.value = formatTime(this.start, false)
    this.els.endInput.value = formatTime(this.end, false)
  }

  private updateLoopToggleUI() {
    const btn = this.els.loopToggle
    if (this.isLooping) {
      btn.textContent = 'LOOP ON'
      btn.className = 'px-5 py-1 text-xs font-bold rounded-full border transition active:scale-95 bg-emerald-500 text-emerald-950 border-emerald-400'
    } else {
      btn.textContent = 'LOOP OFF'
      btn.className = 'px-5 py-1 text-xs font-bold rounded-full border transition active:scale-95 bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
    }
    this.updateRestartButtonUI()
  }

  private updateRestartButtonUI() {
    const btn = this.els.restartLoop
    if (!btn) return
    const spans = btn.querySelectorAll('span')
    if (spans.length >= 2) {
      spans[1].textContent = this.isLooping ? 'Restart Loop' : 'Restart'
    } else {
      btn.textContent = this.isLooping ? '↺ Restart Loop' : '↺ Restart'
    }
  }

  private updateAllUI() {
    this.updateInputs()
    this.updateLoopToggleUI()
    this.updateSpeedUI()
    this.updateTimeline()
    this.els.currentTime.textContent = formatTime(this.lastKnownTime, true)
    this.els.videoDuration.textContent = this.duration ? `• ${formatTime(this.duration)}` : ''

    // Presets
    this.renderPresets()
  }

  // ---------- Presets ----------
  private renderPresets() {
    const list = this.els.presetsList
    const hint = this.els.noPresetsHint

    list.innerHTML = ''

    if (this.presets.length === 0) {
      hint.classList.remove('hidden')
      return
    }
    hint.classList.add('hidden')

    this.presets.forEach((preset, index) => {
      const el = document.createElement('div')
      el.className = `preset-item ${this.isCurrentLoop(preset) ? 'active' : ''}`

      el.innerHTML = `
        <div class="flex-1 min-w-0">
          <div class="preset-name">${preset.name}</div>
          <div class="preset-time">${formatTime(preset.start)} — ${formatTime(preset.end)}</div>
        </div>
        <div class="preset-actions">
          <button data-action="load" class="px-2 py-1 text-emerald-400 hover:text-emerald-300" title="Load this loop">→</button>
          <button data-action="delete" class="px-1.5 py-1 text-rose-400/70 hover:text-rose-400" title="Delete">×</button>
        </div>
      `

      // Click whole row loads (except action buttons)
      el.addEventListener('click', (ev) => {
        const target = ev.target as HTMLElement
        if (target.closest('button')) return
        this.loadPreset(preset)
      })

      el.querySelector('[data-action="load"]')?.addEventListener('click', (e) => {
        e.stopPropagation()
        this.loadPreset(preset)
      })

      el.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
        e.stopPropagation()
        if (confirm(`Delete "${preset.name}"?`)) {
          this.presets.splice(index, 1)
          this.renderPresets()
          this.persistState()
        }
      })

      list.appendChild(el)
    })
  }

  private isCurrentLoop(preset: LoopPreset): boolean {
    return Math.abs(preset.start - this.start) < 0.3 && Math.abs(preset.end - this.end) < 0.3
  }

  private loadPreset(preset: LoopPreset) {
    this.start = preset.start
    this.end = preset.end
    this.updateAllUI()
    this.persistState()

    if (this.playerReady) {
      this.seekTo(this.start)
      if (this.isLooping) {
        setTimeout(() => this.player?.playVideo(), 40)
      }
    }
  }

  private saveCurrentAsPreset() {
    if (this.duration <= 0) return

    const defaultName = `Loop ${formatTime(this.start)}–${formatTime(this.end)}`
    const name = prompt('Name this loop section:', defaultName)
    if (!name) return

    const newPreset: LoopPreset = {
      id: generateId(),
      name: name.trim(),
      start: this.start,
      end: this.end,
    }

    this.presets = this.presets.filter(p => 
      !(Math.abs(p.start - newPreset.start) < 0.2 && Math.abs(p.end - newPreset.end) < 0.2)
    )
    this.presets.unshift(newPreset)

    this.renderPresets()
    this.persistState()
  }

  private persistState() {
    if (!this.currentVideoId) return

    saveVideoState(this.currentVideoId, {
      start: this.start,
      end: this.end,
      isLooping: this.isLooping,
      playbackRate: this.playbackRate,
      presets: this.presets,
    })
  }

  // ---------- Keyboard ----------
  private handleKeyboard(ev: KeyboardEvent) {
    // Only handle shortcuts when in workspace view
    if (this.currentView !== 'workspace') return
    // Don't handle when stem practice mode is active (it has its own handler)
    if (document.getElementById('stem-practice-area')) return
    // Ignore when typing in inputs
    const target = ev.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    switch (ev.key.toLowerCase()) {
      case ' ':
        ev.preventDefault()
        this.togglePlayPause()
        break
      case '[':
        ev.preventDefault()
        this.setStartFromCurrent()
        break
      case ']':
        ev.preventDefault()
        this.setEndFromCurrent()
        break
      case 'l':
        ev.preventDefault()
        this.toggleLoop()
        break
      case 'r':
        ev.preventDefault()
        this.restartLoop()
        break
      case 'escape':
        this.hideShortcuts()
        break
      case '?':
        ev.preventDefault()
        this.showShortcuts()
        break
      case 'arrowleft':
        ev.preventDefault()
        if (this.playerReady) this.seekTo(Math.max(0, this.lastKnownTime - 1))
        break
      case 'arrowright':
        ev.preventDefault()
        if (this.playerReady) this.seekTo(Math.min(this.duration, this.lastKnownTime + 1))
        break
      case '1': this.setPlaybackRate(0.25); break
      case '2': this.setPlaybackRate(0.75); break
      case '3': this.setPlaybackRate(1); break
      case '4': this.setPlaybackRate(1.25); break
      case '5': this.setPlaybackRate(1.5); break
      case '6': this.setPlaybackRate(2); break
      case '-': {
        const next = Math.max(0.25, Math.round((this.playbackRate - 0.05) * 100) / 100)
        this.setPlaybackRate(next)
        break
      }
      case '=':
      case '+': {
        const next = Math.min(2.0, Math.round((this.playbackRate + 0.05) * 100) / 100)
        this.setPlaybackRate(next)
        break
      }
    }
  }

  private showShortcuts() {
    if (this.currentView !== 'workspace') return
    this.els.shortcutsModal.classList.remove('hidden')
    this.els.shortcutsModal.classList.add('flex')
  }

  private hideShortcuts() {
    if (this.currentView !== 'workspace') return
    this.els.shortcutsModal.classList.remove('flex')
    this.els.shortcutsModal.classList.add('hidden')
  }

  // ---------- Google Drive Sync ----------
  private setupDriveSyncButton() {
    const btn = document.getElementById('drive-sync-btn')
    const label = document.getElementById('drive-sync-label')
    if (!btn || !label) return

    // Check initial auth state + attempt auto-login if user was previously signed in
    import('./drive').then(({ isSignedIn, onAuthChange, tryAutoLogin }) => {
      this.updateDriveSyncUI(isSignedIn())
      onAuthChange((signedIn) => this.updateDriveSyncUI(signedIn))

      // Auto-login: silently get a fresh token if user was previously signed in
      if (!isSignedIn()) {
        tryAutoLogin().then(() => {
          if (isSignedIn()) {
            // Refresh cloud data after auto-login
            import('./drive').then(({ fetchCloudSessions, fetchCloudVideoStates }) => {
              fetchCloudSessions().catch(() => {})
              fetchCloudVideoStates().catch(() => {})
              this.renderInitialPreviousStems()
              this.renderInitialRecentVideos()
            })
          }
        }).catch(() => {})
      }
    })

    btn.addEventListener('click', async () => {
      const { isSignedIn, signIn, signOut, fetchCloudSessions } = await import('./drive')

      if (isSignedIn()) {
        // Already signed in — offer sign out
        if (confirm('Sign out from Google Drive sync?')) {
          signOut()
        }
      } else {
        // Sign in
        try {
          label!.textContent = 'Signing in...'
          await signIn()
          // Fetch cloud data after signing in
          await fetchCloudSessions()
          // Also fetch video states so recent videos show cloud copies
          const { fetchCloudVideoStates } = await import('./drive')
          await fetchCloudVideoStates().catch(() => {})
          // Refresh the lists
          this.renderInitialPreviousStems()
          this.renderInitialRecentVideos()
        } catch (err: any) {
          console.error('[drive] Sign-in failed:', err)
          label!.textContent = 'Sign in'
        }
      }
    })
  }

  private updateDriveSyncUI(signedIn: boolean) {
    const label = document.getElementById('drive-sync-label')
    const btn = document.getElementById('drive-sync-btn')
    if (!label || !btn) return

    if (signedIn) {
      label.textContent = 'Synced'
      btn.classList.add('border-emerald-500/40', 'text-emerald-400')
      btn.classList.remove('border-white/10')
    } else {
      label.textContent = 'Sign in'
      btn.classList.remove('border-emerald-500/40', 'text-emerald-400')
      btn.classList.add('border-white/10')
    }
  }

  /**
   * Upload a stem session to Google Drive in the background.
   * Non-blocking — the user can continue using the app while upload happens.
   */
  private async backgroundUploadToCloud(
    meta: import('./stems/persistence').StemSessionMeta,
    stems: Array<{ name: string; buffer: AudioBuffer }>,
  ) {
    try {
      const { isSignedIn, uploadStemSession } = await import('./drive')
      if (!isSignedIn()) return

      console.log('[drive-sync] Starting background upload for:', meta.fileName)
      await uploadStemSession(meta, stems, (p) => {
        // Update a subtle indicator in the UI
        const label = document.getElementById('drive-sync-label')
        if (label) {
          if (p.phase === 'encoding') label.textContent = 'Encoding...'
          else if (p.phase === 'uploading') label.textContent = 'Uploading...'
          else if (p.phase === 'done') label.textContent = 'Synced'
          else if (p.phase === 'error') {
            label.textContent = 'Synced'
            console.warn('[drive-sync]', p.message)
          }
        }
      })
    } catch (err) {
      console.error('[drive-sync] Background upload failed:', err)
      const label = document.getElementById('drive-sync-label')
      if (label) label.textContent = 'Synced'
    }
  }

  // ---------- Global ----------
  private bindGlobalEvents() {
    // Allow pasting a URL anywhere when in workspace and loader is visible (nice UX)
    document.addEventListener('paste', (ev) => {
      if (this.currentView !== 'workspace') return
      if (!this.els?.playerSection) return
      if (this.els.playerSection.classList.contains('hidden')) {
        const text = ev.clipboardData?.getData('text')
        if (text && getYouTubeVideoId(text)) {
          this.els.urlInput.value = text
          this.loadFromInput()
        }
      }
    })

    // Warn before leaving if practicing
    window.addEventListener('beforeunload', (e) => {
      if (this.isLooping && this.playerReady) {
        e.preventDefault()
        e.returnValue = ''
      }
    })
  }
}

// Boot the app
new WebLooper()
console.log('%c[weblooper] Ready — YouTube looper for musicians', 'color:#166534')

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

const DEFAULT_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

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

function saveVideoState(videoId: string, state: Partial<VideoState> & { title?: string }) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const existing = all[videoId] || {}
    all[videoId] = {
      ...existing,
      ...state,
      videoId,
      lastVisited: Date.now(),
      // keep the best title we have seen
      title: state.title || existing.title || undefined,
    }

    // Prune to the most recent 15 videos so localStorage doesn't grow forever
    const entries = Object.values(all) as any[]
    if (entries.length > 15) {
      entries.sort((a: any, b: any) => (b.lastVisited || 0) - (a.lastVisited || 0))
      const keep = entries.slice(0, 15)
      const pruned: any = {}
      keep.forEach((e: any) => { if (e.videoId) pruned[e.videoId] = e })
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned))
      return
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch (e) {
    console.warn('Failed to save state', e)
  }
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
  private duration = 0
  private start = 0
  private end = 0
  private isLooping = false
  private playbackRate = 1
  private presets: LoopPreset[] = []
  private monitorInterval: number | null = null
  private lastKnownTime = 0

  // UI elements (set after render)
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
    this.render()
    this.bindGlobalEvents()
    this.initYouTubeAPI()
    this.setupPremiumNavigation()
  }

  // Smooth scroll navigation + Launch Workspace button for the new beautiful landing
  private setupPremiumNavigation() {
    // Smooth scroll for nav links
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', (e) => {
        const href = (anchor as HTMLAnchorElement).getAttribute('href')
        if (!href || href === '#') return
        const target = document.querySelector(href)
        if (target) {
          e.preventDefault()
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    })

    // "Open Workspace" CTA in header scrolls to the functional area.
    // We explicitly target the input inside the workspace and prevent the browser
    // from auto-scrolling on focus so we don't jump back to the top.
    const launchBtn = document.getElementById('launch-workspace-btn')
    launchBtn?.addEventListener('click', () => {
      const workspace = document.getElementById('workspace')
      if (workspace) {
        workspace.scrollIntoView({ behavior: 'smooth', block: 'start' })

        // Give the smooth scroll time to settle, then focus without letting
        // the browser scroll the focused element (which would jump us back up).
        setTimeout(() => {
          const input = document.querySelector('#loader-section #url-input') as HTMLInputElement | null
          if (input) {
            input.focus({ preventScroll: true })
            input.select()
          }
        }, 900)
      }
    })
  }

  // ---------- Rendering ----------
  private render() {
    const app = document.querySelector<HTMLDivElement>('#app')!
    app.innerHTML = `
      <div class="min-h-screen flex flex-col bg-[#0a0a0b] text-zinc-200">
        <!-- Premium Sticky Header — ultra-stable, zero movement -->
        <header class="border-b border-white/10 bg-[#0a0a0b]/95 backdrop-blur-xl sticky top-0 z-[200]">
          <div class="max-w-[1280px] mx-auto px-6 h-16 flex items-center">
            <!-- Logo (never moves) -->
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

            <!-- Navigation (centered, shrinks gracefully, hidden on mobile) -->
            <nav class="hidden md:flex flex-1 items-center justify-center gap-8 text-sm font-medium">
              <a href="#features" class="nav-link text-zinc-400 hover:text-white transition">Features</a>
              <a href="#how" class="nav-link text-zinc-400 hover:text-white transition">How it works</a>
              <a href="#stems" class="nav-link text-zinc-400 hover:text-white transition">Stems</a>
              <a href="#workspace" class="nav-link text-zinc-400 hover:text-white transition">Workspace</a>
            </nav>

            <!-- Right actions (always pinned to the right, never moves) -->
            <div class="flex-none flex items-center gap-3">
              <button id="shortcuts-btn"
                      class="hidden md:flex items-center gap-2 px-4 py-1.5 text-xs rounded-full border border-white/10 hover:bg-white/5 transition whitespace-nowrap">
                <span>⌨︎ Shortcuts</span>
              </button>
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

            <!-- Strong local protection for the headline (works even if image has busy areas) -->
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
                <input id="url-input"
                       type="text"
                       placeholder="Paste YouTube link or video ID"
                       class="flex-1 bg-black text-lg px-6 py-4 rounded-2xl border border-white/10 focus:border-emerald-500/60 focus:outline-none placeholder:text-zinc-600" />
                <button id="load-btn"
                        class="btn-primary px-8 text-base rounded-2xl font-semibold active:scale-[0.985] transition whitespace-nowrap">
                  START LOOPING
                </button>
              </div>
              <div class="flex items-center justify-center gap-4 mt-4 text-xs">
                <button class="example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://youtu.be/3JZ_2t3oX8s">Guitar riff</button>
                <span class="text-white/20">•</span>
                <button class="example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://www.youtube.com/watch?v=9bZkp7q19f0">Gangnam Style</button>
                <span class="text-white/20">•</span>
                <button class="example-link text-emerald-400/80 hover:text-emerald-400 transition" data-url="https://youtu.be/dQw4w9wgccc">Never Gonna</button>
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
            <!-- Feature 1 -->
            <div class="premium-card group bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden">
              <div class="feature-img h-56" style="background-image: url('${import.meta.env.BASE_URL}brand/looping.jpg')"></div>
              <div class="p-8">
                <div class="font-semibold text-xl tracking-tight">Precision Looping</div>
                <div class="text-zinc-400 mt-3 leading-relaxed">Drag handles, keyboard shortcuts, saved presets. Loop exactly what you need — nothing more, nothing less.</div>
              </div>
            </div>

            <!-- Feature 2 -->
            <div class="premium-card group bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden">
              <div class="feature-img h-56" style="background-image: url('${import.meta.env.BASE_URL}brand/stems.jpg')"></div>
              <div class="p-8">
                <div class="font-semibold text-xl tracking-tight">AI Stem Separation</div>
                <div class="text-zinc-400 mt-3 leading-relaxed">6-stem separation (drums, bass, guitar, piano, vocals, other) runs 100% in your browser using WebGPU. No uploads. No recurring cost.</div>
              </div>
            </div>

            <!-- Feature 3 -->
            <div class="premium-card group bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden flex flex-col">
              <div class="p-8 flex-1">
                <div class="font-semibold text-xl tracking-tight">Practice with Stems</div>
                <div class="text-zinc-400 mt-3 leading-relaxed">Isolate any instrument, slow it down, loop sections, save presets. The ultimate practice environment for learning songs by ear.</div>
                <div class="mt-8 text-xs text-emerald-400/80 flex items-center gap-2">
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
                  <div class="font-medium">Come back anytime</div>
                  <div class="text-zinc-400 mt-1">Everything is saved locally. Your recent videos and stem sessions are one click away on the home screen.</div>
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

        <!-- The actual Workspace (existing powerful tool) -->
        <section id="workspace" class="border-t border-white/10 bg-zinc-950">
          <div class="max-w-[1280px] mx-auto px-6 pt-12 pb-8">
            <div class="flex items-end justify-between mb-6">
              <div>
                <div class="text-emerald-400 text-xs tracking-[3px]">THE TOOL</div>
                <div class="text-3xl font-semibold tracking-tighter">Your Practice Workspace</div>
              </div>
              <div class="text-xs text-zinc-500 max-w-[260px] text-right hidden md:block">
                Everything below is saved locally. Close the tab, come back tomorrow — your loops and stems are still here.
              </div>
            </div>
          </div>

          <!-- Original functional content (kept intact for perfect compatibility) -->
          <div class="max-w-[1280px] mx-auto px-6 pb-16">
            <!-- Loader / URL Input (existing) -->
            <div id="loader-section" class="max-w-[720px] mx-auto">
              <div class="text-center mb-6">
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

            <!-- Main Player UI (existing, kept 100% intact) -->
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
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 0118 0"/><path d="M21 12l-3-3m3 3l-3 3"/></svg>
                  <span>Change video</span>
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
                        <div id="speed-value" class="font-mono text-sm text-emerald-400">1.00×</div>
                      </div>
                      <div id="speed-chips" class="flex flex-wrap gap-1.5"></div>
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
        </section>

        <footer class="border-t border-white/10 py-8 text-center text-xs text-zinc-500">
          Made with focus for musicians who practice seriously.<br>
          Everything stays on your device. No accounts. No limits.
        </footer>
      </div>

      <!-- Shortcuts modal (kept) -->
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
            <div class="text-emerald-400 font-mono">1-6</div><div>Change playback speed</div>
            <div class="text-emerald-400 font-mono">← →</div><div>Nudge playhead ±1s</div>
            <div class="text-emerald-400 font-mono">ESC</div><div>Close this dialog</div>
          </div>
          <div class="text-center mt-6 text-[10px] text-zinc-500">Tip: Use the timeline handles for precise visual adjustment</div>
        </div>
      </div>
    `

    // Cache elements
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

    this.attachUIListeners()
    this.renderSpeedChips()
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

      try {
        await this.startYouTubeStemSeparationForCurrentVideo(this.currentVideoId)
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
            '   yt-dlp -f bestaudio --extract-audio --audio-format opus "https://youtu.be/' + this.currentVideoId + '"\n\n' +
            '2. Then use "Load local audio file (for stems)" with the downloaded file.\n\n' +
            'This gives much better results than browser-based extraction.'
          )
        } else {
          alert(`Failed to separate stems from YouTube:\n\n${message}`)
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

    // If we had a saved loop active, start looping immediately
    if (this.isLooping && this.player) {
      this.seekTo(this.start)
      setTimeout(() => this.player?.playVideo(), 80)
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

    // Check if we have previously separated stems for this YouTube video
    this.tryAttachStemsToCurrentYouTubeVideo(id)
  }

  /**
   * If the user has previously done stem separation for this YouTube videoId,
   * load the stems, mute the YouTube audio, and keep a StemPlayer in sync with the video.
   */
  private async tryAttachStemsToCurrentYouTubeVideo(videoId: string) {
    try {
      const { findStemSessionForYouTubeVideo, loadStemSession } = await import('./stems')
      const sessionMeta = findStemSessionForYouTubeVideo(videoId)

      if (!sessionMeta) {
        // No stems for this video yet — user can still click "Separate Stems" later
        return
      }

      const loaded = await loadStemSession(sessionMeta.id)
      if (!loaded || loaded.stems.length === 0) {
        console.warn('[weblooper] Found stem session metadata for video but failed to load audio data')
        return
      }

      // Mute the YouTube player (we will drive audio from stems)
      if (this.player) {
        try { this.player.mute() } catch {}
      }

      // Create StemPlayer for this video
      const { StemPlayer } = await import('./stems')
      const stemPlayer = new StemPlayer()
      stemPlayer.loadStems(loaded.stems.map(s => ({ name: s.name, buffer: s.buffer })))

      // Store for sync and controls
      ;(this as any).__currentYouTubeStemPlayer = stemPlayer

      // Start stem playback — YouTube audio is muted, stems provide the audio
      stemPlayer.play()

      this.startStemSyncWithYouTubePlayer(stemPlayer)

      // Show the stem mixer below the player
      this.showStemMixerForCurrentYouTubeVideo(stemPlayer)

      console.log('[weblooper] Attached previously separated stems to YouTube video', videoId)

    } catch (err) {
      console.warn('[weblooper] Failed to attach stems to YouTube video', err)
    }
  }

  private startStemSyncWithYouTubePlayer(stemPlayer: any) {
    // Polling sync: keeps stems in lockstep with YouTube player
    // Handles both time drift correction AND play/pause state sync
    const syncInterval = setInterval(() => {
      if (!this.player || !stemPlayer) return

      try {
        const ytState = this.player.getPlayerState?.()
        const YT = window.YT

        if (!YT) return

        const ytIsPlaying = ytState === YT.PlayerState.PLAYING
        const stemsArePlaying = stemPlayer.isPlaying

        // Sync play/pause state
        if (ytIsPlaying && !stemsArePlaying) {
          stemPlayer.play()
        } else if (!ytIsPlaying && stemsArePlaying) {
          stemPlayer.pause()
        }

        // Sync time position (only while playing to avoid jitter when paused)
        if (ytIsPlaying) {
          const ytTime = this.player.getCurrentTime?.()
          if (typeof ytTime === 'number') {
            const stemTime = stemPlayer.getCurrentTime?.() ?? 0
            // Only seek if drift is significant to avoid glitches
            if (Math.abs(ytTime - stemTime) > 0.3) {
              stemPlayer.seek(ytTime)
            }
          }
        }
      } catch (e) {
        // ignore transient errors
      }
    }, 150)

    // Store the interval ID so we can clean it up when unloading the video
    ;(this as any).__stemSyncInterval = syncInterval
  }

  private async showStemMixerForCurrentYouTubeVideo(stemPlayer: any) {
    // For now, create a simple container below the player if it doesn't exist
    let container = document.getElementById('youtube-stem-mixer-container')
    if (!container) {
      container = document.createElement('div')
      container.id = 'youtube-stem-mixer-container'
      container.className = 'max-w-[1100px] mx-auto mt-6'
      this.els.playerSection.parentElement!.appendChild(container)
    }

    container.innerHTML = ''

    const { createStemMixerUI } = await import('./stems')
    createStemMixerUI({ 
      container, 
      player: stemPlayer,
      onClose: () => {
        // For now just leave it — user can hide via other means
      }
    })
  }

  /**
   * Load a YouTube video and attach pre-loaded stems to it.
   * Used when restoring a saved YouTube stem session from the landing page.
   */
  private async loadYouTubeVideoWithStems(
    videoId: string,
    stems: Array<{ name: string; buffer: AudioBuffer }>
  ) {
    // Show the player section, hide the loader
    this.els.loaderSection.classList.add('hidden')
    this.els.playerSection.classList.remove('hidden')

    // Load the YouTube video
    this.loadVideoFromUrl(videoId)

    // Wait for the player to be ready
    await new Promise<void>((resolve) => {
      const checkReady = setInterval(() => {
        if (this.playerReady && this.player) {
          clearInterval(checkReady)
          resolve()
        }
      }, 200)
      // Timeout after 15 seconds
      setTimeout(() => { clearInterval(checkReady); resolve() }, 15000)
    })

    // Mute YouTube audio — stems will provide the audio
    if (this.player) {
      try { this.player.mute() } catch {}
    }

    // Create StemPlayer and attach
    const { StemPlayer } = await import('./stems')
    const stemPlayer = new StemPlayer()
    stemPlayer.loadStems(stems.map(s => ({ name: s.name, buffer: s.buffer })))
    ;(this as any).__currentYouTubeStemPlayer = stemPlayer

    // Start playback and sync
    stemPlayer.play()
    this.startStemSyncWithYouTubePlayer(stemPlayer)
    this.showStemMixerForCurrentYouTubeVideo(stemPlayer)

    console.log('[weblooper] Restored YouTube video with saved stems', videoId)
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

            // If this is a YouTube session, load the video with stems attached
            if (loaded.meta.youtubeVideoId) {
              await this.loadYouTubeVideoWithStems(loaded.meta.youtubeVideoId, loaded.stems)
            } else {
              // Local file — use the audio-only stem practice view
              await this.enterStemPracticeWithRealStems(
                { fileName: loaded.meta.fileName || loaded.meta.youtubeVideoTitle || 'YouTube Video', duration: loaded.meta.duration },
                loaded.stems
              )
            }
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
      const sessions = listStemSessions()

      if (sessions.length === 0) {
        section.classList.add('hidden')
        return
      }

      section.classList.remove('hidden')
      listEl.innerHTML = ''

      sessions.slice(0, 8).forEach((sess) => {
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
            <button class="load-init px-3 py-1 text-xs rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">Load</button>
            <button class="del-init px-2 py-1 text-xs rounded-xl border border-white/10 text-zinc-400 hover:text-rose-400">Delete</button>
          </div>
        `

        row.querySelector('.load-init')?.addEventListener('click', async () => {
          const loaded = await loadStemSession(sess.id)
          if (loaded && loaded.stems.length > 0) {
            this.els.loaderSection.classList.add('hidden')

            // If this is a YouTube session, load the video with stems attached
            if (loaded.meta.youtubeVideoId) {
              await this.loadYouTubeVideoWithStems(loaded.meta.youtubeVideoId, loaded.stems)
            } else {
              // Local file — use the audio-only stem practice view
              await this.enterStemPracticeWithRealStems(
                { fileName: loaded.meta.fileName || loaded.meta.youtubeVideoTitle || 'YouTube Video', duration: loaded.meta.duration },
                loaded.stems
              )
            }
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

        row.querySelector('.del-init')?.addEventListener('click', async () => {
          if (confirm(`Delete saved stems for "${sess.fileName}"?`)) {
            await deleteStemSession(sess.id)
            row.remove()
            if (listEl.children.length === 0) section.classList.add('hidden')
          }
        })

        listEl.appendChild(row)
      })
    } catch (e) {
      console.warn('[weblooper] Could not render initial previous stem sessions', e)
      section?.classList.add('hidden')
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
      const entries = Object.values(all) as any[]
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
  private renderInitialRecentVideos() {
    const section = document.getElementById('initial-recent-videos')
    const listEl = document.getElementById('initial-recent-videos-list')
    if (!section || !listEl) return

    const entries = this.getRecentVideoEntries(10)

    if (entries.length === 0) {
      section.classList.add('hidden')
      return
    }

    section.classList.remove('hidden')
    listEl.innerHTML = ''

    entries.forEach((entry: any) => {
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

      row.innerHTML = `
        <div class="min-w-0">
          <div class="font-medium truncate">${label}</div>
          <div class="text-[10px] text-zinc-500">${meta || 'Previously loaded'}</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button class="load-recent px-3 py-1 text-xs rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">Load</button>
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
   * Start stem separation for a YouTube video that is **already loaded**.
   *
   * This flow FULLY DECOUPLES the resulting stems from the YouTube video:
   * - The normal video UI is replaced by a dedicated blocking card (user cannot touch the video).
   * - Card shows "Recording..." (tab audio capture) then transitions to "Breaking into stems...".
   * - On success we save the stems exactly like local audio (no youtubeVideoId, no relationship).
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
      try {
        const { saveStemSession } = await import('./stems')
        await saveStemSession(
          {
            // Deliberately omit youtubeVideoId / youtubeVideoTitle.
            // This makes the stems first-class citizens exactly like local audio stems.
            fileName: `YouTube — ${ytTitle}`,
            duration: result.decoded.duration,
            stemNames: stemResult.stems.map(s => s.name),
            model: 'demucs-rs htdemucs_6s',
          },
          tracksForPlayer
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
        tracksForPlayer
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
          console.log('[weblooper] Stem session fully persisted (metadata + OPFS audio)', savedId)
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

        this.enterStemPracticeWithRealStems(decoded, tracksForPlayer)
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
    realStems: Array<{ name: string; buffer: AudioBuffer }>
  ) {
    // Reuse most of the previous demo UI code, but feed real stems into StemPlayer
    const stemArea = document.createElement('div')
    stemArea.id = 'stem-practice-area'
    stemArea.className = 'max-w-[1100px] mx-auto'
    this.els.playerSection.parentElement!.appendChild(stemArea)

    const stemTracks = realStems.map(s => ({ name: s.name, buffer: s.buffer }))

    const { StemPlayer } = await import('./stems')
    const stemPlayer = new StemPlayer()
    stemPlayer.loadStems(stemTracks)
    // Default: full track, looping disabled (user can set custom loop region)
    stemPlayer.setLoop(0, decoded.duration)
    stemPlayer.setIsLooping(false)

    // Rich UI with proper loop controls (matching YouTube looper behavior)
    stemArea.innerHTML = `
      <div class="mb-3 flex items-center justify-between">
        <div>
          <div class="text-emerald-400 text-xs tracking-[1.5px] font-semibold">STEM PRACTICE — REAL AI SEPARATION (6 stems)</div>
          <div class="text-2xl font-semibold tracking-tight truncate max-w-[600px]">${decoded.fileName}</div>
        </div>
        <button id="exit-stem-real" class="text-sm px-4 py-2 rounded-2xl border border-white/10 hover:bg-zinc-900">Exit</button>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-6">
        <div>
          <!-- Timeline with draggable loop handles -->
          <div id="stem-timeline-real" class="timeline w-full"></div>
          <div class="flex justify-between text-xs text-zinc-500 mt-1 px-1 font-mono tabular-nums">
            <div id="stem-loop-start-label">0:00</div>
            <div id="stem-time-current-real" class="text-emerald-400 font-medium">0:00</div>
            <div>${formatTime(decoded.duration)}</div>
          </div>

          <!-- Transport + Loop controls (same philosophy as YouTube path) -->
          <div class="flex flex-wrap gap-2 mt-3">
            <button id="stem-play-real" class="flex-1 min-w-[90px] py-3 rounded-2xl bg-white text-zinc-950 font-semibold">PLAY</button>
            <button id="stem-restart-real" class="px-4 py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 font-semibold border border-white/10">↺ Restart</button>

            <button id="stem-loop-toggle-real"
                    class="px-4 py-3 rounded-2xl border text-sm font-bold transition bg-emerald-500/10 border-emerald-500/40 text-emerald-400">LOOP OFF</button>

            <button id="stem-set-start-real" class="px-3 py-3 rounded-2xl border border-white/10 hover:bg-white/5 text-emerald-400 font-mono text-sm" title="Set loop start at current time ( [ )">[ Set Start</button>
            <button id="stem-set-end-real" class="px-3 py-3 rounded-2xl border border-white/10 hover:bg-white/5 text-rose-400 font-mono text-sm" title="Set loop end at current time ( ] )">] Set End</button>

            <button id="stem-full-track-real" class="px-3 py-3 rounded-2xl border border-white/10 hover:bg-white/5 text-xs text-zinc-400">Full track (no loop)</button>
          </div>

          <div class="mt-1 text-[10px] text-zinc-500">Click timeline to seek • Drag green handles to adjust loop region • [ ] L R keys also work</div>
        </div>

        <div id="real-mixer-container"></div>
      </div>

      <div class="mt-6">
        <div class="flex items-center gap-2 text-xs text-zinc-400 mb-2">
          <span class="tracking-widest">SPEED</span>
          <span id="stem-speed-real" class="font-mono text-emerald-400">1.00×</span>
        </div>
        <div id="stem-speed-real-chips" class="flex flex-wrap gap-1.5"></div>
      </div>
    `

    const timeline = document.getElementById('stem-timeline-real')!
    const timeEl = document.getElementById('stem-time-current-real')!
    const playBtn = document.getElementById('stem-play-real')!
    const restartBtn = document.getElementById('stem-restart-real')!
    const loopToggleBtn = document.getElementById('stem-loop-toggle-real')!
    const setStartBtn = document.getElementById('stem-set-start-real')!
    const setEndBtn = document.getElementById('stem-set-end-real')!
    const fullTrackBtn = document.getElementById('stem-full-track-real')!
    const loopStartLabel = document.getElementById('stem-loop-start-label')!

    // Build timeline with handles (same structure as main player)
    timeline.innerHTML = `
      <div class="timeline-track"></div>
      <div class="timeline-loop" id="real-loop-region"></div>
      <div class="timeline-playhead" id="real-playhead"></div>
      <div class="timeline-handle start" id="real-handle-start" title="Drag to set loop start"></div>
      <div class="timeline-handle end" id="real-handle-end" title="Drag to set loop end"></div>
    `

    // Local loop state (mirrors StemPlayer + allows UI to drive it)
    let loopStart = 0
    let loopEnd = decoded.duration
    let isLooping = false

    function applyLoopToPlayer() {
      stemPlayer.setLoop(loopStart, loopEnd)
      stemPlayer.setIsLooping(isLooping)
      updateLoopUI()
    }

    function updateLoopUI() {
      // Toggle button style
      if (isLooping) {
        loopToggleBtn.textContent = 'LOOP ON'
        loopToggleBtn.className = 'px-4 py-3 rounded-2xl border text-sm font-bold transition bg-emerald-500 text-emerald-950 border-emerald-400'
      } else {
        loopToggleBtn.textContent = 'LOOP OFF'
        loopToggleBtn.className = 'px-4 py-3 rounded-2xl border text-sm font-bold transition bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
      }

      // Loop region + handles visual
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

      loopStartLabel.textContent = formatTime(loopStart, true)
    }

    // Initial full track (no loop)
    applyLoopToPlayer()

    // Timeline click = seek (clamp to loop if looping)
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

    // Draggable loop handles (adapted from main player)
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

    // Transport buttons
    playBtn.addEventListener('click', () => stemPlayer.togglePlayPause())
    restartBtn.addEventListener('click', () => stemPlayer.restartFromLoopStart())

    loopToggleBtn.addEventListener('click', () => {
      isLooping = !isLooping
      applyLoopToPlayer()
    })

    setStartBtn.addEventListener('click', () => {
      // Use current playback position
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
      // Also seek to 0 so user immediately hears from the top of the full track
      stemPlayer.seek(0)
    })

    // Speed chips
    const speedChips = document.getElementById('stem-speed-real-chips')!
    const speedLabel = document.getElementById('stem-speed-real')!
    ;[0.5, 0.75, 1, 1.25, 1.5, 2].forEach(s => {
      const b = document.createElement('button')
      b.className = `speed-chip ${s === 1 ? 'active' : ''}`
      b.textContent = s + '×'
      b.onclick = () => { stemPlayer.setPlaybackRate(s); updateSpeed() }
      speedChips.appendChild(b)
    })

    function updateSpeed() {
      const r = stemPlayer.getCurrentPlaybackRate()
      speedLabel.textContent = r.toFixed(2) + '×'
      speedChips.querySelectorAll('button').forEach(btn => {
        const v = parseFloat(btn.textContent!.replace('×',''))
        btn.classList.toggle('active', Math.abs(v - r) < 0.01)
      })
    }

    // Mixer
    const mixerC = document.getElementById('real-mixer-container')!
    const { createStemMixerUI } = await import('./stems')
    createStemMixerUI({ container: mixerC, player: stemPlayer })

    // Listen to StemPlayer for time + transport state
    const unsub = stemPlayer.on((ev) => {
      if (ev.type === 'time') {
        const t = ev.time
        ;(window as any).__currentStemTime = t   // for [Set Start/End] buttons
        timeEl.textContent = formatTime(t, true)

        const ph = document.getElementById('real-playhead') as HTMLElement
        if (ph) ph.style.left = `${(t / decoded.duration) * 100}%`

        // Keep loop region + handles in sync (in case player wrapped inside loop)
        const region = document.getElementById('real-loop-region') as HTMLElement
        const hStart = document.getElementById('real-handle-start') as HTMLElement
        const hEnd = document.getElementById('real-handle-end') as HTMLElement
        if (region && hStart && hEnd) {
          const pct = (x: number) => Math.max(0, Math.min(100, (x / decoded.duration) * 100))
          const left = pct(loopStart)
          const w = Math.max(pct(loopEnd) - left, 0.6)
          region.style.left = `${left}%`
          region.style.width = `${w}%`
          hStart.style.left = `${left}%`
          hEnd.style.left = `${pct(loopEnd)}%`
        }
      }

      if (ev.type === 'play' || ev.type === 'pause') {
        playBtn.textContent = stemPlayer.isCurrentlyPlaying() ? 'PAUSE' : 'PLAY'
      }

      if (ev.type === 'loop-jump') {
        // visual pop if desired
      }
    })

    // Keyboard shortcuts inside real stem mode ( [ ] L R space 1-6 )
    const keyHandler = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement) return
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
          stemPlayer.restartFromLoopStart()
          break
        case '1': stemPlayer.setPlaybackRate(0.5); updateSpeed(); break
        case '2': stemPlayer.setPlaybackRate(0.75); updateSpeed(); break
        case '3': stemPlayer.setPlaybackRate(1); updateSpeed(); break
        case '4': stemPlayer.setPlaybackRate(1.25); updateSpeed(); break
        case '5': stemPlayer.setPlaybackRate(1.5); updateSpeed(); break
        case '6': stemPlayer.setPlaybackRate(2); updateSpeed(); break
      }
    }
    document.addEventListener('keydown', keyHandler, { capture: false })

    // Initial visuals
    updateLoopUI()

    // Exit
    document.getElementById('exit-stem-real')!.addEventListener('click', () => {
      document.removeEventListener('keydown', keyHandler, { capture: false } as any)
      unsub()
      stemPlayer.dispose()
      stemArea.remove()
      this.els.loaderSection.classList.remove('hidden')
      this.reEnableSeparateStemsButton()
    })

    console.log('%c[weblooper] Real stems loaded into StemPlayer (with full loop controls)', 'color:#166534')
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
              ↺ Restart Loop
            </button>
          </div>

          <div class="mt-3 text-xs text-zinc-500">Click timeline to seek • Drag handles coming soon</div>
        </div>

        <!-- Right: Stem Mixer -->
        <div id="stem-mixer-container"></div>
      </div>

      <!-- Speed chips (reuse same speeds) -->
      <div class="mt-6">
        <div class="flex items-center gap-2 text-xs text-zinc-400 mb-2">
          <span class="tracking-widest">SPEED</span>
          <span id="stem-speed-value" class="font-mono text-emerald-400">1.00×</span>
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
    restartBtn.addEventListener('click', () => stemPlayer.restartFromLoopStart())

    // === Speed chips ===
    const speedContainer = document.getElementById('stem-speed-chips')!
    const speedValue = document.getElementById('stem-speed-value')!
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2]

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
          stemPlayer.restartFromLoopStart()
          break
        case '1': stemPlayer.setPlaybackRate(0.5); updateSpeedUI(); break
        case '2': stemPlayer.setPlaybackRate(0.75); updateSpeedUI(); break
        case '3': stemPlayer.setPlaybackRate(1); updateSpeedUI(); break
        case '4': stemPlayer.setPlaybackRate(1.25); updateSpeedUI(); break
        case '5': stemPlayer.setPlaybackRate(1.5); updateSpeedUI(); break
        case '6': stemPlayer.setPlaybackRate(2); updateSpeedUI(); break
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
    this.stopTimeMonitor()
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

    // Clean up stem sync and player
    if ((this as any).__stemSyncInterval) {
      clearInterval((this as any).__stemSyncInterval)
      ;(this as any).__stemSyncInterval = null
    }
    if ((this as any).__currentYouTubeStemPlayer) {
      try { (this as any).__currentYouTubeStemPlayer.dispose?.() } catch {}
      ;(this as any).__currentYouTubeStemPlayer = null
    }
    // Remove stem mixer container
    document.getElementById('youtube-stem-mixer-container')?.remove()

    // Reset timeline so it rebuilds cleanly for next video
    const tl = this.els.timeline
    if (tl) {
      tl.innerHTML = ''
      delete tl.dataset.initialized
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
    this.seekTo(this.start)
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
      case '1': this.setPlaybackRate(0.5); break
      case '2': this.setPlaybackRate(0.75); break
      case '3': this.setPlaybackRate(1); break
      case '4': this.setPlaybackRate(1.25); break
      case '5': this.setPlaybackRate(1.5); break
      case '6': this.setPlaybackRate(2); break
    }
  }

  private showShortcuts() {
    this.els.shortcutsModal.classList.remove('hidden')
    this.els.shortcutsModal.classList.add('flex')
  }

  private hideShortcuts() {
    this.els.shortcutsModal.classList.remove('flex')
    this.els.shortcutsModal.classList.add('hidden')
  }

  // ---------- Global ----------
  private bindGlobalEvents() {
    // Allow pasting a URL anywhere when loader is visible (nice UX)
    document.addEventListener('paste', (ev) => {
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

/**
 * LyricPanel — The main display component for timed lyrics + chords.
 *
 * This is intentionally simple at first. We will evolve it as we learn
 * what actually works while using the real AI output.
 */

import type { LyricTrack } from '../types'

export interface LyricPanelOptions {
  container: HTMLElement
  /** Called when the user clicks "Run in my Colab" */
  onColabRequest?: () => void
  /** Called when the user clicks "Load results from Colab/Drive" */
  onLoadColabResults?: () => void
  /** Called when the user wants to paste their own lyrics */
  onProvideLyricsRequest?: () => void
  /** Called when the user wants to open the editor */
  onEditRequest?: () => void
}

export class LyricPanel {
  private container: HTMLElement
  private track: LyricTrack | null = null
  private currentTime = 0
  private onColabRequest?: () => void
  private onLoadColabResults?: () => void
  private onProvideLyricsRequest?: () => void
  private onEditRequest?: () => void

  private segmentsEl: HTMLElement | null = null

  /** Internal state for live progress updates during generation */
  private isGenerating = false
  private generatingMessageEl: HTMLElement | null = null

  constructor({ container, onColabRequest, onLoadColabResults, onProvideLyricsRequest, onEditRequest }: LyricPanelOptions) {
    this.container = container
    this.onColabRequest = onColabRequest
    this.onLoadColabResults = onLoadColabResults
    this.onProvideLyricsRequest = onProvideLyricsRequest
    this.onEditRequest = onEditRequest
    this.renderEmpty()
  }

  setTrack(track: LyricTrack | null) {
    this.track = track
    this.render()
  }

  getTrack(): LyricTrack | null {
    return this.track
  }

  /** Shows a loading/generating state while AI is running */
  setGenerating(isGenerating: boolean, message = 'Generating lyrics with AI...') {
    this.isGenerating = isGenerating
    this.generatingMessageEl = null

    if (isGenerating) {
      this.container.innerHTML = `
        <div class="bg-zinc-900 border border-amber-500/30 rounded-3xl p-5">
          <div class="flex items-center gap-3">
            <div class="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin"></div>
            <div>
              <div id="lyric-gen-msg" class="text-sm font-medium text-amber-400">${message}</div>
              <div class="text-xs text-zinc-500 mt-1">
                Runs locally in chunks — first run downloads the model.
              </div>
            </div>
          </div>
        </div>
      `
      this.generatingMessageEl = this.container.querySelector('#lyric-gen-msg')
    } else {
      this.render()
    }
  }

  /** Live update of the generating status message (used for download progress etc.) */
  updateGeneratingMessage(message: string) {
    if (this.isGenerating && this.generatingMessageEl) {
      this.generatingMessageEl.textContent = message
    }
  }

  setCurrentTime(time: number) {
    this.currentTime = time
    this.updateActiveSegment()
  }

  private renderEmpty() {
    this.container.innerHTML = `
      <div class="bg-zinc-900 border border-white/10 rounded-3xl p-5">
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="uppercase tracking-[1.5px] text-xs font-semibold text-emerald-400">LYRICS + CHORDS</div>
            <div class="text-sm text-zinc-400 mt-1">No lyrics yet for this session</div>
          </div>
          <div class="flex flex-col gap-2">
            <button id="lyric-colab-btn"
                    class="text-sm px-4 py-2 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition active:bg-blue-700">
              Run in my Colab (free GPU)
            </button>
            <button id="lyric-load-colab-btn"
                    class="text-sm px-4 py-1.5 rounded-2xl border border-blue-500/30 hover:bg-blue-500/10 text-blue-400 text-xs">
              Load results from Colab/Drive
            </button>
            <button id="lyric-provide-btn"
                    class="text-sm px-4 py-2 rounded-2xl border border-white/20 hover:bg-white/5 text-white font-medium transition">
              Use my own lyrics
            </button>
          </div>
        </div>
        <div class="text-[11px] text-zinc-500">
          "Run in my Colab" = one-click: uploads a ready notebook (ID pre-filled) to your Drive and opens it. Switch to GPU + Run all in Colab, then load results here.<br>
          "Use my own lyrics" lets you paste text and aligns it automatically.
        </div>
      </div>
    `

    const colabBtn = this.container.querySelector('#lyric-colab-btn') as HTMLButtonElement | null
    const provideBtn = this.container.querySelector('#lyric-provide-btn') as HTMLButtonElement | null

    colabBtn?.addEventListener('click', () => {
      this.onColabRequest?.()
    })

    const loadColabBtn = this.container.querySelector('#lyric-load-colab-btn') as HTMLButtonElement | null
    loadColabBtn?.addEventListener('click', () => {
      if (this.onLoadColabResults) {
        this.onLoadColabResults();
      } else {
        this.onColabRequest?.();
      }
    })

    provideBtn?.addEventListener('click', () => {
      this.onProvideLyricsRequest?.()
    })
  }

  private render() {
    if (!this.track || this.track.segments.length === 0) {
      this.renderEmpty()
      return
    }

    this.container.innerHTML = `
      <div class="bg-zinc-900 border border-white/10 rounded-3xl p-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="uppercase tracking-[1.5px] text-xs font-semibold text-emerald-400">LYRICS + CHORDS</div>
            <div class="text-xs text-zinc-500 mt-0.5">
              ${this.track.segments.length} segments • ${this.track.metadata.lyricsModel || 'AI generated'}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button id="lyric-colab-regen-btn"
                    class="text-xs px-3 py-1.5 rounded-xl bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/20 text-blue-400">
              Re-process in Colab
            </button>
            <button id="lyric-edit-btn"
                    class="text-xs px-3 py-1.5 rounded-xl border border-white/10 hover:bg-white/5">
              Edit timings
            </button>
          </div>
        </div>

        <div class="mt-1 text-right flex flex-col items-end gap-1">
          <button id="lyric-provide-own-btn"
                  class="text-[11px] text-emerald-400 hover:text-emerald-300 underline">
            Use my own lyrics instead
          </button>
          <button id="lyric-load-colab-existing-btn"
                  class="text-[11px] text-blue-400 hover:text-blue-300 underline">
            Load latest from Colab/Drive
          </button>
        </div>

        <div id="lyric-segments" class="space-y-1 max-h-[320px] overflow-auto pr-1 text-sm">
          <!-- segments rendered here -->
        </div>
      </div>
    `

    this.segmentsEl = this.container.querySelector('#lyric-segments')
    const colabRegenBtn = this.container.querySelector('#lyric-colab-regen-btn') as HTMLButtonElement | null
    const editBtn = this.container.querySelector('#lyric-edit-btn') as HTMLButtonElement | null
    const provideOwnBtn = this.container.querySelector('#lyric-provide-own-btn') as HTMLButtonElement | null

    colabRegenBtn?.addEventListener('click', () => {
      this.onColabRequest?.()
    })

    editBtn?.addEventListener('click', () => {
      this.onEditRequest?.()
    })

    provideOwnBtn?.addEventListener('click', () => {
      this.onProvideLyricsRequest?.()
    })

    const loadExisting = this.container.querySelector('#lyric-load-colab-existing-btn') as HTMLButtonElement | null
    loadExisting?.addEventListener('click', () => {
      if (this.onLoadColabResults) this.onLoadColabResults()
      else this.onColabRequest?.()
    })

    this.renderSegments()
  }

  private renderSegments() {
    if (!this.segmentsEl || !this.track) return

    this.segmentsEl.innerHTML = ''

    this.track.segments.forEach((segment, index) => {
      const el = document.createElement('div')
      el.className = `
        px-3 py-2 rounded-xl border border-white/5 cursor-pointer transition
        hover:border-emerald-500/30
      `
      el.dataset.index = String(index)

      const timeLabel = segment.start != null
        ? `${formatTime(segment.start)}`
        : ''

      el.innerHTML = `
        <div class="flex items-baseline gap-3">
          <div class="text-[10px] font-mono text-emerald-400/70 w-12 shrink-0 tabular-nums">${timeLabel}</div>
          <div class="flex-1 text-zinc-200 leading-snug">${escapeHtml(segment.text)}</div>
        </div>
        ${segment.chords && segment.chords.length > 0 ? `
          <div class="mt-1 pl-12 text-emerald-400 text-xs font-medium">
            ${segment.chords.map(c => c.chord).join('  ')}
          </div>
        ` : ''}
      `

      el.addEventListener('click', () => {
        // TODO: later — seek the player to this segment.start
        console.log('[LyricPanel] Segment clicked:', segment)
      })

      this.segmentsEl!.appendChild(el)
    })

    this.updateActiveSegment()
  }

  private updateActiveSegment() {
    if (!this.segmentsEl) return

    const children = Array.from(this.segmentsEl.children) as HTMLElement[]

    children.forEach((el, index) => {
      const segment = this.track?.segments[index]
      if (!segment) return

      const isActive =
        this.currentTime >= segment.start &&
        (segment.end == null || this.currentTime < segment.end)

      el.classList.toggle('bg-emerald-500/10', isActive)
      el.classList.toggle('border-emerald-500/40', isActive)
      el.classList.toggle('border-white/5', !isActive)
    })
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
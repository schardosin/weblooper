/**
 * Stem Mixer UI — Renders a beautiful per-stem mixer panel.
 * Pure DOM + Tailwind, matching weblooper's existing aesthetic.
 */

import type { StemPlayer } from './stem-player'

export interface MixerOptions {
  container: HTMLElement
  player: StemPlayer
  onClose?: () => void
}

export function createStemMixerUI({ container, player, onClose }: MixerOptions) {
  container.innerHTML = `
    <div class="bg-zinc-900 border border-white/10 rounded-3xl p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <div class="uppercase tracking-[1.5px] text-xs font-semibold text-emerald-400">STEM MIXER</div>
          <div class="text-[10px] text-zinc-500">All processing in your browser</div>
        </div>
        <div class="flex items-center gap-2">
          <button id="mixer-reset" class="text-xs px-3 py-1 rounded-xl border border-white/10 hover:bg-white/5">Reset Mix</button>
          <button id="mixer-close" class="text-xs px-3 py-1 rounded-xl border border-white/10 hover:bg-white/5 text-zinc-400">× Close</button>
        </div>
      </div>

      <div id="stem-rows" class="space-y-3"></div>

      <div class="mt-4 pt-4 border-t border-white/10 text-[11px] text-zinc-500 flex items-center gap-2">
        <span>Solo a stem to hear it alone. Mute to remove it from the mix.</span>
      </div>
    </div>
  `

  const rowsContainer = container.querySelector('#stem-rows')!
  const states = player.getStemStates()

  states.forEach(state => {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-3 bg-zinc-950 rounded-2xl px-4 py-3 border border-white/5'
    row.innerHTML = `
      <div class="w-24 shrink-0 font-medium text-sm truncate">${state.name}</div>

      <div class="flex-1 flex items-center gap-3">
        <!-- Volume slider -->
        <input type="range"
               class="stem-fader flex-1 accent-emerald-500"
               min="0" max="2" step="0.01" value="${state.gain}" />

        <div class="w-10 font-mono text-xs text-right tabular-nums text-emerald-400">
          ${state.gain.toFixed(1)}×
        </div>
      </div>

      <div class="flex items-center gap-1.5">
        <button data-action="solo" class="stem-btn-solo px-3 py-1 text-[10px] rounded-xl border transition ${state.soloed ? 'bg-emerald-500 text-black border-emerald-400' : 'border-white/10 hover:bg-white/5'}">
          SOLO
        </button>
        <button data-action="mute" class="stem-btn-mute px-3 py-1 text-[10px] rounded-xl border transition ${state.muted ? 'bg-rose-500/80 text-white border-rose-500' : 'border-white/10 hover:bg-white/5'}">
          MUTE
        </button>
      </div>
    `

    const fader = row.querySelector('input') as HTMLInputElement
    const soloBtn = row.querySelector('[data-action="solo"]') as HTMLButtonElement
    const muteBtn = row.querySelector('[data-action="mute"]') as HTMLButtonElement
    const valueLabel = row.querySelector('.font-mono') as HTMLElement

    // Fader
    fader.addEventListener('input', () => {
      const val = parseFloat(fader.value)
      player.setStemGain(state.name, val)
      valueLabel.textContent = val.toFixed(1) + '×'
    })

    // Solo
    soloBtn.addEventListener('click', () => {
      const newSolo = !soloBtn.classList.contains('bg-emerald-500')
      player.setStemSoloed(state.name, newSolo)
      updateRowVisuals()
    })

    // Mute
    muteBtn.addEventListener('click', () => {
      const newMuted = !muteBtn.classList.contains('bg-rose-500/80')
      player.setStemMuted(state.name, newMuted)
      updateRowVisuals()
    })

    function updateRowVisuals() {
      const current = player.getStemStates().find(s => s.name === state.name)!
      soloBtn.classList.toggle('bg-emerald-500', current.soloed)
      soloBtn.classList.toggle('text-black', current.soloed)
      soloBtn.classList.toggle('border-emerald-400', current.soloed)
      soloBtn.classList.toggle('border-white/10', !current.soloed)

      muteBtn.classList.toggle('bg-rose-500/80', current.muted)
      muteBtn.classList.toggle('text-white', current.muted)
      muteBtn.classList.toggle('border-rose-500', current.muted)
      muteBtn.classList.toggle('border-white/10', !current.muted)
    }

    // Keep visuals in sync if something else changes the state
    player.on((e) => {
      if (e.type === 'time') {
        // lightweight sync of visuals (in case solo state changed elsewhere)
        updateRowVisuals()
      }
    })

    rowsContainer.appendChild(row)
  })

  // Reset button
  container.querySelector('#mixer-reset')?.addEventListener('click', () => {
    player.resetMix()
    // Re-render the whole mixer for simplicity
    createStemMixerUI({ container, player, onClose })
  })

  container.querySelector('#mixer-close')?.addEventListener('click', () => {
    onClose?.()
  })
}

# YouTube + Stem Separation: Core Problem & Alternatives

**Status**: Open Technical & UX Problem  
**Last Updated**: 2026

---

## 1. Summary

Weblooper wants to offer high-quality, client-side stem separation for YouTube videos while keeping the video player visible on the same page. The current technical requirements for performant stem separation conflict with the ability to embed the YouTube player.

The fundamental tension is:

> **Cross-origin isolation (required for good stem separation performance) breaks YouTube embeds.**

---

## 2. Background

### Stem Separation Requirements
- Weblooper performs stem separation entirely in the browser using **demucs-rs** (WASM + WebGPU).
- For acceptable performance, the demucs WASM needs `SharedArrayBuffer` and multi-threading.
- To enable `SharedArrayBuffer`, the page must be in a **cross-origin isolated** context. This requires specific HTTP headers:

  ```http
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp   (or credentialless)
  ```

### YouTube Playback Requirements
- The application uses the official YouTube IFrame Player API.
- The player is embedded as an `<iframe>` pointing to `youtube.com/embed/...`.
- The desired experience is: **video stays on screen at all times**, with stem controls appearing below it. Audio can be replaced by the separated stems while remaining perfectly synced to the video.

---

## 3. The Core Conflict

When the isolation headers are active on the main document:

- The browser becomes extremely strict about cross-origin content.
- YouTube’s embed player does not send the required `Cross-Origin-Resource-Policy` headers.
- Result: The YouTube iframe fails to load with errors such as:
  - `www.youtube.com refused to connect`
  - `chrome-error://chromewebdata/`
  - “Domains, protocols and ports must match”

Additionally, attempts to use YouTube’s internal `youtubei` API for audio extraction from the browser frequently return **403 Forbidden**, because YouTube actively blocks non-official clients.

### Current Workarounds and Their Problems

| Approach                          | Problem |
|-----------------------------------|--------|
| Apply isolation headers globally  | Breaks YouTube player for normal use |
| Reload page with `?stems=1`       | Destroys the "same page" experience the user wants |
| Use `credentialless` instead of `require-corp` | Helps a little, but `same-origin` COOP is still usually required for `SharedArrayBuffer` and still breaks embeds in practice |
| Direct `youtubei` fetch for audio | Frequently blocked with 403 from localhost and many origins |

---

## 4. Desired Experience (Requirements)

The user has stated the following goals:

1. **Single page experience** — The YouTube video player remains visible at all times.
2. **Additive stems** — User can watch the video normally, then decide to separate stems. Stems appear below the player.
3. **Audio replacement** — Once stems exist, the audio should come from the stems (not the original YouTube audio), but must stay perfectly synced with the video.
4. **Persistence per video** — Videos that have been stem-separated should remember this state. Opening them later should restore both the video and the stems.
5. **Graceful fallback** — Videos that were only watched (no stems) should still open normally, but allow stem separation to be added later.
6. **Pure browser extraction** (strong preference) — Audio should preferably come from the stream the YouTube player is already receiving, not from external tools.

---

## 5. Possible Alternatives

### A. Accept Reduced Isolation for YouTube Flows
- Only apply full isolation when the user is actually running the stem separation model.
- Keep the main page (with the YouTube player) non-isolated.
- Run the heavy demucs work in a separate isolated context (iframe, dedicated tab, or worker loaded with special headers).

**Pros**
- Preserves the desired single-page experience.
- Normal YouTube usage remains unaffected.

**Cons**
- More complex architecture.
- The stem separation itself may run slower if it cannot easily share memory with the main thread.
- Requires careful orchestration between isolated and non-isolated contexts.

### B. Move Heavy Computation to an Isolated Context
- The main app (including the YouTube player) never becomes cross-origin isolated.
- When stem separation is triggered for a YouTube video:
  - Open the stem separation UI in a new tab or a specially crafted `<iframe>` that has the required COOP/COEP headers.
  - Perform extraction + inference in the isolated context.
  - Send the resulting stems back to the main page (via `postMessage` + `StructuredClone` or OPFS).

**Pros**
- Clean separation of concerns.
- YouTube player is never affected.

**Cons**
- More complex data flow.
- User may perceive it as "leaving the page" even if we use an iframe.
- Requires solving cross-context communication and storage.

### C. Use a Lightweight Local / Dev Proxy (Pragmatic Compromise)
- Keep a small development proxy (or Edge Function in production) that can properly fetch YouTube streams on behalf of the browser.
- The browser still triggers the extraction, but the actual network requests to YouTube go through a controlled origin that can set better headers/cookies.

**Pros**
- Can make direct extraction more reliable.
- Still mostly client-driven.

**Cons**
- Introduces a server component (even if tiny), which goes against the "everything client-side" philosophy.
- Production hosting complexity increases.

### D. Hybrid Audio Approach (Most Practical Today)
- For YouTube videos, the recommended/reliable path is:
  1. User downloads high-quality audio using a tool they trust (yt-dlp, etc.).
  2. User loads the downloaded file via the existing "Local audio file" stem separation flow.
  3. Once stems exist, they can be attached to the YouTube video on the same page (video visible + stems below).
- Direct browser extraction remains as a best-effort / experimental path.

**Pros**
- Most reliable quality and success rate today.
- Reuses all existing stem separation and persistence code.
- Avoids fighting YouTube’s anti-automation systems.

**Cons**
- Not pure "one-click from the browser" for YouTube sources.
- User has to take an extra manual step for YouTube content.

### E. Accept Slower Stem Separation on YouTube
- Run stem separation without full cross-origin isolation when a YouTube video is present.
- Accept that it will be slower (no `SharedArrayBuffer` or reduced threading).
- Keep the page non-isolated so the YouTube player continues to work.

**Pros**
- Simplest to implement.
- Preserves the single-page UX.

**Cons**
- Stem separation performance will be noticeably worse on YouTube videos compared to local files.

---

## 6. Open Questions

- Is full cross-origin isolation strictly required for acceptable stem separation performance on YouTube videos, or can we live with a slower path?
- Are we willing to introduce any server-side component (even a tiny proxy) to make reliable YouTube audio extraction possible?
- How important is it that stem separation for YouTube feels like a single seamless action versus a two-step process (watch video → add stems)?
- Should videos that only have stems (no local audio file) be treated exactly like local stem sessions in the "Previous Separations" list?

---

## 7. Next Steps

This document exists to make the trade-offs explicit so the team can make a deliberate architectural decision rather than continuing to patch around the symptoms.

Recommended next action: Decide on one of the alternatives above (or a new one) and define a clear technical direction before investing more effort into the current extraction + isolation approach.
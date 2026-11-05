# Architecture

```
 toolbar icon / Alt+Shift+M / right-click
              │
              ▼
 background.js (service worker)
   - tabCapture.getMediaStreamId(tab)  ← only allowed right after the user's click
   - creates offscreen.html (reasons: USER_MEDIA, WORKERS)
   - owns the session in chrome.storage.local (segments, speakers, status)
   - REC badge, crash recovery, idle shutdown (20 min) via chrome.alarms
              │ stream id
              ▼
 offscreen.js (offscreen document)
   - getUserMedia(tab) + getUserMedia(mic, echoCancellation)
   - plays the tab back so the user still hears the meeting
   - AudioWorklet at 16 kHz → 4096-sample blocks per stream ("tab" / "me")
              │ postMessage (transferable Float32Array)
              ▼
 engine-worker.js (Web Worker, all models)
   - Silero VAD per stream: 512-sample frames, on 0.3 / off 0.1,
     400 ms min silence, 80 ms pad, 250 ms min speech, 10 s max
     (longer utterances are split at the quietest frame in the last 3 s)
   - ASR: Moonshine base (fallback Whisper base.en), WebGPU (q4 decoder) or WASM (q8)
   - text clean-up: junk phrases, repeat loops, low-diversity output
   - "me" stream → labelled with the user's name; lines that echo the tab are dropped
   - "tab" stream → pyannote segmentation splits clips with a change of speaker →
     WeSpeaker ResNet34 embedding per local speaker → online cosine clustering
     (thresholds: strict 0.55 / normal 0.45 / loose 0.35), capped at the number of
     people in the tab (people count − you). Only clips with 3 s+ of speech may start a
     new voice; a voice is asked about once it has 6 s+ over 2 clips (or 10 s). Look-alike
     voices are merged every 8 lines. At Stop, spherical k-means over the whole meeting
     (seeded from the live voices + k-means++) re-sorts every line; hand-fixed lines anchor
     their voice and never move.
              │ segment { t, dur, text, spk, score }, voice-ready { id }, relabel { merges, map }
              ▼
 background.js → session → sidepanel.js (renders, asks "Who is this?" for voice-ready
                                          voices, line fixes teach the voice back)
```

## Why these choices

- **Offscreen reason is USER_MEDIA, not AUDIO_PLAYBACK.** Chrome closes AUDIO_PLAYBACK documents after 30 seconds without sound, which would unload the model and could cut a quiet meeting.
- **No cross-origin isolation (COEP/COOP).** With it, Chrome refuses tab capture ("Error starting tab capture"). The trade-off is single-threaded WASM, so WebGPU is preferred.
- **Separate mic and tab streams.** The user's own lines need no voice matching, and echo can be detected. Meetily and Meeper mix the streams and lose this.
- **Models run in a worker.** Inference never blocks audio handling or Chrome messaging. This is the same pattern as the transformers.js examples.
- **Count-capped clustering instead of a bare threshold.** In real meetings, short interjections produce noisy fingerprints, so a threshold alone over-splits (one 4-person meeting produced 12 "voices"). Knowing the number of people, waiting for enough speech before asking, and a whole-meeting re-sort at the end fix this. `test/diarization.test.mjs` reproduces that meeting's shape: the old logic finds 9 to 13 voices for 3 people, the new one finds 3, with every line right.
- **Biased towards splitting voices (when the count is unknown).** A person asked about twice is fixed with one tap (choosing the same name merges the voices), while two people merged into one would mislabel the transcript silently.
- **Hand-off to Claude.** Prompts up to about 13,500 characters go through `claude://claude.ai/new?q=` (Claude Desktop truncates around 14,000). Longer prompts are put on the clipboard. `open.html` hosts the "Open Claude?" prompt and closes once it has been answered.

## Storage

- `chrome.storage.local`: `settings` (versioned, see `SETTINGS_VERSION` in `src/lib/settings.js`), `session` (the current meeting) and `history` (the last N meetings).
- `chrome.storage.session`: live engine state, the tab marked Ready, and the Google token.
- The Cache API (`transformers-cache`) holds the downloaded models, once per Chrome profile.

## Extension ID

`manifest.json` contains a public `key`, so the extension ID is the same for everyone: `molngpmollhmnghpbbojepobopjippdk`. This keeps the Google OAuth redirect URI stable. The matching private key is not in the repo and is only needed to package a signed `.crx`.

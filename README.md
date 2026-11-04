# MeetNotes

A Chrome extension that records a meeting running in a Chrome tab (Sevv, Google Meet, Zoom web), transcribes it **on your own computer**, tells the voices apart, and hands the transcript to **Claude** for notes.

- **No bot joins the call.** MeetNotes records the meeting tab plus your microphone.
- **Audio never leaves your machine.** Speech-to-text and voice matching run in the browser. Only the text transcript goes to Claude, and only when you open it there.
- **Works with a normal Claude account.** "Open in Claude" starts a new chat in the Claude desktop app with the transcript ready. A Claude API mode (fully automatic) is optional.

## Install (for everyone)

1. Download the latest `MeetNotes-x.y.z.zip` from this repo's **Releases** page.
2. Unzip it somewhere permanent, for example `Documents/MeetNotes`.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the unzipped `MeetNotes` folder.
4. Follow the two-minute setup that opens.

The user guide is in [docs/USER_GUIDE.md](docs/USER_GUIDE.md), and the same text ships inside the zip as `README.md`.

**Updating:** unzip the new release over the same folder, then click the reload icon on the MeetNotes card in `chrome://extensions`. Your settings and past meetings are kept.

## Develop

Requirements: Node 20+ and Chrome 116+.

```bash
npm ci --ignore-scripts   # skips onnxruntime-node's native download (not used by the browser build)
npm run build             # builds dist/  -> load it unpacked in chrome://extensions
npm test                  # unit tests (voice clustering, chunking, transcript clean-up)
```

End-to-end tests drive the built extension in Chromium with Playwright:

```bash
npx playwright install chromium
npm run test:e2e
```

The models are downloaded from Hugging Face at runtime. Where Hugging Face is blocked, the e2e tests still check the UI, the wiring and the error handling, but not real transcription.

## Release

1. Bump `version` in `package.json`. The build copies it into the extension manifest.
2. Commit, then tag and push:

   ```bash
   git tag v2.2.1 && git push origin v2.2.1
   ```

3. The **Release** workflow builds, tests and publishes `MeetNotes-2.2.1.zip` on the Releases page.

## How it works

The short version is below. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the details.

| Part | File | What it does |
|---|---|---|
| Service worker | `src/background.js` | Handles the icon click, grabs the tab's audio (Chrome only allows this right after the click), and keeps session state, history and crash recovery. |
| Offscreen document | `src/offscreen.js` | Holds the tab audio and the mic as two separate streams, plays the tab back so you still hear it, and shows level meters. |
| Engine worker | `src/engine-worker.js` | Runs all the models. Silero voice detection cuts speech into utterances, Moonshine (or Whisper) transcribes them, pyannote finds speaker changes inside a clip, WeSpeaker produces voice fingerprints, and online clustering groups them into speakers. |
| Side panel | `src/sidepanel.*` | The UI: Ready, recording, "Who is speaking?", transcript fixes, and Open in Claude. |
| Setup | `src/setup.*` | First-run wizard: name, pin, mic, one-time model download with a speed test, and the Claude app link. |
| Settings | `src/options.*` | Basics, plus an Advanced section: Claude API, Slack webhook, Google Drive and Docs, prompts. |

## Privacy and data

- Transcripts, notes and settings are stored in the user's own Chrome profile (`chrome.storage.local`). Nothing is sent to any MeetNotes server; there isn't one.
- Optional integrations (Claude API, Slack webhook, Google Drive) are off by default and use each user's own credentials.
- Tell participants you're taking AI notes, and get consent before recording interviews.

## Credits

The design borrows from these open-source projects, read for reference. No code was copied.

- [Meetily](https://github.com/Zackriya-Solutions/meetily): VAD parameters, splitting at the quietest point, hallucination filtering, onboarding flow.
- [Meeper](https://github.com/serg-plusplus/meeper): tab capture, launch from shortcut and context menu, crash recovery.
- [transformers.js examples](https://github.com/huggingface/transformers.js-examples): Moonshine, Silero and WebGPU setup.

Third-party libraries and models are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).

# MeetNotes

Record a meeting running in a Chrome tab (Sevv, Google Meet, Zoom web), transcribe it on your Mac, tell the voices apart, and hand the notes to Claude.

## Install (once)

1. Unzip this folder somewhere permanent, for example `Documents/MeetNotes`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.
3. The **setup** page opens by itself. It takes about two minutes:
   1. Your name
   2. Pin the MeetNotes icon
   3. Allow the microphone
   4. Download the speech engine (about 150 MB, only once) and run a speed test
   5. Connect the Claude app (tick **Always allow** when Chrome asks)

If you're updating from an older version, reload the extension in `chrome://extensions`. Setup opens once so the new speech engine can download.

## Every meeting

1. Join the meeting in a Chrome tab.
2. Click the **MeetNotes icon** (or press **Alt+Shift+M**). The panel shows **Ready**.
3. Add who's there (tap recent names) and check **How many people, including you?**. It fills in from the names you add. Then press **Start recording**.
4. MeetNotes asks **"Who is this?"** only once it has heard enough of a voice to be sure it's a different person, so short "yeah"s and "this is good"s don't trigger questions. Tap their name once. With the people count set, it never makes more voices than people, and you can change the count with − / + while recording.
   - **Wrong name on a line?** Tap the line and pick who really said it. That line stays fixed, and MeetNotes learns the voice.
   - When you press **Stop**, MeetNotes re-sorts every line against the settled voices, so early or short lines that went to the wrong voice get the right name.
5. Press **Stop**, then **Open in Claude**. A new chat opens in the Claude app with the transcript and your notes style. Press Enter.
6. Optional: to keep the notes in MeetNotes (for the .md, Slack and Google Doc buttons), click **Keep Claude's notes here**, copy Claude's reply, click the box and press Cmd+V. It saves by itself.

Meetings up to about 15 minutes open fully prefilled in Claude. For longer ones, the transcript is on your clipboard, so press Cmd+V in the new chat.

## Good to know

- **How it listens:** a voice detector (Silero, the same one Meetily and the transformers.js examples use) cuts speech into sentences, so the speech model only works on real speech. Long monologues are split at the quietest moment, not mid-word. Common speech-recognition junk ("thanks for watching", repeated words) is filtered out.
- **Speed:** Moonshine runs on your Mac's graphics chip where possible, in a background worker so the recording never stutters. The engine loads when you open the panel and stays loaded for 20 minutes after a meeting, so back-to-back meetings start instantly.
- **Level meters:** while recording, two small bars show sound from the meeting and from you. If the meeting stays silent for 30 seconds, MeetNotes warns you.
- **Interrupted recordings:** if Chrome closes mid-meeting, the transcript so far is kept and shown next time.
- **Without headphones:** your mic is cleaned with echo cancellation, and lines the mic picks up from your speakers are dropped.
- **Voice matching:** if MeetNotes asks about the same person twice, set Settings > Voice matching to **Loose**. If it mixes two people up, set it to **Strict**. To tune it, turn on "Show the voice-match score" in Settings: each line then shows how closely it matched (1.00 is identical).
- **If the voice model can't run,** the panel says "Voice naming is off" with the reason, instead of quietly putting everyone under one name.
- **Privacy:** audio never leaves your Mac. Only the text transcript goes to Claude, when you open it there.

## Settings

The main settings are your name, default notes style, Claude app or browser, mic on or off, and voice naming.

**Advanced** contains:

- Claude API mode (fully automatic notes, about US$0.05 per meeting hour)
- Slack webhook
- Google Drive transcripts and Google Docs
- Prompts
- Speech model choice

### Google connection (Advanced, optional)

1. In Google Cloud Console, enable the **Google Drive API**.
2. Create an OAuth client of type **Web application**.
3. Add this redirect URI: `https://molngpmollhmnghpbbojepobopjippdk.chromiumapp.org/`
4. Paste the client ID into Settings > Advanced.

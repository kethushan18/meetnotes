// Default settings and helpers. Everything is stored in chrome.storage.local.

export const DEFAULT_TEMPLATES = [
  {
    id: 'general',
    name: 'General meeting',
    prompt: `Write clear meeting notes in Markdown with these sections:
## Summary
3 to 5 sentences on what the meeting was about and what was decided.
## Key discussion points
Bullets grouped by topic.
## Decisions
Bullets. Write "None recorded" if there were none.
## Action items
A checklist: "- [ ] Owner: task (due date if mentioned)". Use "Unassigned" when no owner was named.
## Open questions
Anything left unresolved.`
  },
  {
    id: 'one-on-one',
    name: '1:1',
    prompt: `Write 1:1 meeting notes in Markdown with these sections:
## Summary
## Wins and progress
## Challenges and blockers
## Wellbeing and engagement signals
Only what was said explicitly. Do not speculate.
## Development and growth
## Agreed next steps
A checklist with owner and timing.
## Topics for next 1:1`
  },
  {
    id: 'interview',
    name: 'Interview',
    prompt: `Write structured interview notes in Markdown with these sections:
## Candidate overview
Role discussed, background summary.
## Experience and skills evidenced
Bullets, each backed by what the candidate said.
## Motivation and fit
## Questions the candidate asked
## Practical details
Notice period, salary expectations, location, availability, if mentioned.
## Strengths
## Concerns or areas to probe further
## Recommended next step
Base everything strictly on the transcript. Do not invent scores.`
  },
  {
    id: 'team-sync',
    name: 'Team sync / L10',
    prompt: `Write team sync notes in Markdown with these sections:
## Summary
## Updates by person
## Issues discussed (Identify, Discuss, Solve)
For each issue: the issue, the discussion in one or two lines, the solution.
## Decisions
## To-dos
A checklist: "- [ ] Owner: task (due date)".
## Parked items`
  }
];

export const DEFAULT_SLACK_PROMPT = `Turn these meeting notes into a short Slack message.
Format rules (Slack mrkdwn, not Markdown):
- First line: *<Meeting title>* followed by the date.
- Use *bold* for section labels, "•" for bullets, no # headings, no tables.
- Sections: *TL;DR* (1 to 2 lines), *Decisions*, *Action items* (owner first), *Next steps*.
- Skip empty sections. Keep it under 150 words.
Return only the message text.`;

export const DEFAULT_SYSTEM_PROMPT = `You turn raw meeting transcripts into accurate, useful notes.
The transcript was produced by automatic speech recognition, so expect misheard words, missing punctuation and occasional repeated lines.
Speaker names were assigned by matching voices, so they can occasionally be wrong. "Speaker N" means a voice nobody named. The recorder's own lines come from their microphone.
If the same sentence appears twice from different speakers at the same moment, it is echo; count it once.
Only use information present in the transcript. Never invent facts, names, numbers or commitments; if unsure, leave it out.
If a section has nothing relevant, write "None noted."
For each action item, add the [mm:ss] timestamp where it was agreed.
Write in British English. Do not use em dashes.`;

export const DEFAULTS = {
  // 'claudeai' = hand the transcript to your own Claude account (no API cost)
  // 'api'      = write notes automatically with the Claude API
  notesEngine: 'claudeai',
  apiKey: '',
  model: 'claude-sonnet-5-5',
  maxTokens: 4000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  templates: DEFAULT_TEMPLATES,
  defaultTemplateId: 'general',
  slackPrompt: DEFAULT_SLACK_PROMPT,
  myName: '',

  // Transcription
  asrModel: 'onnx-community/moonshine-base-ONNX', // fast; falls back to Whisper if it can't load
  fallbackModel: 'onnx-community/whisper-base.en',
  recordMic: true,           // your voice from the microphone, labelled with your name
  voiceNaming: true,         // detect different voices in the meeting and ask who they are
  voiceMatch: 'normal',      // 'strict' | 'normal' | 'loose'
  speakerModel: 'onnx-community/wespeaker-voxceleb-resnet34-LM',
  maxChunkSec: 10,             // longest utterance before splitting at the quietest point (pyannote works on 10 s windows)
  minChunkSec: 2,
  silenceThreshold: 0.008,

  // Opening notes
  openIn: 'app',             // 'app' = Claude desktop app, 'web' = claude.ai in the browser

  // Setup state
  setupDone: false,
  engineReady: null,         // { model, device, speedX, at } written by setup
  recentNames: [],
  showVoiceScores: false,    // show the voice-match score next to each line (for tuning)
  lastPeopleCount: 0,        // remembered for the next meeting

  // Output destinations
  autoGenerate: true,        // write notes as soon as recording stops
  out_includeTranscript: true, // append full transcript to .md and Google Doc
  out_panel: true,           // always shown, kept for clarity
  out_markdown: true,        // show "Download .md" button
  out_markdownAuto: false,   // download automatically after notes are generated
  out_slack: true,           // generate a Slack summary
  out_slackWebhook: '',      // optional Incoming Webhook URL
  out_slackAutoPost: false,  // post automatically after generation
  out_gdoc: false,           // enable Google Doc export
  out_gdocAuto: false,       // create automatically after generation
  gdocClientId: '',          // Google OAuth client ID (Web application type)
  gdocFolderId: '',          // optional Drive folder ID
  out_drive: false,          // save the transcript to Google Drive for Claude to read
  out_driveAuto: true,       // save it automatically when recording stops
  driveFolderId: '',         // created automatically ("MeetNotes Transcripts") if empty

  historyLimit: 30,
  v: 4
};

const SETTINGS_VERSION = 4;
// Keys whose defaults changed; old saved values are dropped so the new defaults apply.
const RESETS = {
  2: ['whisperModel', 'captureMode', 'maxChunkSec', 'minChunkSec', 'systemPrompt'],
  3: ['systemPrompt', 'voiceMatch', 'maxChunkSec'],
  4: ['voiceMatch', 'maxChunkSec']
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  let saved = stored.settings || {};
  if ((saved.v || 1) < SETTINGS_VERSION) {
    const micOff = saved.captureMode === 'tab';
    saved = { ...saved, v: SETTINGS_VERSION };
    for (let v = (stored.settings?.v || 1) + 1; v <= SETTINGS_VERSION; v++) for (const k of RESETS[v] || []) delete saved[k];
    if (micOff) saved.recordMic = false;
    await chrome.storage.local.set({ settings: saved });
  }
  return { ...DEFAULTS, ...saved };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

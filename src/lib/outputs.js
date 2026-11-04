// Output destinations: Markdown file, Slack webhook, Google Doc.
import { marked } from 'marked';
import { transcriptText } from './claude.js';

export function safeFileName(s) {
  return (s || 'Meeting').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function fullMarkdown(session, settings) {
  const d = new Date(session.startedAt);
  const dateStr = d.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  const mins = session.endedAt ? Math.max(1, Math.round((session.endedAt - session.startedAt) / 60000)) : null;
  const meta = [dateStr, mins ? `${mins} min` : null, session.attendees ? `Attendees: ${session.attendees}` : null]
    .filter(Boolean)
    .join(' · ');
  let md = `# ${session.title}\n\n_${meta}_\n\n${session.notes || ''}\n`;
  if (settings.out_includeTranscript && session.segments?.length) {
    md += `\n---\n\n## Full transcript\n\n${transcriptText(session, settings.myName)
      .split('\n')
      .map((l) => l + '  ')
      .join('\n')}\n`;
  }
  return md;
}

export async function downloadMarkdown(session, settings) {
  const md = fullMarkdown(session, settings);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const date = new Date(session.startedAt).toISOString().slice(0, 10);
  await chrome.downloads.download({
    url,
    filename: `MeetNotes/${date} ${safeFileName(session.title)}.md`,
    saveAs: false,
    conflictAction: 'uniquify'
  });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function postToSlack(webhookUrl, text) {
  if (!/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) throw new Error('The Slack webhook URL should start with https://hooks.slack.com/');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(`Slack returned ${res.status}: ${await res.text()}`);
}

// ---------- Google Docs ----------

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

async function googleToken(clientId, interactive = true) {
  const { gtoken } = await chrome.storage.session.get('gtoken');
  if (gtoken && gtoken.clientId === clientId && gtoken.expires > Date.now() + 60000) return gtoken.token;

  if (!clientId) throw new Error('Add a Google OAuth client ID in Settings to use Google Doc or Drive export.');
  const redirect = chrome.identity.getRedirectURL();
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'token',
      redirect_uri: redirect,
      scope: GOOGLE_SCOPE,
      include_granted_scopes: 'true'
    });
  const result = await chrome.identity.launchWebAuthFlow({ url, interactive });
  const params = new URLSearchParams(new URL(result).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new Error('Google sign-in did not return a token: ' + (params.get('error') || 'unknown error'));
  const expires = Date.now() + Number(params.get('expires_in') || 3600) * 1000;
  await chrome.storage.session.set({ gtoken: { token, expires, clientId } });
  return token;
}

async function driveFetch(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (res.status === 401) {
    await chrome.storage.session.remove('gtoken');
    throw new Error('Google session expired. Click the button again to sign in.');
  }
  if (!res.ok) throw new Error(`Google Drive error ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Uploads HTML and lets Drive convert it into a Google Doc. Returns the doc URL. */
async function uploadAsGoogleDoc(token, name, html, parentId) {
  const metadata = { name, mimeType: 'application/vnd.google-apps.document' };
  if (parentId) metadata.parents = [parentId.trim()];
  const boundary = 'meetnotes' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
  const j = await driveFetch(
    token,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
  );
  return j.webViewLink || `https://docs.google.com/document/d/${j.id}/edit`;
}

const mdToHtml = (md) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${marked.parse(md)}</body></html>`;

export async function createGoogleDoc(session, settings) {
  const token = await googleToken(settings.gdocClientId);
  const date = new Date(session.startedAt).toISOString().slice(0, 10);
  return uploadAsGoogleDoc(token, `${date} ${session.title}`, mdToHtml(fullMarkdown(session, settings)), settings.gdocFolderId);
}

export const TRANSCRIPT_FOLDER_NAME = 'MeetNotes Transcripts';

/** Finds or creates the transcripts folder. Returns its ID. */
async function ensureTranscriptFolder(token, settings) {
  if (settings.driveFolderId) return settings.driveFolderId.trim();
  const { driveFolderAuto } = await chrome.storage.local.get('driveFolderAuto');
  if (driveFolderAuto) {
    try {
      const f = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${driveFolderAuto}?fields=id,trashed&supportsAllDrives=true`);
      if (!f.trashed) return f.id;
    } catch {
      /* folder gone, create a new one */
    }
  }
  const f = await driveFetch(token, 'https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: TRANSCRIPT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  await chrome.storage.local.set({ driveFolderAuto: f.id });
  return f.id;
}

/** Option B: saves the transcript as a Google Doc so Claude can read it with the Drive connector. */
export async function saveTranscriptToDrive(session, transcriptMd, settings) {
  const token = await googleToken(settings.gdocClientId);
  const folderId = await ensureTranscriptFolder(token, settings);
  const d = new Date(session.startedAt);
  const stamp = `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return uploadAsGoogleDoc(token, `Transcript - ${stamp} - ${session.title}`, mdToHtml(transcriptMd), folderId);
}

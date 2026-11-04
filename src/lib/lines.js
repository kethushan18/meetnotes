// Reassigning a single transcript line to a person (used by the panel and the background).
export function assignLine(session, t, text, rawName, myName) {
  const name = rawName.trim();
  const lower = name.toLowerCase();
  const speakers = { ...(session.speakers || {}) };
  let id;
  if (lower === 'me' || (myName && lower === myName.toLowerCase())) {
    id = 'me';
  } else {
    const found = Object.entries(speakers).find(([, sp]) => (sp.name || '').toLowerCase() === lower);
    if (found) id = found[0];
    else {
      id = 'u' + Date.now().toString(36);
      speakers[id] = { label: name, name, sample: text, askedAt: Date.now() };
    }
  }
  const segments = (session.segments || []).map((s) => (s.t === t && s.text === text ? { ...s, spk: id, fixed: true } : s));
  return { speakers, segments, id };
}

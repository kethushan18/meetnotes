// Keeps the session's speaker list in step with the voice engine (pure, so it can be tested).
const isVoice = (id) => id && id !== 'me' && id !== 'others';

/** Adds a silent entry for a voice we haven't seen yet (it's only asked about once it's sure). */
export function ensureSpeakers(speakers, segments) {
  const out = { ...speakers };
  for (const s of segments) if (isVoice(s.spk) && !out[s.spk]) out[s.spk] = { label: '', name: '', sample: s.text, ask: false };
  return out;
}

/** Numbers unnamed voices "Speaker 1, 2, ..." in order of first appearance; drops unused ones. */
export function tidySpeakers(speakers, segments) {
  const order = [];
  for (const s of segments) if (isVoice(s.spk) && !order.includes(s.spk)) order.push(s.spk);
  const out = {};
  let n = 0;
  for (const id of order) {
    const sp = speakers[id] || { name: '', ask: false };
    out[id] = { ...sp, label: `Speaker ${++n}` };
  }
  // Keep named voices even if they currently have no lines (e.g. named, then merged away).
  for (const [id, sp] of Object.entries(speakers)) if (!out[id] && sp.name) out[id] = sp;
  return out;
}

/**
 * Applies the engine's voice merges and (at the end) its full re-sort of lines.
 * Lines the user fixed by hand are never moved. Names follow the voice they belong to.
 */
export function applyRelabel(session, { merges = [], map = null }) {
  let speakers = { ...(session.speakers || {}) };
  const into = {};
  for (const m of merges) {
    into[m.from] = m.into;
    const from = speakers[m.from];
    const to = speakers[m.into] || { name: '', ask: false, sample: '' };
    if (from) {
      speakers[m.into] = {
        ...to,
        name: to.name || from.name,
        ask: to.ask || from.ask,
        sample: (from.sample || '').length > (to.sample || '').length ? from.sample : to.sample
      };
      delete speakers[m.from];
    }
  }
  const follow = (id) => {
    let guard = 0;
    while (into[id] && guard++ < 50) id = into[id];
    return id;
  };
  const segments = (session.segments || []).map((s) => {
    if (!isVoice(s.spk) || s.fixed) return s;
    const spk = map && map[s.t] ? follow(map[s.t]) : follow(s.spk);
    return spk === s.spk ? s : { ...s, spk };
  });
  speakers = ensureSpeakers(speakers, segments);
  return { segments, speakers: tidySpeakers(speakers, segments) };
}

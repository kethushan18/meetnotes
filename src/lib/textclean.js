// Removes speech-recognition junk, following Meetily's clean_repetitive_text
// (whisper_engine.rs), softened so ordinary repeats like "no, no" survive.

const JUNK_PHRASES = [
  'thank you for watching',
  'thanks for watching',
  'like and subscribe',
  'subscribe to the channel',
  'music playing',
  'please subscribe',
  'um um um',
  'uh uh uh',
  'ah ah ah'
];
// Whisper/Moonshine tend to "hear" these in silence or noise.
const SHORT_HALLUCINATIONS = /^(thank you\.?|thanks\.?|you|bye\.?|\.+|okay\.?|so\.?|uh\.?|um\.?)$/i;

export function cleanTranscript(text, voicedSec = 99) {
  let t = (text || '')
    .replace(/\[[^\]]*\]/g, ' ') // [BLANK_AUDIO], [Music]
    .replace(/\((?:music|applause|laughs?|laughter|silence|inaudible|static|noise|coughs?)[^)]*\)/gi, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 2) return '';
  const lower = t.toLowerCase();
  if (JUNK_PHRASES.some((p) => lower.includes(p))) return '';
  if (voicedSec < 1.5 && SHORT_HALLUCINATIONS.test(t)) return '';
  // Long but almost no distinct characters ("aaaaaa...").
  if (t.length > 10 && new Set(lower.replace(/\s/g, '')).size <= 3) return '';

  t = collapseRepeats(t);

  // Mostly the same few words over and over: a decoding loop, not speech.
  const words = t.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (words.length > 8) {
    const repeated = words.length - new Set(words).size;
    if (repeated / words.length > 0.7) return '';
  }
  return t;
}

/** Collapses a word or 2-5 word phrase repeated 3+ times in a row into one copy. */
export function collapseRepeats(text) {
  let words = text.split(' ');
  for (let n = 5; n >= 1; n--) {
    const out = [];
    let i = 0;
    while (i < words.length) {
      const phrase = words.slice(i, i + n);
      const key = norm(phrase);
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && norm(words.slice(i + reps * n, i + (reps + 1) * n)) === key) reps++;
      if (reps >= 3 && key) {
        out.push(...phrase);
        i += reps * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }
  return words.join(' ');
}
const norm = (ws) => ws.join(' ').toLowerCase().replace(/[^a-z0-9' ]/g, '');

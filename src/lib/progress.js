/** Turns transformers.js progress events into one overall percentage. */
export function progressTracker(onPct) {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      onPct(Math.min(100, Math.round((loaded / total) * 100)), total, loaded);
    }
  };
}

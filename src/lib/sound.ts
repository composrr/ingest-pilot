// Short synthesized completion tones — no bundled audio files, so there's nothing to
// ship or path-resolve, and it works identically in design mode. Success is a bright
// rising triad; failure is a lower two-note fall so the operator can tell them apart
// from across the room without looking.
export function playCompletionSound(success: boolean): void {
  try {
    const AudioCtx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      return;
    }
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    // C5-E5-G5 for success; Eb4 -> Bb3 for the "needs review" fall.
    const notes = success ? [523.25, 659.25, 783.99] : [311.13, 233.08];
    const step = success ? 0.12 : 0.2;
    const dur = success ? 0.2 : 0.32;

    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + index * step;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    });

    const total = (notes.length - 1) * step + dur + 0.2;
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, total * 1000);
  } catch {
    // Audio is a nicety; never let it break the delivery flow.
  }
}

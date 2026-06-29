// Design-mode mock for "@tauri-apps/api/event".
// Simulates a realistic backend "ingest-progress" stream (varying throughput,
// occasional stalls, verified-bytes trailing copied-bytes) so the run-screen
// speed chart and Verify gauge can be exercised without a real ingest.
// Other events resolve to a no-op unlisten.
import { designJobState } from "./designJobState";

type EventCallback = (event: { event: string; id: number; payload: any }) => void;

export async function listen(eventName: string, callback: EventCallback): Promise<() => void> {
  if (eventName !== "ingest-progress") {
    return () => {};
  }

  const totalFiles = 8;
  const totalBytes = 14_179_887_082;
  const tickMs = 90;
  const start = performance.now();
  let bytesDone = 0;
  let id = 0;
  // history of {t, bytes} so verified can trail copied by ~700ms
  const history: { t: number; bytes: number }[] = [];

  const interval = setInterval(() => {
    const elapsed = performance.now() - start;
    const seconds = elapsed / 1000;
    // Base ~140 MB/s with a slow sine swell, fast jitter, and periodic stalls.
    const swell = 1 + 0.35 * Math.sin(seconds / 1.7);
    const jitter = 0.85 + 0.3 * Math.sin(seconds * 9.1);
    const stalled = Math.sin(seconds / 2.3) > 0.93; // brief verify-like pauses
    const bytesPerSecond = stalled ? 0 : 140_000_000 * swell * jitter;
    bytesDone = Math.min(totalBytes, bytesDone + (bytesPerSecond * tickMs) / 1000);

    history.push({ t: elapsed, bytes: bytesDone });
    while (history.length > 1 && history[0].t < elapsed - 700) {
      history.shift();
    }
    const verifiedBytes = history[0].bytes; // trails copied by ~700ms

    const done = bytesDone >= totalBytes;
    const fraction = bytesDone / totalBytes;
    const cumulativeBps = elapsed > 0 ? (bytesDone / elapsed) * 1000 : 0;
    callback({
      event: eventName,
      id: id++,
      payload: {
        job_id: designJobState.id || "design-job",
        phase: done ? "Complete" : stalled ? "Verifying" : "Copying",
        current_file: `FX3_67${13 + Math.floor(fraction * totalFiles)}.MP4`,
        files_done: Math.floor(fraction * totalFiles),
        total_files: totalFiles,
        bytes_done: Math.round(bytesDone),
        total_bytes: totalBytes,
        verified_bytes: Math.round(done ? totalBytes : verifiedBytes),
        verified_files: Math.floor((verifiedBytes / totalBytes) * totalFiles),
        elapsed_ms: Math.round(elapsed),
        bytes_per_second: Math.round(cumulativeBps),
        remaining_ms: Math.round((elapsed / Math.max(fraction, 0.01)) * (1 - fraction)),
      },
    });
    if (done) {
      clearInterval(interval);
    }
  }, tickMs);

  return () => clearInterval(interval);
}

export async function emit(): Promise<void> {
  // no-op in design mode
}

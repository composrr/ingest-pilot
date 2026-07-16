// Design-mode mock for "@tauri-apps/api/event".
// Simulates the concurrent multi-destination backend: an "ingest-progress" stream whose
// aggregate fields (varying throughput, occasional stalls, verified trailing copied) drive
// the speed chart + Verify gauge, a populated `destinations[]` array (2 drives advancing
// together at slightly different speeds) that drives the per-destination run-screen rows,
// and periodic "file-verified" events that drive the live per-file integrity feed.
// Other events resolve to a no-op unlisten.
import { designJobState } from "./designJobState";

type EventCallback = (event: { event: string; id: number; payload: any }) => void;

// file-verified subscribers, kept module-level so the ingest-progress simulation loop can
// fan its per-file events out to whichever listener(s) startProgressTracking registered.
const verifiedListeners = new Set<EventCallback>();

// Rotating sample of copied files for the live feed.
const FEED_FILES: { name: string; folder: string; size: number }[] = [
  { name: "FX3_6713.MP4", folder: "Footage", size: 4_823_749_012 },
  { name: "FX3_6714.MP4", folder: "Footage", size: 3_104_882_330 },
  { name: "A009_C011_0701HB.R3D", folder: "Footage", size: 2_018_000_000 },
  { name: "ZOOM0007.WAV", folder: "Audio", size: 188_220_004 },
  { name: "DSC00412.JPG", folder: "Photos", size: 9_220_114 },
  { name: "FX3_6715.MP4", folder: "Footage", size: 5_902_114_771 },
  { name: "ZOOM0008.WAV", folder: "Audio", size: 142_553_120 },
  { name: "DSC00413.JPG", folder: "Photos", size: 8_904_551 },
];

export async function listen(eventName: string, callback: EventCallback): Promise<() => void> {
  if (eventName === "file-verified") {
    verifiedListeners.add(callback);
    return () => verifiedListeners.delete(callback);
  }
  if (eventName !== "ingest-progress") {
    return () => {};
  }

  const perDestTotalBytes = 14_179_887_082;
  const perDestTotalFiles = 8;
  const tickMs = 90;
  const start = performance.now();
  let id = 0;
  let verifiedId = 0;
  let feedCursor = 0;
  let lastFeedEmit = 0;

  // Two destinations copying the SAME files, teed together at slightly different speeds
  // (mirrors the real read-once/write-to-all engine). Each keeps a {t,bytes} history so
  // its verified bytes trail its copied bytes by ~700ms, just like the real verify lag.
  const dests = [
    { index: 0, path: "E:/MediaServer", label: "MediaServer (E:)", factor: 1.0, free: 4_210_000_000_000, bytes: 0, failed: 0, history: [] as { t: number; bytes: number }[] },
    { index: 1, path: "G:/Backup", label: "Backup (G:)", factor: 0.82, free: 1_920_000_000_000, bytes: 0, failed: 0, history: [] as { t: number; bytes: number }[] },
  ];

  const interval = setInterval(() => {
    const elapsed = performance.now() - start;
    const seconds = elapsed / 1000;
    // Base ~140 MB/s with a slow sine swell, fast jitter, and periodic verify-like stalls.
    const swell = 1 + 0.35 * Math.sin(seconds / 1.7);
    const jitter = 0.85 + 0.3 * Math.sin(seconds * 9.1);
    const stalled = Math.sin(seconds / 2.3) > 0.93;
    const baseBps = stalled ? 0 : 140_000_000 * swell * jitter;

    let aggBytesDone = 0;
    let aggVerifiedBytes = 0;
    let aggVerifiedFiles = 0;
    let aggFilesDone = 0;
    let aggBps = 0;
    const destinations = dests.map((dest) => {
      const destBps = baseBps * dest.factor;
      dest.bytes = Math.min(perDestTotalBytes, dest.bytes + (destBps * tickMs) / 1000);
      dest.history.push({ t: elapsed, bytes: dest.bytes });
      while (dest.history.length > 1 && dest.history[0].t < elapsed - 700) {
        dest.history.shift();
      }
      const verifiedBytes = dest.history[0].bytes; // trails copied by ~700ms
      const complete = dest.bytes >= perDestTotalBytes;
      const fraction = dest.bytes / perDestTotalBytes;
      const filesDone = Math.floor(fraction * perDestTotalFiles);
      const verifiedFiles = Math.floor((verifiedBytes / perDestTotalBytes) * perDestTotalFiles);
      const phase = complete ? "Complete" : stalled ? "Verifying" : "Copying";
      const remaining = destBps > 0 ? Math.round(((perDestTotalBytes - dest.bytes) / destBps) * 1000) : null;

      aggBytesDone += dest.bytes;
      aggVerifiedBytes += complete ? perDestTotalBytes : verifiedBytes;
      aggVerifiedFiles += verifiedFiles;
      aggFilesDone += filesDone;
      if (!complete) {
        aggBps += destBps;
      }

      return {
        index: dest.index,
        path: dest.path,
        label: dest.label,
        phase,
        bytes_done: Math.round(dest.bytes),
        bytes_total: perDestTotalBytes,
        verified_bytes: Math.round(complete ? perDestTotalBytes : verifiedBytes),
        verified_files: verifiedFiles,
        failed_files: dest.failed,
        bytes_per_second: Math.round(destBps),
        remaining_ms: remaining,
        free_space_bytes: dest.free,
      };
    });

    const totalBytes = perDestTotalBytes * dests.length;
    const totalFiles = perDestTotalFiles * dests.length;
    const allComplete = dests.every((dest) => dest.bytes >= perDestTotalBytes);
    // Headline phase/current_file tracks the laggard drive (matches the Rust aggregator).
    const laggard = destinations.reduce((slow, dest) => (dest.bytes_done < slow.bytes_done ? dest : slow), destinations[0]);
    const remainingMs = aggBps > 0 ? Math.round(((totalBytes - aggBytesDone) / aggBps) * 1000) : null;

    callback({
      event: eventName,
      id: id++,
      payload: {
        job_id: designJobState.id || "design-job",
        phase: allComplete ? "Complete" : laggard.phase,
        current_file: `${FEED_FILES[feedCursor % FEED_FILES.length].name}`,
        files_done: aggFilesDone,
        total_files: totalFiles,
        bytes_done: Math.round(aggBytesDone),
        total_bytes: totalBytes,
        verified_bytes: Math.round(aggVerifiedBytes),
        verified_files: aggVerifiedFiles,
        elapsed_ms: Math.round(elapsed),
        bytes_per_second: Math.round(aggBps),
        remaining_ms: remainingMs,
        destination_count: dests.length,
        destinations,
      },
    });

    // ~1 file-verified event every ~550ms, alternating destinations, mostly verified with
    // an occasional fail — enough to populate the live feed without flooding.
    if (elapsed - lastFeedEmit >= 550 && !stalled) {
      lastFeedEmit = elapsed;
      const file = FEED_FILES[feedCursor % FEED_FILES.length];
      const destIndex = feedCursor % dests.length;
      const dest = dests[destIndex];
      const verified = verifiedId % 11 !== 10; // ~1 in 11 fails
      if (!verified) {
        dest.failed += 1; // reflected in the next tick's per-destination ✗ counter
      }
      const payload = {
        job_id: designJobState.id || "design-job",
        destination_index: dest.index,
        destination_path: dest.path,
        source_path: `D:/A001_SONY/${file.folder}/${file.name}`,
        relative_path: `${file.folder}/${file.name}`,
        size_bytes: file.size,
        verified,
        source_hash: `xxh3:${(verifiedId + 1).toString(16).padStart(16, "0")}`,
        destination_hash: `xxh3:${(verifiedId + 1).toString(16).padStart(16, "0")}`,
        algo: "XXH3-128",
      };
      for (const listener of verifiedListeners) {
        listener({ event: "file-verified", id: verifiedId, payload });
      }
      verifiedId += 1;
      feedCursor += 1;
    }

    if (allComplete) {
      clearInterval(interval);
    }
  }, tickMs);

  return () => clearInterval(interval);
}

export async function emit(): Promise<void> {
  // no-op in design mode
}

// Design-mode mock for "@tauri-apps/api/event".
// Simulates the backend "ingest-progress" event stream so the ingest run
// screen animates while designing. Other events resolve to a no-op unlisten.
type EventCallback = (event: { event: string; id: number; payload: any }) => void;

export async function listen(eventName: string, callback: EventCallback): Promise<() => void> {
  if (eventName !== "ingest-progress") {
    return () => {};
  }

  const totalFiles = 8;
  const totalBytes = 14_179_887_082;
  const start = performance.now();
  let filesDone = 0;
  let id = 0;

  const interval = setInterval(() => {
    filesDone = Math.min(totalFiles, filesDone + 1);
    const fraction = filesDone / totalFiles;
    const elapsed = performance.now() - start;
    const bytesDone = Math.round(totalBytes * fraction);
    const bytesPerSecond = elapsed > 0 ? (bytesDone / elapsed) * 1000 : 0;
    callback({
      event: eventName,
      id: id++,
      payload: {
        job_id: "design-job",
        phase: filesDone >= totalFiles ? "Verifying" : "Copying",
        current_file: `FX3_67${13 + filesDone}.MP4`,
        files_done: filesDone,
        total_files: totalFiles,
        bytes_done: bytesDone,
        total_bytes: totalBytes,
        elapsed_ms: Math.round(elapsed),
        bytes_per_second: Math.round(bytesPerSecond),
        remaining_ms: Math.round((elapsed / Math.max(fraction, 0.01)) * (1 - fraction)),
      },
    });
    if (filesDone >= totalFiles) clearInterval(interval);
  }, 280);

  return () => clearInterval(interval);
}

export async function emit(): Promise<void> {
  // no-op in design mode
}

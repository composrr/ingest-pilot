// Shared between the design-mode core and event mocks so simulated
// "ingest-progress" events carry the same job_id the UI generated for the run
// (the real listener filters events by job_id).
export const designJobState: { id: string } = { id: "" };

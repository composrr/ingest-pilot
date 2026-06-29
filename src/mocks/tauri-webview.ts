// Design-mode mock for "@tauri-apps/api/webview".
// Native OS drag-and-drop import isn't available in a browser; this provides
// the same shape (onDragDropEvent returning a Promise<unlisten>) as a no-op.
export type DragDropEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

type DragDropHandler = (event: { payload: DragDropEvent }) => void;

export function getCurrentWebview() {
  return {
    onDragDropEvent(_handler: DragDropHandler): Promise<() => void> {
      return Promise.resolve(() => {});
    },
  };
}

import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addFolder,
  duplicateFolder,
  ensureFootageDestination,
  findFolder,
  flattenFolderTree,
  moveFolderTo,
  removeFolder,
  setFootageDestination,
  updateFolder,
  type FolderDropPosition,
  type FolderTreeRow,
} from "../lib/folderTree";
import { inspectTemplateDrop } from "../lib/tauri";
import { parsePattern } from "../lib/tokens";
import type {
  FolderCondition,
  FolderNode,
  FolderRole,
  MetadataPresetSummary,
  PresetVariable,
  TemplateFile,
  TokenContext,
} from "../lib/types";
import { FloatingHelp } from "./FloatingHelp";
import { PatternInput } from "./PatternInput";
import { SelectMenu } from "./SelectMenu";

type FolderTreeEditorProps = {
  context: TokenContext;
  folders: FolderNode[];
  onChange: (folders: FolderNode[]) => void;
  routingOverrides: Record<string, string>;
  onRoutingChange: (overrides: Record<string, string>) => void;
  customFileKinds: Record<string, string>;
  metadataSummaries: MetadataPresetSummary[];
  variables: PresetVariable[];
};

type FolderTokenPreviewValues = Record<string, Record<string, string>>;
type PendingImport = {
  folders: FolderNode[];
  total: number;
};
type InternalDropTarget = {
  folderId: string;
  position: FolderDropPosition;
};
type SelectedTemplateFile = {
  folderId: string;
  index: number;
};
type DragPreviewState = {
  kind: "folder" | "file";
  label: string;
  x: number;
  y: number;
};

const roleOptions: Array<{ label: string; value: FolderRole | "" }> = [
  { label: "Folder", value: "" },
  { label: "Footage", value: "footage" },
  { label: "Audio", value: "audio" },
  { label: "Photos", value: "photos" },
  { label: "Docs", value: "documents" },
  { label: "Other", value: "other" },
];

export function FolderTreeEditor({
  context,
  folders,
  onChange,
  routingOverrides,
  onRoutingChange,
  customFileKinds,
  metadataSummaries,
  variables,
}: FolderTreeEditorProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => collectFolderIds(folders));
  const [isDragOver, setIsDragOver] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  const [draggedTemplateFile, setDraggedTemplateFile] = useState<SelectedTemplateFile | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [internalDropTarget, setInternalDropTarget] = useState<InternalDropTarget | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [tokenPreviewValues, setTokenPreviewValues] = useState<FolderTokenPreviewValues>({});
  const [selectedId, setSelectedId] = useState(() => firstFolderId(folders));
  const [selectedTemplateFile, setSelectedTemplateFile] = useState<SelectedTemplateFile | null>(null);
  const treeDropRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => flattenFolderTree(folders, expandedIds), [expandedIds, folders]);
  const selectedFolder = selectedId ? findFolder(folders, selectedId) : null;
  const selectedFile = selectedTemplateFile ? findTemplateFile(folders, selectedTemplateFile) : null;
  const folderCount = countFolders(folders);
  const templateFileCount = countTemplateFiles(folders);

  useEffect(() => {
    if (selectedId && !findFolder(folders, selectedId)) {
      setSelectedId(firstFolderId(folders));
      setSelectedTemplateFile(null);
    }
  }, [folders, selectedId]);

  useEffect(() => {
    if (selectedTemplateFile && !findTemplateFile(folders, selectedTemplateFile)) {
      setSelectedTemplateFile(null);
    }
  }, [folders, selectedTemplateFile]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        void handleNativeDropEvent(event.payload);
      })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        setImportMessage(`Folder drag/drop unavailable: ${String(error)}`);
      });

    return () => {
      unlisten?.();
    };
  }, [folders]);

  function updateFolders(nextFolders: FolderNode[]) {
    const foldersWithTarget = ensureFootageDestination(nextFolders);
    onChange(foldersWithTarget);
    setExpandedIds((current) => new Set([...current, ...collectFolderIds(foldersWithTarget)]));
  }

  function addRootFolder() {
    const nextFolders = addFolder(folders, null);
    updateFolders(nextFolders);
    setSelectedId(lastRootFolderId(nextFolders));
  }

  function addChildFolder(parentId: string) {
    const nextFolders = addFolder(folders, parentId);
    setExpandedIds((current) => new Set(current).add(parentId));
    updateFolders(nextFolders);
    const parent = findFolder(nextFolders, parentId);
    setSelectedId(parent?.children[parent.children.length - 1]?.id ?? parentId);
  }

  function deleteSelectedFolder() {
    if (!selectedFolder || !window.confirm(`Delete ${selectedFolder.name_pattern} and its subfolders?`)) {
      return;
    }

    const nextFolders = removeFolder(folders, selectedFolder.id);
    updateFolders(nextFolders);
    setSelectedId(firstFolderId(nextFolders));
  }

  function duplicateSelectedFolder() {
    if (!selectedFolder) {
      return;
    }

    updateFolders(duplicateFolder(folders, selectedFolder.id));
  }

  function toggleExpanded(folderId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  function updateFolderTokenPreview(folderId: string, variableId: string, value: string) {
    setTokenPreviewValues((current) => ({
      ...current,
      [folderId]: {
        ...current[folderId],
        [variableId]: value,
      },
    }));
  }

  function folderContext(folder: FolderNode): TokenContext {
    return {
      ...context,
      folder_name: resolveFolderName(folder, variables, tokenPreviewValues[folder.id] ?? {}),
      variable_values: {
        ...context.variable_values,
        ...resolvedTokenValuesForFolder(folder, variables, tokenPreviewValues[folder.id] ?? {}),
      },
    };
  }

  function updateSelectedTemplateFile(selection: SelectedTemplateFile, patch: Partial<TemplateFile>) {
    updateFolders(
      updateFolder(folders, selection.folderId, (folder) => ({
        ...folder,
        template_files: folder.template_files.map((file, index) =>
          index === selection.index ? { ...file, ...patch } : file,
        ),
      })),
    );
  }

  function removeSelectedTemplateFile(selection: SelectedTemplateFile) {
    updateFolders(
      updateFolder(folders, selection.folderId, (folder) => ({
        ...folder,
        template_files: folder.template_files.filter((_, index) => index !== selection.index),
      })),
    );
    setSelectedTemplateFile(null);
  }

  async function handleNativeDropEvent(event: DragDropEvent) {
    if (event.type === "enter" || event.type === "over") {
      setIsDragOver(isPositionOverTree(event.position.x, event.position.y));
      const folderId = folderRowIdFromPoint(event.position.x, event.position.y);
      setInternalDropTarget(folderId ? { folderId, position: "inside" } : null);
      return;
    }

    if (event.type === "leave") {
      setIsDragOver(false);
      setInternalDropTarget(null);
      return;
    }

    const targetFolderId = folderRowIdFromPoint(event.position.x, event.position.y);
    setIsDragOver(false);
    setInternalDropTarget(null);
    setImportMessage(null);

    let droppedItems;
    try {
      droppedItems = await inspectTemplateDrop(event.paths);
    } catch (caught) {
      setImportMessage(String(caught));
      return;
    }
    if (droppedItems.files.length === 0 && droppedItems.folders.length === 0) {
      setImportMessage("Drop folders to import structure, or files onto a target folder.");
      return;
    }

    if (droppedItems.files.length > 0) {
      if (!targetFolderId) {
        setImportMessage("Drop files directly on a folder row to attach them to that folder.");
      } else {
        const templateFiles = droppedItems.files.map((source_path) => ({
          source_path,
          name_from_folder: true,
          rename_pattern: "{folder_name}{ext}",
        }));
        updateFolders(
          updateFolder(folders, targetFolderId, (folder) => ({
            ...folder,
            template_files: [...folder.template_files, ...templateFiles],
          })),
        );
        setSelectedId(targetFolderId);
        setSelectedTemplateFile(null);
        setImportMessage(
          `Attached ${templateFiles.length} file${templateFiles.length === 1 ? "" : "s"} to ${findFolder(folders, targetFolderId)?.name_pattern ?? "folder"}.`,
        );
      }
    }

    if (droppedItems.folders.length === 0) {
      return;
    }

    if (targetFolderId) {
      updateFolders(
        updateFolder(folders, targetFolderId, (folder) => ({
          ...folder,
          children: [...folder.children, ...droppedItems.folders],
        })),
      );
      setExpandedIds((current) => new Set(current).add(targetFolderId));
      setSelectedId(targetFolderId);
      setSelectedTemplateFile(null);
      setImportMessage(
        `Imported ${countFolders(droppedItems.folders)} folder${countFolders(droppedItems.folders) === 1 ? "" : "s"} under ${findFolder(folders, targetFolderId)?.name_pattern ?? "folder"}.`,
      );
      return;
    }

    if (folders.length > 0) {
      setPendingImport({
        folders: droppedItems.folders,
        total: countFolders(droppedItems.folders),
      });
      return;
    }

    applyImportedFolders(droppedItems.folders, "replace");
  }

  function applyImportedFolders(importedFolders: FolderNode[], mode: "add" | "replace") {
    const nextFolders = mode === "replace" ? importedFolders : [...folders, ...importedFolders];
    updateFolders(nextFolders);
    setSelectedId(importedFolders[0]?.id ?? firstFolderId(nextFolders));
    setSelectedTemplateFile(null);
    setPendingImport(null);
    setImportMessage(
      `Imported ${countFolders(importedFolders)} folder${countFolders(importedFolders) === 1 ? "" : "s"} from disk.`,
    );
  }

  useEffect(() => {
    if (!draggedFolderId) {
      return;
    }

    const activeDraggedFolderId = draggedFolderId;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    function handlePointerMove(event: PointerEvent) {
      setDragPreview((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current));
      setInternalDropTarget(dropTargetFromPoint(event.clientX, event.clientY));
    }

    function handlePointerUp(event: PointerEvent) {
      const target = dropTargetFromPoint(event.clientX, event.clientY);
      if (target) {
        updateFolders(moveFolderTo(folders, activeDraggedFolderId, target.folderId, target.position));
      }
      setDraggedFolderId(null);
      setDragPreview(null);
      setInternalDropTarget(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggedFolderId, folders]);

  useEffect(() => {
    if (!draggedTemplateFile) {
      return;
    }

    const activeDraggedFile = draggedTemplateFile;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    function handlePointerMove(event: PointerEvent) {
      setDragPreview((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current));
      const targetFolderId = folderRowIdFromPoint(event.clientX, event.clientY);
      setInternalDropTarget(targetFolderId ? { folderId: targetFolderId, position: "inside" } : null);
    }

    function handlePointerUp(event: PointerEvent) {
      const targetFolderId = folderRowIdFromPoint(event.clientX, event.clientY);
      if (targetFolderId) {
        updateFolders(moveTemplateFileToFolder(folders, activeDraggedFile, targetFolderId));
        setSelectedId(targetFolderId);
        const targetFolder = findFolder(folders, targetFolderId);
        setSelectedTemplateFile({
          folderId: targetFolderId,
          index:
            targetFolderId === activeDraggedFile.folderId
              ? activeDraggedFile.index
              : targetFolder?.template_files.length ?? 0,
        });
      }
      setDraggedTemplateFile(null);
      setDragPreview(null);
      setInternalDropTarget(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggedTemplateFile, folders]);

  function dropTargetFromPoint(x: number, y: number): InternalDropTarget | null {
    const treeRect = treeDropRef.current?.getBoundingClientRect();
    if (!treeRect || x < treeRect.left || x > treeRect.right || y < treeRect.top || y > treeRect.bottom) {
      return null;
    }

    const rowElement = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-folder-row-id]");
    if (rowElement) {
      const bounds = rowElement.getBoundingClientRect();
      return {
        folderId: rowElement.dataset.folderRowId ?? "",
        position: dropPositionFromOffset(y - bounds.top, bounds.height),
      };
    }

    const lastRow = treeDropRef.current?.querySelector<HTMLElement>("[data-folder-row-id]:last-of-type");
    const fallbackFolderId = lastRow?.dataset.folderRowId ?? rows[rows.length - 1]?.folder.id;
    return fallbackFolderId ? { folderId: fallbackFolderId, position: "after" } : null;
  }

  function folderRowIdFromPoint(x: number, y: number): string | null {
    const treeRect = treeDropRef.current?.getBoundingClientRect();
    if (!treeRect || x < treeRect.left || x > treeRect.right || y < treeRect.top || y > treeRect.bottom) {
      return null;
    }

    const rowElement = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-folder-row-id]");
    return rowElement?.dataset.folderRowId ?? null;
  }

  function isPositionOverTree(x: number, y: number) {
    const treeRect = treeDropRef.current?.getBoundingClientRect();
    if (!treeRect) {
      return true;
    }

    return x >= treeRect.left && x <= treeRect.right && y >= treeRect.top && y <= treeRect.bottom;
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-mist bg-white">
      <div className="flex h-10 items-center justify-between border-b border-mist px-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Folder Tree</h3>
          <span className="rounded-full bg-porcelain px-2 py-0.5 text-xs font-semibold text-graphite">
            {folderCount}
          </span>
        </div>
        <button
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
          onClick={addRootFolder}
          type="button"
        >
          <Plus size={13} />
          Root
        </button>
      </div>

      <div className="grid gap-2 bg-porcelain/55 p-2 xl:grid-cols-[minmax(360px,1fr)_300px]">
        <div className="overflow-hidden rounded-xl border border-mist bg-white">
          <div className="flex h-8 items-center justify-between border-b border-mist bg-porcelain px-3 text-xs font-semibold text-graphite">
            <span>Template Structure</span>
            <span>
              {folderCount} folders
              {templateFileCount > 0 ? `, ${templateFileCount} files` : ""}
            </span>
          </div>

          <div
            ref={treeDropRef}
            className={`relative min-h-[240px] p-1.5 transition ${
              isDragOver && !internalDropTarget ? "bg-lavender/10 ring-2 ring-inset ring-lavender/60" : ""
            }`}
            onMouseDown={(event) => {
              if (event.currentTarget === event.target) {
                setSelectedId(null);
                setSelectedTemplateFile(null);
              }
            }}
          >
            {rows.length === 0 ? (
              <EmptyTree onAddRoot={addRootFolder} />
            ) : (
              <div className="space-y-0.5">
                {rows.map((row) => {
                  const isExpanded = expandedIds.has(row.folder.id);

                  return (
                    <div key={row.folder.id}>
                      <TreeRow
                        displayName={resolveFolderName(row.folder, variables, tokenPreviewValues[row.folder.id] ?? {})}
                        dragged={row.folder.id === draggedFolderId}
                        dropPosition={
                          internalDropTarget?.folderId === row.folder.id ? internalDropTarget.position : null
                        }
                        expanded={isExpanded}
                        onDragStart={(point) => {
                          const displayName = resolveFolderName(
                            row.folder,
                            variables,
                            tokenPreviewValues[row.folder.id] ?? {},
                          );
                          setSelectedId(row.folder.id);
                          setSelectedTemplateFile(null);
                          setDraggedFolderId(row.folder.id);
                          setDragPreview({ kind: "folder", label: displayName, ...point });
                        }}
                        onSelect={() => {
                          setSelectedId(row.folder.id);
                          setSelectedTemplateFile(null);
                        }}
                        onToggle={() => toggleExpanded(row.folder.id)}
                        row={row}
                        selected={row.folder.id === selectedId && !selectedTemplateFile}
                      />
                      {isExpanded
                        ? row.folder.template_files.map((file, index) => (
                            <TemplateFileRow
                              depth={row.depth + 1}
                              file={file}
                              dragged={
                                draggedTemplateFile?.folderId === row.folder.id &&
                                draggedTemplateFile.index === index
                              }
                              key={`${row.folder.id}-template-${file.source_path}-${index}`}
                              onDragStart={(point) => {
                                setSelectedId(row.folder.id);
                                setSelectedTemplateFile({ folderId: row.folder.id, index });
                                setDraggedTemplateFile({ folderId: row.folder.id, index });
                                setDragPreview({
                                  kind: "file",
                                  label: fileNameFromPath(file.source_path),
                                  ...point,
                                });
                              }}
                              onSelect={() => {
                                setSelectedId(row.folder.id);
                                setSelectedTemplateFile({ folderId: row.folder.id, index });
                              }}
                              selected={
                                selectedTemplateFile?.folderId === row.folder.id &&
                                selectedTemplateFile.index === index
                              }
                            />
                          ))
                        : null}
                    </div>
                  );
                })}
              </div>
            )}
            {isDragOver && !internalDropTarget ? (
              <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border border-dashed border-lavender bg-white/80 text-sm font-semibold text-ink">
                Drop folders here to add or replace the template structure
              </div>
            ) : null}
            {dragPreview ? <DragPreview preview={dragPreview} /> : null}
          </div>

          <div className="flex items-center gap-2 border-t border-mist bg-porcelain/45 px-3 py-2">
            <button
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
              onClick={addRootFolder}
              type="button"
            >
              <Plus size={14} />
              Root
            </button>
            <button
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
              disabled={!selectedFolder || Boolean(selectedTemplateFile)}
              onClick={() => selectedFolder && addChildFolder(selectedFolder.id)}
              type="button"
            >
              <FolderPlus size={14} />
              Subfolder
            </button>
            <button
              className="inline-flex h-8 items-center rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
              disabled={!selectedFolder}
              onClick={() => {
                setSelectedId(null);
                setSelectedTemplateFile(null);
              }}
              type="button"
            >
              Clear
            </button>
            <button
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
              disabled={!selectedFolder || Boolean(selectedTemplateFile)}
              onClick={deleteSelectedFolder}
              type="button"
            >
              <Trash2 size={14} />
              Remove
            </button>
            <button
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
              disabled={!selectedFolder || Boolean(selectedTemplateFile)}
              onClick={duplicateSelectedFolder}
              type="button"
            >
              <Copy size={14} />
              Duplicate
            </button>
            {importMessage ? <span className="ml-auto truncate text-xs font-medium text-graphite">{importMessage}</span> : null}
          </div>
        </div>

        {selectedTemplateFile && selectedFile && selectedFolder ? (
          <TemplateFileInspector
            file={selectedFile}
            folder={selectedFolder}
            fileContext={templateFileContext(selectedFile, selectedFolder, folderContext(selectedFolder))}
            onRemove={() => removeSelectedTemplateFile(selectedTemplateFile)}
            onUpdate={(patch) => updateSelectedTemplateFile(selectedTemplateFile, patch)}
            variables={variables}
          />
        ) : (
          <FolderInspector
            folder={selectedFolder}
            folderContext={selectedFolder ? folderContext(selectedFolder) : context}
            onSetFootage={() => selectedFolder && updateFolders(setFootageDestination(folders, selectedFolder.id))}
            onUpdate={(patch) =>
              selectedFolder &&
              updateFolders(updateFolder(folders, selectedFolder.id, (folder) => ({ ...folder, ...patch })))
            }
            onUpdateTokenPreview={updateFolderTokenPreview}
            routingOverrides={routingOverrides}
            onRoutingChange={onRoutingChange}
            customFileKinds={customFileKinds}
            metadataSummaries={metadataSummaries}
            tokenPreviewValues={selectedFolder ? tokenPreviewValues[selectedFolder.id] ?? {} : {}}
            variables={variables}
          />
        )}
      </div>
      {pendingImport ? (
        <ImportChoiceDialog
          folderCount={pendingImport.total}
          onAdd={() => applyImportedFolders(pendingImport.folders, "add")}
          onCancel={() => setPendingImport(null)}
          onReplace={() => applyImportedFolders(pendingImport.folders, "replace")}
        />
      ) : null}
    </section>
  );
}

function TreeRow({
  displayName,
  dragged,
  dropPosition,
  expanded,
  onDragStart,
  onSelect,
  onToggle,
  row,
  selected,
}: {
  displayName: string;
  dragged: boolean;
  dropPosition: FolderDropPosition | null;
  expanded: boolean;
  onDragStart: (point: { x: number; y: number }) => void;
  onSelect: () => void;
  onToggle: () => void;
  row: FolderTreeRow;
  selected: boolean;
}) {
  const FolderIcon = expanded && row.hasChildren ? FolderOpen : Folder;
  const hasCondition = Boolean(row.folder.condition);
  const templateFileCount = row.folder.template_files.length;
  const hasTemplateFiles = templateFileCount > 0;
  const hasAnyTrailingBadge = hasCondition || hasTemplateFiles;
  const badgeClass = "rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-normal";

  return (
    <div
      data-folder-row-id={row.folder.id}
      className={`relative flex h-7 items-center ${dragged ? "opacity-45" : ""}`}
    >
      {dropPosition === "before" ? <DropLine placement="top" /> : null}
      {dropPosition === "after" ? <DropLine placement="bottom" /> : null}
      <TreeGuides row={row} />
      <button
        className="mr-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-graphite transition hover:bg-porcelain hover:text-ink disabled:opacity-30"
        disabled={!row.hasChildren}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        type="button"
      >
        {row.hasChildren ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
      </button>
      <button
        className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 text-left text-sm transition ${
          dropPosition === "inside"
            ? "bg-lavender/20 ring-1 ring-lavender/60"
            : selected
              ? "bg-lavender/35 text-ink ring-1 ring-lavender/60"
              : "text-ink hover:bg-porcelain"
        }`}
        onClick={onSelect}
        type="button"
      >
        <span
          aria-label="Drag folder"
          className="inline-flex h-5 w-4 cursor-grab items-center justify-center rounded text-graphite/55 hover:bg-white/70 hover:text-ink"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDragStart({ x: event.clientX, y: event.clientY });
          }}
          role="button"
          title="Drag folder"
        >
          <GripVertical size={13} />
        </span>
        <FolderIcon
          className={folderRoleColor(row.folder.role)}
          fill="currentColor"
          size={16}
          strokeWidth={1.5}
        />
        <span className="truncate font-medium">{displayName}</span>
        {hasCondition ? (
          <span className={`ml-auto ${badgeClass} bg-sky-50 text-sky-800`}>
            Rule
          </span>
        ) : null}
        {hasTemplateFiles ? (
          <span className={`${hasCondition ? "" : "ml-auto"} ${badgeClass} bg-porcelain text-graphite`}>
            {templateFileCount} file{templateFileCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {dropPosition === "inside" ? (
          <span className={`${hasAnyTrailingBadge ? "" : "ml-auto"} ${badgeClass} bg-lavender text-ink`}>
            Drop here
          </span>
        ) : null}
        {row.folder.is_footage_destination ? (
          <span className={`${hasAnyTrailingBadge || dropPosition === "inside" ? "" : "ml-auto"} ${badgeClass} bg-emerald-50 text-emerald-800`}>
            Target
          </span>
        ) : null}
      </button>
    </div>
  );
}

function DropLine({ placement }: { placement: "top" | "bottom" }) {
  return (
    <span
      className={`pointer-events-none absolute left-0 right-0 z-10 border-t-2 border-lavender ${
        placement === "top" ? "top-0" : "bottom-0"
      }`}
    />
  );
}

function TemplateFileRow({
  depth,
  dragged,
  file,
  onDragStart,
  onSelect,
  selected,
}: {
  depth: number;
  dragged: boolean;
  file: TemplateFile;
  onDragStart: (point: { x: number; y: number }) => void;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      className={`flex h-7 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-sm transition ${
        selected ? "bg-lavender/30 text-ink ring-1 ring-lavender/60" : "text-graphite hover:bg-porcelain/70"
      } ${dragged ? "opacity-45" : ""}`}
      onClick={onSelect}
      style={{ paddingLeft: 24 + depth * 34 }}
      title={file.source_path}
      type="button"
    >
      <span className="mr-1 h-full border-l border-dotted border-graphite/25" />
      <span
        aria-label="Drag template file"
        className="inline-flex h-5 w-4 cursor-grab items-center justify-center rounded text-graphite/55 hover:bg-white/70 hover:text-ink"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDragStart({ x: event.clientX, y: event.clientY });
        }}
        role="button"
        title="Drag template file"
      >
        <GripVertical size={13} />
      </span>
      <FileText className="shrink-0 text-violet-600" size={15} />
      <span className="min-w-0 truncate text-xs font-semibold">{fileNameFromPath(file.source_path)}</span>
      <span className="ml-auto max-w-[150px] truncate rounded-full bg-porcelain px-1.5 py-0.5 text-[10px] font-bold tracking-normal text-graphite">
        {templateFileRenamePattern(file)}
      </span>
    </button>
  );
}

function DragPreview({ preview }: { preview: DragPreviewState }) {
  const Icon = preview.kind === "folder" ? Folder : FileText;

  return (
    <div
      className="pointer-events-none fixed z-[9999] flex h-8 max-w-[260px] items-center gap-2 rounded-xl border border-lavender bg-white px-2.5 text-sm font-semibold text-ink shadow-panel ring-2 ring-lavender/25"
      style={{ left: preview.x + 12, top: preview.y + 12 }}
    >
      <GripVertical className="shrink-0 text-graphite/60" size={13} />
      <Icon
        className={preview.kind === "folder" ? "shrink-0 text-amber-500" : "shrink-0 text-violet-600"}
        fill={preview.kind === "folder" ? "currentColor" : "none"}
        size={15}
        strokeWidth={1.6}
      />
      <span className="truncate">{preview.label}</span>
    </div>
  );
}

function dropPositionFromOffset(offset: number, height: number): FolderDropPosition {
  if (offset < height * 0.25) {
    return "before";
  }
  if (offset > height * 0.75) {
    return "after";
  }
  return "inside";
}

function TreeGuides({ row }: { row: FolderTreeRow }) {
  return (
    <div className="flex h-7 shrink-0">
      {row.guides.map((showLine, index) => (
        <div key={`${row.folder.id}-guide-${index}`} className="relative h-7 w-4">
          {showLine ? <span className="absolute left-2 top-0 h-full border-l border-dotted border-graphite/30" /> : null}
        </div>
      ))}
      {row.depth > 0 ? (
        <div className="relative h-7 w-4">
          <span
            className={`absolute left-2 top-0 border-l border-dotted border-graphite/30 ${
              row.isLast ? "h-1/2" : "h-full"
            }`}
          />
          <span className="absolute left-2 top-1/2 w-3 border-t border-dotted border-graphite/30" />
        </div>
      ) : null}
    </div>
  );
}

// Default extensions per media kind, mirroring the Rust scanner's classify_file so the
// preset editor can show exactly what will route to a folder for its role.
const KIND_EXTENSIONS: Record<string, string[]> = {
  footage: [".mp4", ".mov", ".mxf", ".avi", ".m4v", ".mts", ".m2ts", ".braw", ".r3d", ".crm", ".cine"],
  photos: [".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".cr2", ".nef", ".arw", ".dng", ".raw", ".orf", ".rw2"],
  audio: [".wav", ".mp3", ".aif", ".aiff", ".m4a", ".flac"],
  documents: [".pdf", ".txt", ".doc", ".docx", ".csv", ".xlsx", ".xls", ".rtf"],
};

const ROLE_LABELS: Record<string, string> = {
  footage: "footage",
  photos: "photo",
  audio: "audio",
  documents: "document",
  other: "other",
};

// Shows every file type that will land in a folder — the extensions for its role (plus
// footage if it's the footage target), minus any that a custom rule sends elsewhere —
// and lets the user add/remove custom types. Updates dynamically with the role dropdown.
function FolderRoutingSection({
  folder,
  routingOverrides,
  onRoutingChange,
  customFileKinds,
}: {
  folder: FolderNode;
  routingOverrides: Record<string, string>;
  onRoutingChange: (overrides: Record<string, string>) => void;
  customFileKinds: Record<string, string>;
}) {
  const [draftExtension, setDraftExtension] = useState("");

  // Extensions this folder receives by role (built-in + user-defined custom kinds and
  // the footage target), excluding any that a custom folder rule points elsewhere.
  const roleKindExtensions = new Set<string>();
  const addRoleExtensions = (roleKey: string) => {
    (KIND_EXTENSIONS[roleKey] ?? []).forEach((extension) => roleKindExtensions.add(extension));
    // custom_file_kinds uses singular "photo"/"document"; folder roles use plural.
    const kindAliases = roleKey === "photos" ? ["photo", "photos"] : roleKey === "documents" ? ["document", "documents"] : [roleKey];
    for (const [extension, kind] of Object.entries(customFileKinds)) {
      if (kindAliases.includes(kind)) {
        roleKindExtensions.add(extension);
      }
    }
  };
  if (folder.role) {
    addRoleExtensions(folder.role);
  }
  if (folder.is_footage_destination) {
    addRoleExtensions("footage");
  }
  const defaultExtensions = [...roleKindExtensions]
    .filter((extension) => {
      const override = routingOverrides[extension];
      return override === undefined || override === folder.id;
    })
    .sort();
  const customExtensions = Object.entries(routingOverrides)
    .filter(([extension, folderId]) => folderId === folder.id && !roleKindExtensions.has(extension))
    .map(([extension]) => extension)
    .sort();

  const roleDescriptor = folder.role ? ROLE_LABELS[folder.role] : null;

  function normalizeExtension(value: string): string | null {
    const trimmed = value.trim().toLowerCase().replace(/\s+/g, "");
    if (!trimmed) {
      return null;
    }
    const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    return /^\.[a-z0-9]+$/.test(withDot) ? withDot : null;
  }

  function addExtension() {
    const extension = normalizeExtension(draftExtension);
    setDraftExtension("");
    if (extension) {
      onRoutingChange({ ...routingOverrides, [extension]: folder.id });
    }
  }

  function removeExtension(extension: string) {
    const next = { ...routingOverrides };
    delete next[extension];
    onRoutingChange(next);
  }

  return (
    <div className="rounded-xl border border-mist bg-porcelain/50 p-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-graphite">
        Files routed here
        <FloatingHelp label="Routing help">
          These are the file types that land in this folder — the ones for its role above, plus any custom types you
          add. A custom type always wins over the role defaults.
        </FloatingHelp>
      </div>

      {defaultExtensions.length > 0 ? (
        <div className="mb-1.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">
            {roleDescriptor ? `All ${roleDescriptor} files` : "By role"}
          </div>
          <div className="flex flex-wrap gap-1">
            {defaultExtensions.map((extension) => (
              <span key={extension} className="rounded-md bg-porcelain px-1.5 py-0.5 text-[11px] font-semibold text-graphite">
                {extension}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">Custom types</div>
      <div className="flex flex-wrap items-center gap-1">
        {customExtensions.map((extension) => (
          <span
            key={extension}
            className="inline-flex items-center gap-1 rounded-md bg-white py-0.5 pl-2 pr-1 text-[11px] font-semibold text-ink ring-1 ring-mist"
          >
            {extension}
            <button
              aria-label={`Remove ${extension}`}
              className="rounded p-0.5 text-graphite/60 transition hover:text-red-700"
              onClick={() => removeExtension(extension)}
              type="button"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {customExtensions.length === 0 ? (
          <span className="text-[11px] text-graphite/60">None yet.</span>
        ) : null}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          className="h-7 w-24 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => setDraftExtension(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addExtension();
            }
          }}
          placeholder=".mxf"
          value={draftExtension}
        />
        <button
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
          onClick={addExtension}
          type="button"
        >
          <Plus size={12} />
          Add type
        </button>
      </div>
    </div>
  );
}

function FolderInspector({
  folder,
  folderContext,
  onSetFootage,
  onUpdate,
  onUpdateTokenPreview,
  routingOverrides,
  onRoutingChange,
  customFileKinds,
  metadataSummaries,
  tokenPreviewValues,
  variables,
}: {
  folder: FolderNode | null;
  folderContext: TokenContext;
  onSetFootage: () => void;
  onUpdate: (patch: Partial<FolderNode>) => void;
  onUpdateTokenPreview: (folderId: string, variableId: string, value: string) => void;
  routingOverrides: Record<string, string>;
  onRoutingChange: (overrides: Record<string, string>) => void;
  customFileKinds: Record<string, string>;
  metadataSummaries: MetadataPresetSummary[];
  tokenPreviewValues: Record<string, string>;
  variables: PresetVariable[];
}) {
  if (!folder) {
    return (
      <div className="rounded-xl border border-mist bg-white p-3 text-sm text-graphite">
        Select a folder to edit its name, role, and placement.
      </div>
    );
  }

  const selectedFolder = folder;
  const tokenVariables = dropdownVariablesForPattern(selectedFolder.name_pattern, variables);
  const conditionVariable = selectedFolder.condition
    ? variables.find((variable) => variable.id === selectedFolder.condition?.variable_id) ?? variables[0]
    : variables[0];

  function updateConditionMode(mode: "always" | FolderCondition["type"]) {
    if (mode === "always" || !conditionVariable) {
      onUpdate({ condition: null });
      return;
    }

    if (mode === "variable_has_value") {
      onUpdate({ condition: { type: "variable_has_value", variable_id: conditionVariable.id } });
      return;
    }

    onUpdate({
      condition: {
        type: "variable_equals",
        variable_id: conditionVariable.id,
        value: defaultConditionValue(conditionVariable),
      },
    });
  }

  function updateConditionVariable(variableId: string) {
    const variable = variables.find((candidate) => candidate.id === variableId);
    if (!selectedFolder.condition || !variable) {
      return;
    }

    if (selectedFolder.condition.type === "variable_has_value") {
      onUpdate({ condition: { ...selectedFolder.condition, variable_id: variable.id } });
      return;
    }

    onUpdate({
      condition: {
        ...selectedFolder.condition,
        variable_id: variable.id,
        value: defaultConditionValue(variable),
      },
    });
  }

  function updateConditionValue(value: string | boolean) {
    if (!selectedFolder.condition || selectedFolder.condition.type !== "variable_equals") {
      return;
    }

    onUpdate({ condition: { ...selectedFolder.condition, value } });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-mist bg-white">
      <div className="flex h-8 items-center justify-between border-b border-mist bg-porcelain px-3">
        <span className="text-xs font-semibold text-graphite">Folder Details</span>
        {folder.is_footage_destination ? (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-normal text-emerald-800">
            Footage Target
          </span>
        ) : null}
      </div>

      <div className="space-y-3 p-3">
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <label className="block text-xs font-semibold text-graphite">Name</label>
            <FloatingHelp label="Folder name token help">
              Folder names can include tokens. Use the token buttons below the field or type <code>/</code> to insert one.
            </FloatingHelp>
          </div>
          <PatternInput
            context={folderContext}
            density="compact"
            label="Folder name"
            onChange={(name_pattern) => onUpdate({ name_pattern })}
            scope="folder"
            showTokenButtons
            showTokenPills={false}
            value={folder.name_pattern}
            variables={variables}
          />
        </div>

        {tokenVariables.length > 0 ? (
          <div className="rounded-xl border border-mist bg-porcelain/50 p-2">
            <div className="mb-2 text-xs font-semibold text-graphite">Token Values</div>
            <div className="space-y-2">
              {tokenVariables.map((variable) => (
                <label key={variable.id} className="grid grid-cols-[88px_1fr] items-center gap-2">
                  <span className="truncate text-xs font-semibold text-graphite">{variable.name}</span>
                  <SelectMenu
                    onChange={(value) => onUpdateTokenPreview(folder.id, variable.id, value)}
                    options={variable.options.map((option) => ({ label: option, value: option }))}
                    size="sm"
                    value={effectiveTokenValue(variable, tokenPreviewValues)}
                  />
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-2">
          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-graphite">
              Role
              <FloatingHelp label="Folder role help">
                Roles tell Ingest Pilot what kind of files should route to this folder by default. Use Folder for a normal folder, or choose Audio, Photos, Docs, or Other for media routing.
              </FloatingHelp>
            </span>
            <SelectMenu
              onChange={(value) => onUpdate({ role: value ? (value as FolderRole) : null })}
              options={roleOptions}
              size="sm"
              value={folder.role ?? ""}
            />
          </label>
          {metadataSummaries.length ? (
            <label className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-graphite">
                Folder metadata
                <FloatingHelp label="Folder metadata help">
                  Optional. Attach a metadata preset to this folder (e.g. a campus folder) and clips that land here are
                  tagged in the iconik CSV with that preset's field defaults — so multiple campuses in one root each get
                  their own metadata. Leave blank to use the ingest's shoot-wide metadata.
                </FloatingHelp>
              </span>
              <SelectMenu
                onChange={(value) => onUpdate({ metadata_preset_id: value || null })}
                options={[{ label: "Use shoot-wide", value: "" }, ...metadataSummaries.map((item) => ({ label: item.name, value: item.id }))]}
                placeholder="Use shoot-wide"
                size="sm"
                value={folder.metadata_preset_id ?? ""}
              />
            </label>
          ) : null}
          <label className="flex min-h-8 items-center gap-2 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite">
            <input
              checked={folder.is_footage_destination}
              className="h-4 w-4 accent-black"
              onChange={() => {
                if (!folder.is_footage_destination) {
                  onSetFootage();
                }
              }}
              type="checkbox"
            />
            Footage target
            <FloatingHelp label="Footage target help">
              Footage target marks the folder where video media should land unless a more specific routing rule points somewhere else.
            </FloatingHelp>
          </label>
        </div>

        <FolderRoutingSection
          customFileKinds={customFileKinds}
          folder={folder}
          onRoutingChange={onRoutingChange}
          routingOverrides={routingOverrides}
        />

        <div className="rounded-xl border border-mist bg-porcelain/50 p-2">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-graphite">
            Create When
            <FloatingHelp label="Conditional folder help">
              Leave this on Always create for normal folders. Use a condition when a folder should appear only for certain variable choices.
            </FloatingHelp>
          </div>
          <div className="space-y-2">
            <SelectMenu
              disabled={variables.length === 0}
              onChange={(value) => updateConditionMode(value as "always" | FolderCondition["type"])}
              options={[
                { label: "Always create", value: "always" },
                { label: "If parameter is filled in", value: "variable_has_value" },
                { label: "If parameter equals", value: "variable_equals" },
              ]}
              size="sm"
              value={folder.condition?.type ?? "always"}
            />

            {variables.length === 0 ? (
              <p className="text-xs leading-5 text-graphite">Add a parameter before using conditional folders.</p>
            ) : folder.condition ? (
              <div className="grid gap-2">
                <SelectMenu
                  onChange={updateConditionVariable}
                  options={variables.map((variable) => ({ label: variable.name, value: variable.id }))}
                  size="sm"
                  value={folder.condition.variable_id}
                />

                {folder.condition.type === "variable_equals" && conditionVariable ? (
                  <ConditionValueEditor
                    onChange={updateConditionValue}
                    value={folder.condition.value}
                    variable={conditionVariable}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

      </div>
    </div>
  );
}

function TemplateFileInspector({
  file,
  fileContext,
  folder,
  onRemove,
  onUpdate,
  variables,
}: {
  file: TemplateFile;
  fileContext: TokenContext;
  folder: FolderNode;
  onRemove: () => void;
  onUpdate: (patch: Partial<TemplateFile>) => void;
  variables: PresetVariable[];
}) {
  const renamePattern = templateFileRenamePattern(file);

  function updateRenamePattern(nextPattern: string) {
    onUpdate({
      rename_pattern: nextPattern,
      name_from_folder: nextPattern.includes("{folder_name}"),
    });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-mist bg-white">
      <div className="flex h-8 items-center justify-between border-b border-mist bg-porcelain px-3">
        <span className="text-xs font-semibold text-graphite">Template File</span>
        <span className="max-w-[160px] truncate rounded-full bg-porcelain px-2 py-0.5 text-[10px] font-bold uppercase tracking-normal text-graphite">
          {folder.name_pattern}
        </span>
      </div>

      <div className="space-y-3 p-3">
        <div className="rounded-xl border border-mist bg-porcelain/50 p-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-graphite">
            Source
            <FloatingHelp label="Template file source help">
              This can be any starter file you want copied into the folder tree, including Premiere, After Effects, Resolve, PDF, DOCX, XLSX, TXT, or SOP files.
            </FloatingHelp>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="shrink-0 text-violet-600" size={15} />
            <span className="min-w-0 truncate text-xs font-semibold text-ink" title={file.source_path}>
              {fileNameFromPath(file.source_path)}
            </span>
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <label className="block text-xs font-semibold text-graphite">Name</label>
            <FloatingHelp label="File name token help">
              File names can include tokens. Use the token buttons below the field or type <code>/</code> to insert one. The Preview line shows the resolved name that will be created.
            </FloatingHelp>
          </div>
          <PatternInput
            context={fileContext}
            density="compact"
            label="Template file name"
            onChange={updateRenamePattern}
            scope="filename"
            showTokenButtons
            showTokenPills={false}
            value={renamePattern}
            variables={variables}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            className="inline-flex h-8 items-center justify-center rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={() => onUpdate({ name_from_folder: false, rename_pattern: "{original_name}{ext}" })}
            type="button"
          >
            Keep original
          </button>
          <button
            className="inline-flex h-8 items-center justify-center rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={() => onUpdate({ name_from_folder: true, rename_pattern: "{folder_name}{ext}" })}
            type="button"
          >
            Use folder name
          </button>
        </div>

        <button
          className="inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 text-xs font-semibold text-red-800 transition hover:bg-red-100"
          onClick={onRemove}
          type="button"
        >
          <Trash2 size={14} />
          Remove file
        </button>
      </div>
    </div>
  );
}

function ImportChoiceDialog({
  folderCount,
  onAdd,
  onCancel,
  onReplace,
}: {
  folderCount: number;
  onAdd: () => void;
  onCancel: () => void;
  onReplace: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/20 px-4">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-mist bg-white shadow-panel">
        <div className="border-b border-mist px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">Import Folder Structure</h3>
          <p className="mt-1 text-xs leading-5 text-graphite">
            This template already has folders. Add the imported {folderCount} folder
            {folderCount === 1 ? "" : "s"} to the current tree, or replace the existing tree.
          </p>
        </div>
        <div className="flex justify-end gap-2 bg-porcelain/55 px-4 py-3">
          <button
            className="inline-flex h-8 items-center rounded-lg border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex h-8 items-center rounded-lg border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={onAdd}
            type="button"
          >
            Add
          </button>
          <button
            className="inline-flex h-8 items-center rounded-lg bg-signal px-3 text-xs font-semibold text-primaryfg transition hover:bg-black"
            onClick={onReplace}
            type="button"
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionValueEditor({
  onChange,
  value,
  variable,
}: {
  onChange: (value: string | boolean) => void;
  value: string | boolean;
  variable: PresetVariable;
}) {
  if (variable.type === "boolean") {
    return (
      <SelectMenu
        onChange={(nextValue) => onChange(nextValue === "true")}
        options={[
          { label: "True", value: "true" },
          { label: "False", value: "false" },
        ]}
        size="sm"
        value={String(Boolean(value))}
      />
    );
  }

  if (variable.type === "dropdown" && variable.options.length > 0) {
    return (
      <SelectMenu
        onChange={onChange}
        options={variable.options.map((option) => ({ label: option, value: option }))}
        size="sm"
        value={String(value)}
      />
    );
  }

  return (
    <input
      className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
      onChange={(event) => onChange(event.target.value)}
      placeholder="Value"
      value={String(value)}
    />
  );
}

function EmptyTree({ onAddRoot }: { onAddRoot: () => void }) {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center">
      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-porcelain text-graphite">
        <FolderPlus size={20} />
      </div>
      <p className="mb-1 text-sm font-medium text-graphite">No folders yet.</p>
      <p className="mb-3 max-w-[260px] text-xs text-graphite/70">
        Media will be copied straight into the project root folder. Add folders
        to route footage, audio, and photos into subfolders.
      </p>
      <button
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
        onClick={onAddRoot}
        type="button"
      >
        <Plus size={13} />
        Add root folder
      </button>
    </div>
  );
}

function collectFolderIds(folders: FolderNode[]): Set<string> {
  return new Set(folders.flatMap((folder) => [folder.id, ...collectFolderIds(folder.children)]));
}

function firstFolderId(folders: FolderNode[]): string | null {
  return folders[0]?.id ?? null;
}

function lastRootFolderId(folders: FolderNode[]): string | null {
  return folders[folders.length - 1]?.id ?? null;
}

function countFolders(folders: FolderNode[]): number {
  return folders.reduce((count, folder) => count + 1 + countFolders(folder.children), 0);
}

function countTemplateFiles(folders: FolderNode[]): number {
  return folders.reduce(
    (count, folder) => count + folder.template_files.length + countTemplateFiles(folder.children),
    0,
  );
}

function findTemplateFile(folders: FolderNode[], selection: SelectedTemplateFile): TemplateFile | null {
  const folder = findFolder(folders, selection.folderId);
  return folder?.template_files[selection.index] ?? null;
}

function moveTemplateFileToFolder(
  folders: FolderNode[],
  selection: SelectedTemplateFile,
  targetFolderId: string,
): FolderNode[] {
  const file = findTemplateFile(folders, selection);
  if (!file || selection.folderId === targetFolderId) {
    return folders;
  }

  const withoutFile = updateFolder(folders, selection.folderId, (folder) => ({
    ...folder,
    template_files: folder.template_files.filter((_, index) => index !== selection.index),
  }));

  return updateFolder(withoutFile, targetFolderId, (folder) => ({
    ...folder,
    template_files: [...folder.template_files, file],
  }));
}

function templateFileRenamePattern(file: TemplateFile) {
  if (file.rename_pattern && file.rename_pattern.trim()) {
    return file.rename_pattern;
  }

  return file.name_from_folder ? "{folder_name}{ext}" : "{original_name}{ext}";
}

function templateFileContext(file: TemplateFile, folder: FolderNode, folderContext: TokenContext): TokenContext {
  const { extension, originalName } = fileNameParts(file.source_path);
  return {
    ...folderContext,
    folder_name: folderContext.folder_name ?? folder.name_pattern,
    original_name: originalName,
    extension,
  };
}

function folderRoleColor(role: FolderRole | null | undefined) {
  switch (role) {
    case "footage":
      return "text-emerald-700";
    case "audio":
      return "text-amber-500";
    case "photos":
      return "text-sky-600";
    case "documents":
      return "text-violet-600";
    case "other":
      return "text-graphite";
    default:
      return "text-amber-500";
  }
}

function dropdownVariablesForPattern(pattern: string, variables: PresetVariable[]) {
  const tokenIds = new Set(
    parsePattern(pattern)
      .filter((part) => part.type === "token")
      .map((part) => part.value),
  );

  return variables.filter(
    (variable) => variable.type === "dropdown" && variable.options.length > 0 && tokenIds.has(variable.id),
  );
}

function resolveFolderName(
  folder: FolderNode,
  variables: PresetVariable[],
  tokenValues: Record<string, string>,
) {
  const parts = parsePattern(folder.name_pattern);
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.value;
      }

      const variable = variables.find((candidate) => candidate.id === part.value);
      if (!variable || variable.type !== "dropdown") {
        return `{${part.value}}`;
      }

      return effectiveTokenValue(variable, tokenValues) || `{${part.value}}`;
    })
    .join("");
}

function resolvedTokenValuesForFolder(
  folder: FolderNode,
  variables: PresetVariable[],
  tokenValues: Record<string, string>,
) {
  return Object.fromEntries(
    dropdownVariablesForPattern(folder.name_pattern, variables).map((variable) => [
      variable.id,
      effectiveTokenValue(variable, tokenValues),
    ]),
  );
}

function effectiveTokenValue(variable: PresetVariable, tokenValues: Record<string, string>) {
  const storedValue = tokenValues[variable.id];
  if (storedValue && variable.options.includes(storedValue)) {
    return storedValue;
  }

  if (typeof variable.default === "string" && variable.options.includes(variable.default)) {
    return variable.default;
  }

  return variable.options[0] ?? "";
}

function defaultConditionValue(variable: PresetVariable): string | boolean {
  if (variable.type === "boolean") {
    return typeof variable.default === "boolean" ? variable.default : true;
  }

  if (variable.type === "dropdown") {
    if (typeof variable.default === "string" && variable.options.includes(variable.default)) {
      return variable.default;
    }
    return variable.options[0] ?? "";
  }

  return typeof variable.default === "string" ? variable.default : "";
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function fileNameParts(path: string) {
  const fileName = fileNameFromPath(path);
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return { originalName: fileName, extension: "" };
  }

  return {
    originalName: fileName.slice(0, extensionIndex),
    extension: fileName.slice(extensionIndex),
  };
}

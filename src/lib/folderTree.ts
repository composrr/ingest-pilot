import type { FolderNode, FolderRole } from "./types";

export type FolderTreeRow = {
  depth: number;
  folder: FolderNode;
  guides: boolean[];
  hasChildren: boolean;
  isLast: boolean;
  canMoveDown: boolean;
  canMoveUp: boolean;
  canIndent: boolean;
  canOutdent: boolean;
};

export type FolderDropPosition = "before" | "inside" | "after";

export function createFolderNode(namePattern = "New Folder"): FolderNode {
  return {
    id: `folder_${crypto.randomUUID().slice(0, 8)}`,
    name_pattern: namePattern,
    is_footage_destination: false,
    children: [],
    template_files: [],
  };
}

export function flattenFolderTree(
  folders: FolderNode[],
  expandedIds: Set<string>,
  depth = 0,
  guides: boolean[] = [],
): FolderTreeRow[] {
  return folders.flatMap((folder, index) => {
    const isLast = index === folders.length - 1;
    const row: FolderTreeRow = {
      depth,
      folder,
      guides,
      hasChildren: folder.children.length > 0,
      isLast,
      canMoveDown: !isLast,
      canMoveUp: index > 0,
      canIndent: index > 0,
      canOutdent: depth > 0,
    };

    if (!expandedIds.has(folder.id)) {
      return [row];
    }

    return [row, ...flattenFolderTree(folder.children, expandedIds, depth + 1, [...guides, !isLast])];
  });
}

export function findFolder(folders: FolderNode[], folderId: string): FolderNode | null {
  for (const folder of folders) {
    if (folder.id === folderId) {
      return folder;
    }

    const child = findFolder(folder.children, folderId);
    if (child) {
      return child;
    }
  }

  return null;
}

export function addFolder(folders: FolderNode[], parentId: string | null): FolderNode[] {
  const folder = createFolderNode();
  if (!parentId) {
    return [...folders, folder];
  }

  return updateFolder(folders, parentId, (parent) => ({
    ...parent,
    children: [...parent.children, folder],
  }));
}

export function updateFolder(
  folders: FolderNode[],
  folderId: string,
  update: (folder: FolderNode) => FolderNode,
): FolderNode[] {
  return folders.map((folder) => {
    if (folder.id === folderId) {
      return update(folder);
    }

    return {
      ...folder,
      children: updateFolder(folder.children, folderId, update),
    };
  });
}

export function removeFolder(folders: FolderNode[], folderId: string): FolderNode[] {
  return folders
    .filter((folder) => folder.id !== folderId)
    .map((folder) => ({
      ...folder,
      children: removeFolder(folder.children, folderId),
    }));
}

export function duplicateFolder(folders: FolderNode[], folderId: string): FolderNode[] {
  const tree = structuredClone(folders);
  const path = findPath(tree, folderId);
  if (!path) {
    return folders;
  }

  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  const siblings = getChildrenAtPath(tree, parentPath);
  siblings.splice(index + 1, 0, cloneFolder(siblings[index]));
  return tree;
}

export function moveFolder(folders: FolderNode[], folderId: string, direction: -1 | 1): FolderNode[] {
  const tree = structuredClone(folders);
  const path = findPath(tree, folderId);
  if (!path) {
    return folders;
  }

  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  const siblings = getChildrenAtPath(tree, parentPath);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= siblings.length) {
    return folders;
  }

  const [folder] = siblings.splice(index, 1);
  siblings.splice(nextIndex, 0, folder);
  return tree;
}

export function indentFolder(folders: FolderNode[], folderId: string): FolderNode[] {
  const tree = structuredClone(folders);
  const path = findPath(tree, folderId);
  if (!path) {
    return folders;
  }

  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  if (index === 0) {
    return folders;
  }

  const siblings = getChildrenAtPath(tree, parentPath);
  const [folder] = siblings.splice(index, 1);
  siblings[index - 1].children = [...siblings[index - 1].children, folder];
  return tree;
}

export function outdentFolder(folders: FolderNode[], folderId: string): FolderNode[] {
  const tree = structuredClone(folders);
  const path = findPath(tree, folderId);
  if (!path || path.length < 2) {
    return folders;
  }

  const index = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  const grandParentPath = path.slice(0, -2);
  const parentIndex = parentPath[parentPath.length - 1];
  const parentSiblings = getChildrenAtPath(tree, grandParentPath);
  const parent = parentSiblings[parentIndex];
  const [folder] = parent.children.splice(index, 1);
  parentSiblings.splice(parentIndex + 1, 0, folder);
  return tree;
}

export function moveFolderTo(
  folders: FolderNode[],
  draggedId: string,
  targetId: string,
  position: FolderDropPosition,
): FolderNode[] {
  if (draggedId === targetId) {
    return folders;
  }

  const draggedFolder = findFolder(folders, draggedId);
  if (!draggedFolder || findFolder(draggedFolder.children, targetId)) {
    return folders;
  }

  const removed = removeFolderWithNode(folders, draggedId);
  if (!removed.folder) {
    return folders;
  }

  return insertFolderAtTarget(removed.folders, removed.folder, targetId, position);
}

export function setFootageDestination(folders: FolderNode[], folderId: string): FolderNode[] {
  return folders.map((folder) => {
    const isTarget = folder.id === folderId;

    return {
      ...folder,
      is_footage_destination: isTarget,
      role: isTarget ? "footage" : folder.role,
      children: setFootageDestination(folder.children, folderId),
    };
  });
}

export function ensureFootageDestination(folders: FolderNode[]): FolderNode[] {
  if (folders.length === 0 || hasFootageDestination(folders)) {
    return folders;
  }

  return setFootageDestination(folders, folders[0].id);
}

function hasFootageDestination(folders: FolderNode[]): boolean {
  return folders.some((folder) => folder.is_footage_destination || hasFootageDestination(folder.children));
}

function findPath(folders: FolderNode[], folderId: string, prefix: number[] = []): number[] | null {
  for (const [index, folder] of folders.entries()) {
    const path = [...prefix, index];
    if (folder.id === folderId) {
      return path;
    }

    const childPath = findPath(folder.children, folderId, path);
    if (childPath) {
      return childPath;
    }
  }

  return null;
}

function getChildrenAtPath(folders: FolderNode[], path: number[]) {
  let children = folders;
  for (const index of path) {
    children = children[index].children;
  }
  return children;
}

function cloneFolder(folder: FolderNode): FolderNode {
  return {
    ...structuredClone(folder),
    id: `folder_${crypto.randomUUID().slice(0, 8)}`,
    name_pattern: `${folder.name_pattern} Copy`,
    children: folder.children.map(cloneFolder),
  };
}

function removeFolderWithNode(
  folders: FolderNode[],
  folderId: string,
): { folders: FolderNode[]; folder: FolderNode | null } {
  let removedFolder: FolderNode | null = null;
  const nextFolders = folders
    .filter((folder) => {
      if (folder.id === folderId) {
        removedFolder = folder;
        return false;
      }
      return true;
    })
    .map((folder) => {
      const result = removeFolderWithNode(folder.children, folderId);
      if (result.folder) {
        removedFolder = result.folder;
      }
      return {
        ...folder,
        children: result.folders,
      };
    });

  return { folders: nextFolders, folder: removedFolder };
}

function insertFolderAtTarget(
  folders: FolderNode[],
  folderToInsert: FolderNode,
  targetId: string,
  position: FolderDropPosition,
): FolderNode[] {
  const targetIndex = folders.findIndex((folder) => folder.id === targetId);
  if (targetIndex !== -1) {
    const nextFolders = [...folders];
    if (position === "inside") {
      const target = nextFolders[targetIndex];
      nextFolders[targetIndex] = {
        ...target,
        children: [...target.children, folderToInsert],
      };
      return nextFolders;
    }

    nextFolders.splice(position === "before" ? targetIndex : targetIndex + 1, 0, folderToInsert);
    return nextFolders;
  }

  return folders.map((folder) => ({
    ...folder,
    children: insertFolderAtTarget(folder.children, folderToInsert, targetId, position),
  }));
}

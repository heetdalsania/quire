export interface FileNode {
  name: string;
  path: string;
  children?: FileNode[];
}

/** Paths come from the vault API and always use forward slashes. */
export function fileTree(paths: string[]): FileNode[] {
  const root: FileNode[] = [];
  const folders = new Map<string, FileNode>();
  for (const path of new Set(paths)) {
    const parts = path.split("/");
    let children = root;
    let parent = "";
    for (const name of parts.slice(0, -1)) {
      parent = parent ? `${parent}/${name}` : name;
      let folder = folders.get(parent);
      if (!folder) {
        folder = { name, path: parent, children: [] };
        folders.set(parent, folder);
        children.push(folder);
      }
      children = folder.children!;
    }
    children.push({ name: parts.at(-1)!, path });
  }
  const sort = (nodes: FileNode[]): FileNode[] => {
    nodes.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    for (const node of nodes) if (node.children) sort(node.children);
    return nodes;
  };
  return sort(root);
}

export function matchingFiles(paths: string[], query: string, contentPaths: string[]): string[] {
  const needle = query.toLowerCase();
  const available = new Set(paths);
  return [...new Set([
    ...paths.filter((path) => path.toLowerCase().includes(needle)),
    ...contentPaths.filter((path) => available.has(path)),
  ])];
}

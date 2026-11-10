// "Save to a folder" through the File System Access API (Chromium). Blocks are staged in OPFS while they
// arrive (so a reload resumes without losing verified blocks), and each file is copied into the chosen
// folder as soon as it passes the whole-file SHA-256 check (docs/design/DESIGN_DEVIATIONS.md F16).

interface DirectoryPickerWindow {
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}
interface PermissionHandle {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
}

export function folderPickerAvailable(w: Window = window): boolean {
  return isSecureContext && typeof (w as unknown as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

/** Asks the user for a folder (must run inside a click handler). Returns null when the user cancels. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ id: 'share-anywhere', mode: 'readwrite' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** Whether writing to a remembered folder is still allowed; `ask` must come from a user gesture. */
export async function folderPermission(dir: FileSystemDirectoryHandle, ask = false): Promise<boolean> {
  const h = dir as unknown as PermissionHandle;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return ask && h.requestPermission ? (await h.requestPermission({ mode: 'readwrite' })) === 'granted' : false;
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** "photo.jpg" → "photo (1).jpg" when the folder already has that name. */
export async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  if (!(await exists(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

/** Streams a verified file into the folder without loading it into memory; returns the name used. */
export async function copyIntoFolder(dir: FileSystemDirectoryHandle, file: File): Promise<string> {
  const name = await freeName(dir, file.name);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await file.stream().pipeTo(w);
  return name;
}

/** Offers a finished file as a browser download (disk-backed File or Blob; nothing is copied into memory). */
export function downloadFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

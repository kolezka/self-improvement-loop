// Read-only filesystem probe: is a path on a local filesystem SQLite can lock
// safely? Shared by the curation store and the loop-state database. It spawns
// /sbin/mount on macOS, so it stays out of the @sil/core index and therefore
// out of the hooks module bundle.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Deepest existing ancestor of `path` (or `path` itself), resolved. */
export function nearestExisting(path: string): string {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

export type FilesystemClass = "local" | "unsupported" | "unknown";

const DARWIN_LOCAL = new Set(["apfs", "hfs"]);
const LINUX_LOCAL = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "tmpfs", "zfs", "overlay"]);
const KNOWN_REMOTE = new Set([
  "nfs",
  "nfs4",
  "smbfs",
  "cifs",
  "smb3",
  "afpfs",
  "webdav",
  "ftp",
  "9p",
  "ceph",
  "glusterfs",
  "lustre",
  "virtiofs",
  "autofs",
  "sshfs",
  "osxfuse",
  "macfuse",
  "fuse",
]);

interface MountEntry {
  mountPoint: string;
  fsType: string;
  local: boolean | null;
}

function contains(mountPoint: string, path: string): boolean {
  if (mountPoint === "/") return path.startsWith("/");
  return path === mountPoint || path.startsWith(`${mountPoint}/`);
}

function classifyEntries(entries: MountEntry[], path: string, localTypes: ReadonlySet<string>): FilesystemClass {
  let best: MountEntry | null = null;
  // Later entries shadow earlier ones at the same mount point.
  for (const entry of entries) {
    if (contains(entry.mountPoint, path) && (best === null || entry.mountPoint.length >= best.mountPoint.length)) best = entry;
  }
  if (best === null) return "unknown";
  const type = best.fsType.toLowerCase();
  if (KNOWN_REMOTE.has(type) || type.startsWith("fuse.") || best.local === false) return "unsupported";
  if (localTypes.has(type)) return "local";
  return "unknown";
}

/** Classify `path` against `/sbin/mount` output. Requires the `local` flag. */
export function classifyDarwinMounts(mountOutput: string, path: string): FilesystemClass {
  const entries: MountEntry[] = [];
  for (const line of mountOutput.split("\n")) {
    const m = /^.+? on (\/.*) \(([^()]*)\)$/.exec(line);
    if (!m) continue;
    const flags = m[2]!.split(",").map((part) => part.trim());
    entries.push({ mountPoint: m[1]!, fsType: flags[0] ?? "", local: flags.includes("local") });
  }
  // An apfs or hfs mount without the local flag is not trusted as local.
  return classifyEntries(entries, path, DARWIN_LOCAL);
}

function unescapeMountinfo(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Classify `path` against /proc/self/mountinfo text. */
export function classifyLinuxMountinfo(mountinfo: string, path: string): FilesystemClass {
  const entries: MountEntry[] = [];
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const head = line.slice(0, separator).split(" ");
    const tail = line.slice(separator + 3).split(" ");
    if (head.length < 6 || tail.length < 1) continue;
    entries.push({ mountPoint: unescapeMountinfo(head[4]!), fsType: tail[0]!, local: null });
  }
  return classifyEntries(entries, path, LINUX_LOCAL);
}

const MAX_MOUNT_TABLE_BYTES = 4 * 1024 * 1024;

/** Read-only, bounded probe of the filesystem holding `path`. */
export function probeFilesystem(path: string): FilesystemClass {
  let real: string;
  try {
    real = realpathSync(nearestExisting(path));
  } catch {
    return "unknown";
  }
  try {
    if (process.platform === "darwin") {
      const run = Bun.spawnSync(["/sbin/mount"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "ignore", timeout: 2000 });
      if (run.exitCode !== 0 || run.stdout.length > MAX_MOUNT_TABLE_BYTES) return "unknown";
      return classifyDarwinMounts(run.stdout.toString("utf8"), real);
    }
    if (process.platform === "linux") {
      const text = readFileSync("/proc/self/mountinfo", "utf8");
      if (text.length > MAX_MOUNT_TABLE_BYTES) return "unknown";
      return classifyLinuxMountinfo(text, real);
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

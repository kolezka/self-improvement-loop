import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { fsx, paths, StateReadError } from "@sil/core";
import type { LogArgs } from "../args.ts";

const TAIL_BLOCK_SIZE = 64 * 1024;

// Injectable so a test can wrap the reader and count bytes actually read,
// without reaching into node:fs globals.
export interface TailIo {
  existsSync: (path: string) => boolean;
  openSync: (path: string, flags: string) => number;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
  statSync: (path: string) => { size: number };
}

export const REAL_TAIL_IO: TailIo = { existsSync, openSync, readSync, closeSync, statSync };

/** Last n lines without reading the whole file: seek from the end in 64 KiB
 * blocks until n newlines are found or the file start is reached. `knownSize`
 * lets a caller that already stat'ed the file (logsTail below) skip a second
 * statSync; omit it to have tailLines check the file itself. */
export function tailLines(path: string, n: number, io: TailIo = REAL_TAIL_IO, knownSize?: number): string[] {
  if (knownSize === undefined && !io.existsSync(path)) return [];
  const fd = io.openSync(path, "r");
  let data: Buffer;
  try {
    const fileSize = knownSize ?? io.statSync(path).size;
    let pos = fileSize;
    const chunks: Buffer[] = [];
    let newlineCount = 0;
    while (pos > 0 && newlineCount <= n) {
      const readSize = Math.min(TAIL_BLOCK_SIZE, pos);
      pos -= readSize;
      const block = Buffer.alloc(readSize);
      io.readSync(fd, block, 0, readSize, pos);
      for (const byte of block) if (byte === 0x0a) newlineCount++;
      chunks.unshift(block);
    }
    data = Buffer.concat(chunks);
  } finally {
    io.closeSync(fd);
  }
  const text = data.toString("utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

export function logsTail(args: LogArgs) {
  const path = paths.logFile(args.name);
  // One statSync instead of existsSync-then-statSync: the two-call form can
  // race a log rotation (existsSync true, then statSync throws ENOENT) and
  // 500 the op instead of reporting a missing file.
  // Only a log that is not there (ENOENT) reads as absent. One that cannot be
  // reached or read is an error, not "no log yet".
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    if (fsx.errnoCode(err) === "ENOENT") return { name: args.name, path, exists: false, size: 0, lines: [] };
    throw new StateReadError(`the ${args.name} log cannot be read (${fsx.errnoCode(err)})`);
  }
  let lines: string[];
  try {
    lines = tailLines(path, args.lines, REAL_TAIL_IO, size);
  } catch (err) {
    throw new StateReadError(`the ${args.name} log cannot be read (${fsx.errnoCode(err)})`);
  }
  return { name: args.name, path, exists: true, size, lines };
}

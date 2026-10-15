/**
 * Resume state: which pieces are verified, plus the size and modification
 * time of every selected file when that was recorded, and the totals that
 * seeding limits count (uploaded, downloaded, time seeded). On the next start, if
 * every file still matches, the bitfield is trusted and nothing is re-hashed;
 * otherwise the engine re-checks from disk. Written atomically (temporary
 * file, then rename), so a crash never leaves a torn state file.
 */

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

/** What is saved for one torrent. */
export interface ResumeData {
  infoHash: string;
  /** Verified pieces, base64 of the bitfield bytes. */
  bitfield: string;
  /** Per file: size and mtime when saved, or null for unselected files. */
  files: Array<{ size: number; mtimeMs: number } | null>;
  /** All-time byte totals and seconds spent seeding. */
  uploaded?: number;
  downloaded?: number;
  seedSeconds?: number;
  /** Seed mode: pieces still trusted without a hash, base64 of a bitfield. */
  unverified?: string;
}

/** Where a torrent's resume state lives. */
export function resumePath(dir: string, infoHashHex: string): string {
  return join(dir, `${infoHashHex}.resume.json`);
}

/** Saves resume state atomically. */
export async function saveResume(path: string, data: ResumeData): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data));
  await fsp.rename(temp, path);
}

/** Loads resume state, or null if there is none or it is unreadable. */
export async function loadResume(path: string): Promise<ResumeData | null> {
  try {
    const data = JSON.parse(await fsp.readFile(path, "utf8")) as ResumeData;
    return typeof data.bitfield === "string" && Array.isArray(data.files) ? data : null;
  } catch {
    return null;
  }
}

/** Deletes resume state, ignoring a missing file. */
export async function deleteResume(path: string): Promise<void> {
  await fsp.rm(path, { force: true });
}

/**
 * Whether saved state still describes the files on disk: every file selected
 * now was selected then, with the same size and modification time.
 */
export function resumeMatches(saved: ResumeData, current: Array<{ size: number; mtimeMs: number } | null>): boolean {
  if (saved.files.length !== current.length) return false;
  return current.every((now, i) => {
    if (!now) return true;
    const then = saved.files[i];
    return !!then && then.size === now.size && then.mtimeMs === now.mtimeMs;
  });
}

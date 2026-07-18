// Hardened workspace file reader. Port of internal/diff/workspace_file.go.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, withinBase } from '../util/path.js';

export function readWorkspaceFileForDiff(repoDir: string, relPath: string): Buffer {
  let repoRoot: string;
  try {
    repoRoot = canonicalPath(repoDir);
  } catch (err) {
    throw new Error(`resolve repository path ${JSON.stringify(repoDir)}: ${(err as Error).message}`);
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} must be relative, not absolute`);
  }

  const fullPath = path.join(repoRoot, relPath);
  if (!withinBase(repoRoot, fullPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  let parent: string;
  try {
    parent = fs.realpathSync(path.dirname(fullPath));
  } catch (err) {
    throw new Error(`resolve parent path for ${JSON.stringify(relPath)}: ${(err as Error).message}`);
  }
  if (!withinBase(repoRoot, parent)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  let info: fs.Stats;
  try {
    info = fs.lstatSync(fullPath);
  } catch (err) {
    throw new Error(`stat file ${JSON.stringify(relPath)}: ${(err as Error).message}`);
  }
  if (info.isDirectory()) {
    throw new Error(`file path ${JSON.stringify(relPath)} is a directory`);
  }
  if (info.isSymbolicLink()) {
    // Symlinks return their target text rather than being followed.
    try {
      return Buffer.from(fs.readlinkSync(fullPath));
    } catch (err) {
      throw new Error(`read symlink ${JSON.stringify(relPath)}: ${(err as Error).message}`);
    }
  }

  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(fullPath);
  } catch (err) {
    throw new Error(`resolve file ${JSON.stringify(relPath)}: ${(err as Error).message}`);
  }
  if (!withinBase(repoRoot, resolvedPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }
  try {
    return fs.readFileSync(resolvedPath);
  } catch (err) {
    throw new Error(`read file ${JSON.stringify(relPath)}: ${(err as Error).message}`);
  }
}

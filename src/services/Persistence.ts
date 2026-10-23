import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Manifest, Preferences, Project, ThreadRecord } from '../shared/types.js';
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from '../shared/sidebar-layout.js';

export class PersistenceError extends Error {
  constructor(readonly code: 'unreadable-metadata' | 'unsafe-storage' | 'filesystem', readonly path: string, reason: string) {
    super(`${code === 'unsafe-storage' ? 'Refusing unsafe app storage' : 'Could not access app metadata'} at ${path}: ${reason}`);
    this.name = 'PersistenceError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}.`);
  return value;
}
function identifier(value: unknown): string {
  const id = text(value, 'UUID');
  if (!UUID.test(id)) throw new Error('Invalid UUID.');
  return id;
}
function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Expected a boolean.');
  return value;
}
function absolutePath(value: unknown, field: string): string {
  const path = text(value, field);
  if (!isAbsolute(path) || path.includes('\0')) throw new Error(`Invalid absolute ${field}.`);
  return path;
}
function date(value: unknown): string {
  const result = text(value, 'date');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error('Invalid ISO date.');
  return result;
}

/** Parse Swift's Codable schema, retaining UUID spelling and original ISO date strings. */
function manifestFromJSON(value: unknown): Manifest {
  const root = object(value);
  if (!Array.isArray(root.projects) || !Array.isArray(root.threads)) throw new Error('Missing projects or threads array.');
  const projects: Project[] = root.projects.map((value: unknown) => {
    const item = object(value);
    return { id: identifier(item.id), path: absolutePath(item.path, 'project path'), expanded: flag(item.expanded, true) };
  });
  const threads: ThreadRecord[] = root.threads.map((value: unknown) => {
    const item = object(value);
    const thread: ThreadRecord = { id: identifier(item.id), projectPath: absolutePath(item.projectPath, 'project path'),
      displayTitle: item.displayTitle === undefined ? 'New thread' : text(item.displayTitle, 'title'),
      ompSessionDirectory: absolutePath(item.ompSessionDirectory, 'session directory'), createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
      draft: item.draft === undefined ? '' : text(item.draft, 'draft'), wasRunning: flag(item.wasRunning, false) };
    if (item.lastModel !== undefined && item.lastModel !== null) thread.lastModel = text(item.lastModel, 'model');
    if (item.nativeTitleAttemptedFor !== undefined && item.nativeTitleAttemptedFor !== null) thread.nativeTitleAttemptedFor = text(item.nativeTitleAttemptedFor, 'native title session');
    if (item.ompSessionFile !== undefined && item.ompSessionFile !== null) thread.ompSessionFile = absolutePath(item.ompSessionFile, 'session file');
    return thread;
  });
  for (const ids of [projects.map(project => project.id.toLowerCase()), threads.map(thread => thread.id.toLowerCase())]) {
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate metadata UUID.');
  }
  let selectedThreadID = root.selectedThreadID === undefined || root.selectedThreadID === null ? null : identifier(root.selectedThreadID);
  if (selectedThreadID !== null) {
    const selected = threads.find(thread => thread.id.toLowerCase() === selectedThreadID?.toLowerCase());
    if (!selected) throw new Error('Selected thread does not exist.');
    selectedThreadID = selected.id;
  }
  return { projects, threads, selectedThreadID, sidebarVisible: flag(root.sidebarVisible, true) };
}
function preferencesFromJSON(value: unknown): Preferences {
  const root = object(value);
  const appearance = root.appearance ?? 'system';
  if (appearance !== 'system' && appearance !== 'light' && appearance !== 'dark') throw new Error('Invalid appearance.');
  const sidebarWidth = root.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
  if (typeof sidebarWidth !== 'number' || !Number.isFinite(sidebarWidth) || sidebarWidth < 180 || sidebarWidth > 600) throw new Error('Invalid sidebar width.');
  const defaultProjectPath = root.defaultProjectPath === undefined ? '' : text(root.defaultProjectPath, 'default project');
  if (defaultProjectPath && (!isAbsolute(defaultProjectPath) || defaultProjectPath.includes('\0'))) throw new Error('Invalid default project path.');
  return { executableOverride: root.executableOverride === undefined ? '' : text(root.executableOverride, 'executable override'), appearance,
    defaultProjectPath, sidebarWidth: clampSidebarWidth(sidebarWidth) };
}

/** Metadata only. Conversation history remains owned by OMP in dedicated directories. */
export class Persistence {
  static readonly defaultRoot = join(homedir(), 'Library/Application Support/PiDesktop');
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  private rootIdentity: Stats | null = null;

  constructor(root = Persistence.defaultRoot) {
    const requested = resolve(root);
    let ancestor = dirname(requested);
    const suffix = [basename(requested)];
    while (true) {
      try { ancestor = realpathSync(ancestor); break; }
      catch (error) {
        if (!isMissing(error)) throw new PersistenceError('filesystem', ancestor, reason(error));
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new PersistenceError('filesystem', ancestor, reason(error));
        suffix.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
    this.root = join(ancestor, ...suffix);
    try {
      const info = lstatSync(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new PersistenceError('unsafe-storage', this.root, 'App root must be a real directory, not a symbolic link.');
      this.rootIdentity = info;
    } catch (error) { if (!isMissing(error)) throw error; }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async checkedRoot(create = false): Promise<boolean> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    let info: Stats;
    try { info = await lstat(this.root); }
    catch (error) { if (isMissing(error)) return false; throw new PersistenceError('filesystem', this.root, reason(error)); }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root ||
      (this.rootIdentity !== null && (this.rootIdentity.dev !== info.dev || this.rootIdentity.ino !== info.ino))) {
      throw new PersistenceError('unsafe-storage', this.root, 'App root was replaced or redirected.');
    }
    this.rootIdentity = info;
    return true;
  }

  private async readJSON(name: string): Promise<unknown | undefined> {
    if (!await this.checkedRoot()) return undefined;
    const path = join(this.root, name);
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error('Metadata is not a regular file.');
        const content = await file.readFile();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown;
      } finally { await file.close(); }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new PersistenceError('unreadable-metadata', path, reason(error));
    }
  }

  private async readManifest(): Promise<Manifest> {
    const value = await this.readJSON('manifest.json');
    if (value === undefined) return { projects: [], threads: [], selectedThreadID: null, sidebarVisible: true };
    try { return manifestFromJSON(value); }
    catch (error) { throw new PersistenceError('unreadable-metadata', join(this.root, 'manifest.json'), reason(error)); }
  }

  load(): Promise<Manifest> { return this.serial(() => this.readManifest()); }

  save(manifest: Manifest): Promise<void> {
    return this.serial(async () => {
      const valid = manifestFromJSON(manifest);
      // A failed startup must never turn corrupted user metadata into an empty manifest.
      await this.readManifest();
      await this.atomicJSON('manifest.json', valid);
    });
  }

  loadPreferences(): Promise<Preferences> {
    return this.serial(async () => {
      const value = await this.readJSON('prefs.json');
      if (value !== undefined) {
        try { return preferencesFromJSON(value); }
        catch (error) { throw new PersistenceError('unreadable-metadata', join(this.root, 'prefs.json'), reason(error)); }
      }
      const manifest = await this.readManifest();
      const selected = manifest.threads.find(thread => thread.id === manifest.selectedThreadID);
      return { executableOverride: '', appearance: 'system', defaultProjectPath: selected?.projectPath ?? manifest.projects[0]?.path ?? '', sidebarWidth: SIDEBAR_DEFAULT_WIDTH };
    });
  }

  savePreferences(preferences: Preferences): Promise<void> {
    return this.serial(async () => {
      const valid = preferencesFromJSON(preferences);
      const previous = await this.readJSON('prefs.json');
      if (previous !== undefined) {
        try { preferencesFromJSON(previous); }
        catch (error) { throw new PersistenceError('unreadable-metadata', join(this.root, 'prefs.json'), reason(error)); }
      }
      await this.atomicJSON('prefs.json', valid);
    });
  }

  private async atomicJSON(name: string, value: Manifest | Preferences): Promise<void> {
    await this.checkedRoot(true);
    const path = join(this.root, name);
    const temporary = join(this.root, `.${name}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await file.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await this.checkedRoot();
      await rename(temporary, path);
      created = false;
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { throw new PersistenceError('filesystem', path, reason(error)); }
    finally { if (created) { await this.checkedRoot(); await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); } }
  }

  sessionDirectory(id: string): string { return join(this.root, 'Threads', identifier(id), 'OMP'); }

  deleteThreadStorage(id: string): Promise<void> {
    identifier(id);
    return this.serial(async () => {
      if (!await this.checkedRoot()) return;
      const threads = join(this.root, 'Threads');
      const target = join(threads, id);
      const ancestors: { path: string; identity: Stats }[] = [];
      for (const path of [threads, target]) {
        let info: Stats;
        try { info = await lstat(path); } catch (error) { if (isMissing(error)) return; throw error; }
        if (!info.isDirectory() || info.isSymbolicLink()) throw new PersistenceError('unsafe-storage', path, 'Thread storage must not be a symbolic link.');
        ancestors.push({ path, identity: info });
      }
      const checkScope = async (): Promise<void> => {
        await this.checkedRoot();
        for (const ancestor of ancestors) {
          const info = await lstat(ancestor.path);
          if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== ancestor.identity.dev || info.ino !== ancestor.identity.ino || await realpath(ancestor.path) !== ancestor.path) {
            throw new PersistenceError('unsafe-storage', ancestor.path, 'Directory changed during deletion.');
          }
        }
      };
      // No following links: nested symlinks are entries to unlink, not directories to visit.
      // Each descent pins the directory identity and checks all ancestors before mutation.
      const remove = async (path: string): Promise<void> => {
        await checkScope();
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          await checkScope();
          await unlink(path);
          return;
        }
        const descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const identity = await descriptor.stat();
          if (identity.dev !== info.dev || identity.ino !== info.ino) throw new PersistenceError('unsafe-storage', path, 'Directory changed during deletion.');
          ancestors.push({ path, identity });
          for (const child of await readdir(path)) {
            if (child === '.' || child === '..' || child.includes(sep)) throw new PersistenceError('unsafe-storage', path, 'Invalid directory entry.');
            await remove(join(path, child));
          }
          await checkScope();
          ancestors.pop();
          await rmdir(path);
        } finally { await descriptor.close(); }
      };
      try { await remove(target); }
      catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError('filesystem', target, reason(error));
      }
    });
  }
}

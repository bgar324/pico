import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolve Markdown file links against the owning project, not the app bundle. */
export async function resolveProjectLink(projectPath: string, href: string): Promise<string> {
  const root = await realpath(projectPath);
  const url = new URL(href, pathToFileURL(root + sep));
  if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost') throw new Error('Only local project files can open here.');
  const path = await realpath(fileURLToPath(url));
  const inside = relative(root, path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('File links must stay inside this conversation\'s project.');
  return path;
}

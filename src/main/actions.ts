import { shell } from 'electron';
import type { AppRequest, AppResult } from '../shared/types';
import { AppController } from './AppController';
import { GitService } from '../services/GitService';
import { resolveProjectLink } from '../services/links';
import type { ProviderConnections } from '../services/ProviderConnections';

export class DesktopActions {
  constructor(private readonly controller: AppController, private readonly connections: ProviderConnections, private readonly git = new GitService()) {}
  private project(path: string): string {
    if (!this.controller.manifest.projects.some(project => project.path === path) && !this.controller.manifest.threads.some(thread => thread.projectPath === path)) throw new Error('Choose a saved project before reading its files.');
    return path;
  }
  async perform(request: Exclude<AppRequest, { kind: 'copy-message' | 'context-menu' | 'close-context-menu' }>): Promise<AppResult> {
    switch (request.kind) {
      case 'snapshot': return this.controller.snapshot();
      case 'open-project': await this.controller.openProject(); return null;
      case 'add-project': await this.controller.addProject(request.path); return null;
      case 'new-thread': await this.controller.newThread(request.projectPath); return null;
      case 'select-thread': await this.controller.selectThread(request.id, request.reopen ?? false); return null;
      case 'draft': this.controller.setDraft(request.id, request.text); return null;
      case 'prompt': return this.controller.prompt(request.id, request.message, request.steer, request.images);
      case 'edit-message': return this.controller.editMessage(request.id, request.messageID, request.message);
      case 'abort': await (await this.controller.runtimeFor(request.id)).stop(); return null;
      case 'promote-queued': return (await this.controller.runtimeFor(request.id)).promoteQueued(request.message);
      case 'retract-queued': {
        const runtime = this.controller.runtimes.get(request.id);
        if (!runtime) return null;
        return runtime.retractQueued(request.queue, request.message, request.imageRef);
      }
      case 'queued-images': {
        const runtime = this.controller.runtimes.get(request.id);
        if (!runtime) throw new Error('Queued image preview has expired.');
        return runtime.getQueuedImages(request.imageRef);
      }
      case 'model': await (await this.controller.runtimeFor(request.id)).selectModel(request.modelID); return null;
      case 'thinking': await (await this.controller.runtimeFor(request.id)).selectThinking(request.level); return null;
      case 'dialog': return (await this.controller.runtimeFor(request.id)).respond(request.dialogID, request.fields);
      case 'rename-thread': await this.controller.renameThread(request.id, request.title); return null;
      case 'delete-thread': await this.controller.deleteThread(request.id); return null;
      case 'remove-project': this.controller.removeProject(request.id); return null;
      case 'locate-project': await this.controller.locateProject(this.project(request.path)); return null;
      case 'sidebar': this.controller.setSidebar(request.visible); return null;
      case 'project-expanded': this.controller.setProjectExpanded(request.id, request.expanded); return null;
      case 'preferences': await this.controller.updatePreferences(request.preferences); return null;
      case 'choose-executable': await this.controller.chooseExecutable(); return null;
      case 'test-connection': await this.controller.testConnection(); return null;
      case 'get-connections': return this.connections.snapshot();
      case 'connect-provider': return this.connections.login(request.providerId, request.flowId);
      case 'connection-input': await this.connections.submit(request.flowId, request.promptId, request.value); return null;
      case 'cancel-connection': return this.connections.cancel(request.flowId);
      case 'save-provider-key': return this.connections.setApiKey(request.providerId, request.key);
      case 'disconnect-provider': return this.connections.disconnect(request.providerId, request.credentialId);
      case 'diagnostics': await this.controller.diagnostics(); return null;
      case 'reveal-project': await this.controller.host.reveal(this.project(request.path)); return null;
      case 'reveal-session': {
        const thread = this.controller.manifest.threads.find(item => item.id === request.id);
        if (!thread) throw new Error('This conversation no longer exists.');
        await this.controller.host.reveal(thread.ompSessionDirectory); return null;
      }
      case 'terminal': await this.controller.terminal(request.id); return null;
      case 'attach-images': return this.controller.attachImages(request.id);
      case 'git-status': return this.git.snapshot(this.project(request.projectPath));
      case 'git-diff': return this.git.diff(this.project(request.projectPath), request.file);
      case 'open-file': {
        const path = await this.git.filePath(this.project(request.projectPath), request.file);
        if (request.reveal) await this.controller.host.reveal(path);
        else {
          const error = await shell.openPath(path);
          if (error) throw new Error(error);
        }
        return null;
      }
      case 'open-url': {
        const url = new URL(request.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP and HTTPS links can open externally.');
        await shell.openExternal(url.href); return null;
      }
      case 'open-local-link': {
        const thread = this.controller.manifest.threads.find(thread => thread.id === request.id);
        if (!thread) throw new Error('This conversation no longer exists.');
        const path = await resolveProjectLink(thread.projectPath, request.url);
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
        return null;
      }
      case 'session-stats': return (await this.controller.runtimeFor(request.id)).sessionStats();
      default: { const exhaustive: never = request; throw new Error(`Unsupported app action: ${String(exhaustive)}`); }
    }
  }
}

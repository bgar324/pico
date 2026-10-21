import { Menu, type BrowserWindow } from 'electron';

interface PendingMenu {
  menu: Menu;
  finish(index: number | null): void;
}

/** Owns one window's popup and its outstanding IPC reply. */
export class NativeContextMenu {
  private pending: PendingMenu | null = null;

  constructor(private readonly window: BrowserWindow, private readonly interceptForQA = false) {
    window.once('closed', () => this.close());
    window.webContents.once('destroyed', () => this.close());
  }

  open(items: string[]): Promise<number | null> {
    this.close();
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let settled = false;
      const pending: PendingMenu = {
        menu: Menu.buildFromTemplate(items.map((label, index) => ({ label, click: () => pending.finish(index) }))),
        finish: index => {
          if (settled) return;
          settled = true;
          if (this.pending === pending) this.pending = null;
          resolve(index);
        },
      };
      this.pending = pending;
      if (this.interceptForQA) return;
      try {
        pending.menu.popup({
          window: this.window,
          // Let an item click win even if the platform reports closure first.
          callback: () => { setImmediate(() => pending.finish(null)); },
        });
      } catch (error) {
        if (this.pending === pending) this.pending = null;
        settled = true;
        reject(error);
      }
    });
  }

  close(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.finish(null);
    if (!this.interceptForQA) pending.menu.closePopup();
  }

  /** Headless QA intercepts replies without opening an OS popup. */
  get interceptedItems(): string[] {
    if (!this.interceptForQA) throw new Error('Native menu interception is restricted to headless QA.');
    return this.pending?.menu.items.map(item => item.label) ?? [];
  }
  selectIntercepted(index: number): void {
    if (!this.interceptForQA) throw new Error('Native menu interception is restricted to headless QA.');
    const item = this.pending?.menu.items[index];
    if (!Number.isInteger(index) || !item) throw new Error('Missing intercepted menu action.');
    item.click({}, this.window, this.window.webContents);
  }
}

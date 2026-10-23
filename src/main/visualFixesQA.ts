import type { BrowserWindow } from 'electron';
import type { AppController } from './AppController';
import type { runComponentsQA } from './componentsQA';
import { formatContextUsage } from '../renderer/helpers';

type Qa = Parameters<typeof runComponentsQA>[2];
export async function runVisualFixesQA(window: BrowserWindow, controller: AppController, id: string, qa: Qa): Promise<void> {
  const runtime = await controller.runtimeFor(id);
  const original = {...controller.preferences};
  const evaluate = (source:string):Promise<unknown> => window.webContents.executeJavaScript(source);
  await qa.until('actual context available',()=>runtime.summary().contextUsage !== null);
  const usage=runtime.summary().contextUsage;if(!usage)throw new Error('Context unavailable');
  await evaluate('if (!document.querySelector(".composer-settings-menu:popover-open")) document.querySelector(".composer-settings-trigger").click()');
  await qa.until('context value rendered',async()=>await evaluate('document.querySelector(".context-usage").textContent')===formatContextUsage(usage));
  await evaluate('document.querySelector(".composer-settings-trigger").click()');
  const appearances: ('dark'|'light')[] = ['dark','light'];
  for(const appearance of appearances) {
    await controller.updatePreferences({...original,appearance});
    await qa.until('theme rendered',async()=>await evaluate('document.documentElement.dataset.theme')===appearance);
    qa.check(await evaluate('(() => {const sidebar=getComputedStyle(document.querySelector(".sidebar")).backgroundColor,shell=getComputedStyle(document.querySelector(".titlebar")).backgroundColor,main=getComputedStyle(document.querySelector(".main")).backgroundColor;return sidebar===shell && main!==shell;})()')===true, `${appearance} sidebar blends into app chrome while main canvas stays distinct`);
    await evaluate('document.querySelector(".composer-settings-trigger").click()');
    qa.check(await evaluate('(() => {const menu=document.querySelector(".composer-settings-menu:popover-open"),model=menu?.querySelector("[aria-label=Model]"),thinking=menu?.querySelector("[aria-label=\\"Thinking level\\"]"),usage=menu?.querySelector(".context-usage"),context=usage?.closest(".composer-context-row");if(!model || !thinking || !usage || !context)return false;const m=model.getBoundingClientRect(),t=thinking.getBoundingClientRect(),c=context.getBoundingClientRect(),bounds=menu.getBoundingClientRect();return !usage.hidden && m.height>0 && t.height>0 && c.height>0 && m.bottom<=t.top && t.bottom<=c.top && m.top>=bounds.top && c.bottom<=bounds.bottom;})()')===true, `${appearance} composer settings popover shows Model, Thinking, then Context`);
    await qa.capture(`visual-composer-settings-${appearance}`);
    await evaluate('document.querySelector(".composer-settings-trigger").click()');
    await evaluate('document.querySelectorAll(".activity-group,details[data-tool-id]").forEach(node=>{node.open=true;});document.querySelector(".tool-output")?.scrollIntoView({block:"center"})');
    await qa.capture(`visual-copy-blocks-${appearance}`);
    await qa.capture(`visual-fixes-${appearance}`);
    await evaluate('document.querySelector("[data-testid=settings]").click()');
    qa.check(await evaluate('Boolean(document.querySelector("dialog[open]"))')===true,'Library settings icon opens actual Settings');
    await evaluate(`document.querySelector('.settings-close').click()`);
  }
  await controller.updatePreferences(original);
}

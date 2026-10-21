import type { BrowserWindow } from 'electron';
import type { AppController } from './AppController';
import type { runComponentsQA } from './componentsQA';
import { formatContextUsage } from '../renderer/helpers';
import { isBusy } from '../shared/types';
import { record } from '../shared/validation';

type Qa = Parameters<typeof runComponentsQA>[2];

export async function checkConversationPresentation(window: BrowserWindow, controller: AppController, id: string, qa: Qa): Promise<void> {
  const runtime = await controller.runtimeFor(id);
  await qa.until('context usage reported', () => runtime.summary().contextUsage !== null);
  const usage = runtime.summary().contextUsage;
  if (!usage) throw new Error('OMP did not report context usage.');
  const expected = formatContextUsage(usage);
  await window.webContents.executeJavaScript('if (!document.querySelector(".composer-settings-menu:popover-open")) document.querySelector(".composer-settings-trigger").click()');
  await qa.until('context readout rendered', async () => (await window.webContents.executeJavaScript('document.querySelector(".context-usage").textContent')) === expected);
  qa.check((await window.webContents.executeJavaScript('(() => { const menu=document.querySelector(".composer-settings-menu:popover-open"),model=menu?.querySelector("[aria-label=Model]"),thinking=menu?.querySelector("[aria-label=\\"Thinking level\\"]"),usage=menu?.querySelector(".context-usage"),context=usage?.closest(".composer-context-row");if(!model || !thinking || !usage || !context)return false;const m=model.getBoundingClientRect(),t=thinking.getBoundingClientRect(),c=context.getBoundingClientRect(),bounds=menu.getBoundingClientRect();return !usage.hidden && m.height>0 && t.height>0 && c.height>0 && m.bottom<=t.top && t.bottom<=c.top && m.top>=bounds.top && c.bottom<=bounds.bottom; })()')) === true, 'Composer settings popover shows Model, Thinking, then Context');
  await window.webContents.executeJavaScript('document.querySelector(".composer-settings-trigger").click()');
  qa.check((await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("details > summary")).every(node => { const glyph=getComputedStyle(node,"::before").content; return glyph==="none" || glyph==="normal" || glyph===\'""\'; })')) === true, 'Expandable rows have no disclosure glyphs');
  await window.webContents.executeJavaScript('document.querySelectorAll(".activity-group").forEach(group => { group.open=false; });document.querySelector(".activity-group")?.scrollIntoView({block:"center"})');
  await qa.capture('conversation-activity-collapsed');
  await window.webContents.executeJavaScript('document.querySelectorAll(".activity-group").forEach(group => { group.open=true; });document.querySelector(".activity-group")?.scrollIntoView({block:"center"})');
  await qa.capture('conversation-activity-expanded');
  await window.webContents.executeJavaScript('document.querySelectorAll(".activity-group").forEach(group => { group.open=false; })');

  const original = window.getBounds();
  for (const {width,height} of [{width:1180,height:800},{width:900,height:620}]) {
    window.setSize(width, height);
    await qa.until('jump layout resized', async () => (await window.webContents.executeJavaScript('window.innerWidth')) === width);
    qa.check((await window.webContents.executeJavaScript('(() => { const mainNode=document.querySelector(".main"),main=mainNode.getBoundingClientRect(),right=main.right-parseFloat(getComputedStyle(mainNode).paddingRight),content=document.querySelector(".conversation-content").getBoundingClientRect(),composer=document.querySelector(".composer").getBoundingClientRect(),workspace=getComputedStyle(document.querySelector(".workspace"));return workspace.paddingLeft===workspace.paddingRight && Math.abs(content.left-main.left-(right-content.right))<1 && Math.abs(composer.left-main.left-(right-composer.right))<1; })()')) === true, `Main canvas, transcript and composer have symmetric horizontal gutters at ${width}px`);
    await window.webContents.executeJavaScript('(() => { const transcript=document.querySelector(".conversation-scroll"); transcript.scrollTop=0; transcript.dispatchEvent(new Event("scroll")); })()');
    const scrollable = await window.webContents.executeJavaScript('(() => {const transcript=document.querySelector(".conversation-scroll");return transcript.scrollHeight-transcript.clientHeight>=80;})()');
    if (scrollable !== true) {
      qa.check(await window.webContents.executeJavaScript('document.querySelector(".jump-latest").hidden') === true, `Short transcript does not show Jump to latest at ${width}px`);
      continue;
    }
    await qa.until('jump button shown', async () => (await window.webContents.executeJavaScript('!document.querySelector(".jump-latest").hidden')) === true);
    qa.check((await window.webContents.executeJavaScript('(() => { const jump=document.querySelector(".jump-latest").getBoundingClientRect(),composer=document.querySelector(".composer").getBoundingClientRect(); return Math.abs(jump.left+jump.width/2-composer.left-composer.width/2)<1 && jump.bottom<composer.top; })()')) === true, `Jump to latest is centered above the composer at ${width}px`);
    await qa.capture(`conversation-jump-centered-${width}`);
    await window.webContents.executeJavaScript('document.querySelector(".jump-latest").click()');
    await qa.until('jump returns to latest', async () => (await window.webContents.executeJavaScript('(() => { const transcript=document.querySelector(".conversation-scroll"); return document.querySelector(".jump-latest").hidden && transcript.scrollHeight-transcript.clientHeight-transcript.scrollTop<2; })()')) === true);
  }
  window.setSize(original.width, original.height);
}

export async function runRealStreamingCanary(window: BrowserWindow, controller: AppController, id: string, qa: Qa): Promise<void> {
  const runtime = await controller.runtimeFor(id);
  await window.webContents.executeJavaScript(`(() => {
    const root=document.querySelector('.conversation-content');
    const proof={started:0,intermediate:false,restarted:false,counts:new WeakMap(),firstParagraph:null,samples:[]};
    const started=event => {
      const node=event.target;
      if (!(node instanceof HTMLElement) || !node.classList.contains('stream-word') || !root.contains(node) || node.closest('pre,code,.reasoning')) return;
      proof.started++; const count=(proof.counts.get(node)||0)+1;proof.counts.set(node,count);if(count>1)proof.restarted=true;
      proof.firstParagraph ||= node.closest('p');
      let frames=0;
      const sample=()=>{
        if(!node.isConnected || frames++>12)return;
        const style=getComputedStyle(node),opacity=Number(style.opacity);
        if(opacity>.35 && opacity<1)proof.intermediate=true;
        if(proof.samples.length<80)proof.samples.push({opacity,filter:style.filter});
        if(opacity<1)requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    };
    root.addEventListener('animationstart',started);
    window.__piStreamProof=proof;window.__piStreamProofCleanup=()=>root.removeEventListener('animationstart',started);
  })()`);
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'no-preference'}] });
    const prompt = 'No tools. Start with a plain paragraph, then explain in roughly 250 words why preserving context helps a coding assistant. Include one short heading, a numbered list, bold text, inline code, and a short fenced code example. End with the exact marker STREAM_CANARY_492.';
    await window.webContents.executeJavaScript('if (!document.querySelector(".composer-settings-menu:popover-open")) document.querySelector(".composer-settings-trigger").click()');
    await qa.until('canary UI ready', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".composer-settings-menu:popover-open [aria-label=Model]:not(:disabled)"))')) === true);
    await window.webContents.executeJavaScript('document.querySelector(".composer-settings-trigger").click()');
    await window.webContents.executeJavaScript(`const input=document.querySelector('[data-testid=composer]');input.value=${JSON.stringify(prompt)};input.dispatchEvent(new Event('input',{bubbles:true}))`);
    await qa.until('canary send enabled', async () => (await window.webContents.executeJavaScript('!document.querySelector("[data-testid=send]").disabled')) === true);
    await window.webContents.executeJavaScript('document.querySelector("[data-testid=send]").click()');
    await qa.until('real stream word interpolation', async () => (await window.webContents.executeJavaScript('window.__piStreamProof.intermediate')) === true, 120000);
    await qa.capture('conversation-real-word-stream');
    await qa.until('canary settles', () => !isBusy(runtime.summary().status) && runtime.snapshot().messages.some(message => message.role === 'assistant' && message.text.includes('STREAM_CANARY_492')), 180000);
    const observation: unknown = await window.webContents.executeJavaScript('({intermediate:window.__piStreamProof.intermediate,restarted:window.__piStreamProof.restarted,paragraphPreserved:window.__piStreamProof.firstParagraph?.isConnected,samples:window.__piStreamProof.samples})');
    qa.check(record(observation) && observation.intermediate === true && observation.restarted === false && observation.paragraphPreserved === true, 'Real OMP words fade in without restarting prior words or replacing their paragraph');
    qa.check((await window.webContents.executeJavaScript('!document.querySelector("pre .stream-word,code .stream-word")')) === true, 'Code remains literal during word reveal');
    await qa.until('final word wrappers flushed', async () => (await window.webContents.executeJavaScript('!document.querySelector(".agent-message .stream-word")')) === true);
    qa.check((await window.webContents.executeJavaScript('document.querySelector(".conversation-content").textContent.includes("STREAM_CANARY_492")')) === true, 'Final streamed Markdown is complete and has no transient wrappers');
    await qa.capture('conversation-real-stream-settled');
  } finally {
    await window.webContents.executeJavaScript('window.__piStreamProofCleanup?.();delete window.__piStreamProof;delete window.__piStreamProofCleanup');
    window.webContents.debugger.detach();
  }
  await checkConversationPresentation(window, controller, id, qa);
}

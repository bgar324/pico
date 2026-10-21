import electron from 'electron';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' }, runtime: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } } });
const root = await mkdtemp(join(tmpdir(), 'pi-performance-'));
const resultPath = join(root, 'result.json');
try {
  await Promise.all([
    build({ entryPoints: ['scripts/performance-fixture.ts'], outfile: join(root, 'fixture.js'), bundle: true, platform: 'browser', target: 'chrome136', loader: { '.svg': 'text' } }),
    build({ entryPoints: ['src/renderer/index.ts'], outfile: join(root, 'app.js'), bundle: true, platform: 'browser', target: 'chrome136', minify: true, loader: { '.svg': 'text' } }),
    copyFile('src/renderer/style.css', join(root, 'style.css')),
    build({ entryPoints: ['scripts/performance-checks.ts'], outfile: join(root, 'checks.js'), bundle: true, platform: 'browser', target: 'chrome136', loader: { '.svg': 'text' } }),
  ]);
  await writeFile(join(root, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"><script src="fixture.js" defer></script><script src="app.js" defer></script></head><body><div id="app"></div></body></html>');
  const main = `
    import {app,BrowserWindow} from 'electron';
    import {mkdir,readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {randomUUID} from 'node:crypto';
    import {AppController} from './src/main/AppController';
    import {Persistence} from './src/services/Persistence';
    import {RpcClient} from './src/omp/RpcClient';
    const root=${JSON.stringify(root)};
    app.commandLine.appendSwitch('headless','new');app.commandLine.appendSwitch('disable-gpu');app.disableHardwareAcceleration();app.setPath('userData',join(root,'Chromium'));
    app.whenReady().then(async()=>{
      const window=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true}});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      await window.loadFile(join(root,'index.html'));
      const renderer=await window.webContents.executeJavaScript('window.runPerformance().catch(error=>({error:String(error),stack:error.stack}))');
      if(renderer.error)throw new Error(renderer.error+'\\n'+renderer.stack);
      const result={renderer};
      if(${JSON.stringify(values.check)}){
        await window.webContents.executeJavaScript(await readFile(join(root,'checks.js'),'utf8'));
        const checks=await window.webContents.executeJavaScript('window.checkPerformance().catch(error=>({error:String(error),stack:error.stack}))');
        if(checks.error)throw new Error(checks.error+'\\n'+checks.stack);
        result.checks=checks;
        // Leave the hit area during a real drag: pointer capture alone is not
        // sufficient on all Chromium/Electron input paths.
        const drag=await window.webContents.executeJavaScript('(async()=>{const r=document.querySelector(".sidebar-resize").getBoundingClientRect(),s=document.querySelector(".sidebar").getBoundingClientRect(),snapshot=await window.pi.request({kind:"snapshot"});return{x:r.x+12,y:r.y+120,width:s.width,preferences:snapshot.value.preferences}})()');
        window.webContents.debugger.attach('1.3');
        try{
          const input=window.webContents.debugger;
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x,y:drag.y});
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:drag.x,y:drag.y,button:'left',buttons:1,clickCount:1});
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x+48,y:drag.y,buttons:1});
          await window.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.x+48,y:drag.y,button:'left',buttons:0,clickCount:1});
          await window.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,0))))');
          const after=await window.webContents.executeJavaScript('(async()=>{const snapshot=await window.pi.request({kind:"snapshot"});return{width:document.querySelector(".sidebar").getBoundingClientRect().width,saved:snapshot.value.preferences.sidebarWidth,divider:document.querySelector(".titlebar-chat-divider").getBoundingClientRect().left,frame:document.querySelector(".main").getBoundingClientRect().left}})()');
          if(Math.abs(after.width-drag.width-48)>.5||Math.abs(after.saved-drag.width-48)>.5)throw new Error('Dragging outside the resize handle lost movement or failed to persist the resulting width.');
          result.checks.push('Native pointer resizing tracks movement beyond the handle and persists its final width without snap-back.');
          if(Math.abs(after.divider-after.frame)>.5)throw new Error('The chat header divider drifted away from the main frame after sidebar resizing.');
          result.checks.push('Chat header divider stays aligned with the actual main-frame edge after native sidebar resizing.');
          await window.webContents.executeJavaScript('window.pi.request('+JSON.stringify({kind:'preferences',preferences:drag.preferences})+')');
          await window.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,0))))');
          const trigger=await window.webContents.executeJavaScript('(()=>{const r=document.querySelector(".composer-settings-trigger").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...trigger});
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...trigger,button:'left',buttons:1,clickCount:1});
          await new Promise(resolve=>setTimeout(resolve,80));
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...trigger,button:'left',buttons:0,clickCount:1});
          await new Promise(resolve=>setTimeout(resolve,220));
          if(!await window.webContents.executeJavaScript('document.querySelector(".composer-settings-menu").matches(":popover-open")'))throw new Error('A held settings press caused its geometry observer to dismiss the newly opened menu.');
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...trigger,button:'left',buttons:1,clickCount:1});
          await input.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...trigger,button:'left',buttons:0,clickCount:1});
          if(await window.webContents.executeJavaScript('document.querySelector(".composer-settings-menu").matches(":popover-open")'))throw new Error('Clicking the open settings trigger dismissed and reopened its popover.');
          result.checks.push('Native held settings press stays open; a second pointer click toggles it closed without a dismissal/reopen loop.');
        }finally{window.webContents.debugger.detach();}
      }
      if(${JSON.stringify(values.runtime)}){
        let starts=0;const start=RpcClient.prototype.start;
        RpcClient.prototype.start=function(options){starts++;return start.call(this,options);};
        const project=join(root,'Project');await mkdir(project);
        const persistence=new Persistence(join(root,'Support'));const id=randomUUID();const date=new Date().toISOString();
        await persistence.save({projects:[{id:randomUUID(),path:project,expanded:true}],threads:[{id,projectPath:project,displayTitle:'New thread',ompSessionDirectory:persistence.sessionDirectory(id),createdAt:date,updatedAt:date,draft:'',wasRunning:false}],selectedThreadID:id,sidebarVisible:true});
        const unavailable=async()=>{throw new Error('Native UI is disabled in the isolated benchmark.');};
        const host={chooseDirectory:unavailable,chooseExecutable:unavailable,chooseImages:unavailable,confirmDelete:unavailable,confirmTerminal:unavailable,reveal:unavailable,terminal:unavailable,darkMode:()=>true};
        const controller=new AppController(persistence,host,()=>{});const before=performance.now();
        try{await controller.bootstrap();const state=controller.runtimes.get(id)?.summary();if(state?.status.kind!=='ready')throw new Error(state?.error||controller.connectionStatus);result.runtime={readyMs:Math.round(performance.now()-before),processStarts:starts};}
        finally{await controller.shutdown();}
      }
      await writeFile(${JSON.stringify(resultPath)},JSON.stringify(result,null,2));window.destroy();app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1);});
  `;
  await build({ stdin: { contents: main, resolveDir: resolve('.') }, outfile: join(root, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
  const completion = Promise.withResolvers();
  const child = spawn(electron, ['--headless=new', '--disable-gpu', join(root, 'main.cjs')], { stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill('SIGTERM'); completion.reject(new Error('Performance run exceeded 120 seconds.')); }, 120000);
  child.once('error', completion.reject); child.once('exit', code => completion.resolve(code));
  let code;
  try { code = await completion.promise; } finally { clearTimeout(timeout); }
  if (code !== 0) throw new Error(`Performance run failed with exit code ${code}.`);
  const result = await readFile(resultPath, 'utf8');
  if (values.output) await writeFile(resolve(values.output), result + '\n');
  process.stdout.write(result + '\n');
} finally { await rm(root, { recursive: true, force: true }); }

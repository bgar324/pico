import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { AppController } from '../src/main/AppController';
import type { DesktopHost } from '../src/main/AppController';
import { Persistence } from '../src/services/Persistence';
import { reduceRuntime } from '../src/renderer/helpers';
import { RpcClient } from '../src/omp/RpcClient';
import { ThreadRuntime } from '../src/omp/ThreadRuntime';
import { QueueAttachments } from '../src/omp/QueueAttachments';
import { MessageStore } from '../src/omp/MessageStore';
import { dialogResponse, parseDialog } from '../src/omp/dialogs';
import { RpcError, isRecord } from '../src/omp/frames';
import type { ChatMessage, ImageContent, Json, JsonRecord, QueuedMessage, RuntimeEvent, RuntimeSnapshot, ThreadRecord, ToolActivity } from '../src/shared/types';
import { isBusy } from '../src/shared/types';

// Test-only executable. Production launches OMP itself, never this fixture.
// These subprocess integration tests deliberately exercise OS pipe backpressure,
// transport deadlines and independent child clocks; fake parent timers cannot
// drive the child's clock. Observations await state/ack barriers, not fixed sleeps.
async function fixture(t: TestContext, options: { v1?: boolean; limit?: number; history?: 'pages' | 'stale' | 'empty' | 'repeat'; catalog?: 'empty' | 'invalid' | 'held'; catalogImages?: boolean; omitModelInput?: boolean; contextUsage?: Json; restoredContextUsage?: Json; todoPhases?: Json; restoredTodoPhases?: Json; sessionName?: string; nativeTitles?: boolean; nativeQueues?: boolean; editing?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-electron-omp-'));
  const executable = join(root, 'fixture-omp');
  const source = `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
appendFileSync(root + '/args.log', JSON.stringify(process.argv.slice(2)) + '\\n');
const providerModels = existsSync(root + '/provider-models.json') ? JSON.parse(readFileSync(root + '/provider-models.json', 'utf8')) : null;
const emit = frame => {if(frame.type==='queue_update')queuedMessages={steering:frame.steering??[],followUp:frame.followUp??[]};process.stdout.write(JSON.stringify(frame) + '\\n');};
const answer = (frame, data = {}) => emit({type:'response', id:frame.id, command:frame.type, success:true, data});
const fail = (frame, code, error) => emit({type:'response',id:frame.id,command:frame.type,success:false,code,error});
let model = 'text', thinkingLevel = null, forcedImages = false, levelsHeld = false, pendingLevels = null, pendingCatalog = null, pendingState = null, staleState = false;
let settled = true, background = false, lastPrompts = [], heldPrompt = null;
const originalEditFile = root + '/original.jsonl';
let editFile = originalEditFile, cancelBranch = false, workDuringEntries = false;
const editImage = {type:'image',mimeType:'image/png',data:'AAAA'};
const editOriginal = [
 {role:'user',content:[{type:'text',text:'Repeated prompt'}],timestamp:10},
 {role:'assistant',content:[{type:'text',text:'First answer'}],timestamp:20},
 {role:'user',content:[{type:'text',text:'Repeated prompt'},editImage],timestamp:30},
 {role:'assistant',content:[{type:'text',text:'Later answer to replace'}],timestamp:40}
];
let editHistory = editOriginal;
let contextUsage = ${JSON.stringify(options.contextUsage) ?? 'undefined'}, holdNextState = false, heldState = null;
let todoPhases = ${JSON.stringify(options.todoPhases ?? [])};
let queuedMessages = {steering:[],followUp:[]}, queuedCount = undefined;
const queuedPayloads = {steering:[],followUp:[]};
let heldQueue = null, holdNextQueue = false, deliverBeforePromotion = false, deliveredQueueCount = 0;
let removalBehavior = {}, heldRemoval = null;
const chip = entry => entry.message || (entry.images?.length ? '[Image]' : '');
const queueUpdate = (notify=true) => {
 const state={steering:queuedPayloads.steering.map(chip),followUp:queuedPayloads.followUp.map(chip)};
 if(notify)emit({type:'queue_update',...state,liveSteered:0});else queuedMessages=state;
};
const enqueue = frame => {queuedPayloads[frame.streamingBehavior==='steer'?'steering':'followUp'].push(frame);queueUpdate();};
const deliverQueued = (kind,notify=true) => {
 const entry=queuedPayloads[kind].shift();if(!entry)return;
 queueUpdate(notify);
 emit({type:'message_end',messageId:'delivered-queue-'+(++deliveredQueueCount),message:{role:'user',content:[{type:'text',text:entry.message},...(entry.images??[])]}});
};
const removeQueued = f => {
 if(removalBehavior.deliverBefore){removalBehavior.deliverBefore=false;deliverQueued(f.queue);}
 let index=queuedPayloads[f.queue].findIndex(entry=>entry.message===f.message);
 if(index<0)index=queuedPayloads[f.queue].findIndex(entry=>chip(entry)===f.message);
 let data={removed:false};
 if(index>=0){
  const entry=queuedPayloads[f.queue].splice(index,1)[0];queueUpdate(removalBehavior.notify!==false);
  data=removalBehavior.result??{removed:true,...(removalBehavior.dropImages?{imagesDropped:true}:removalBehavior.omitImages?{}:(removalBehavior.images??entry.images)?.length?{images:removalBehavior.images??entry.images}:{})};
 }
 if(removalBehavior.holdResponse){removalBehavior.holdResponse=false;heldRemoval={frame:f,data};}else answer(f,data);
};
const sessionId = process.argv[process.argv.indexOf('--session-dir') + 1] ?? root;
const titlePath = sessionId + '/fixture-title.json';
let sessionTitle = existsSync(titlePath) ? JSON.parse(readFileSync(titlePath, 'utf8')) : {name:${JSON.stringify(options.sessionName) ?? 'undefined'},source:'auto'};
let holdName = false, rejectName = false, pendingName = null;
let pendingGeneratedTitle = false;
const saveTitle = (name, source) => {sessionTitle={name,source};writeFileSync(titlePath,JSON.stringify(sessionTitle));};
const rename = f => {if(rejectName)fail(f,'rename_denied','Session rename denied');else{saveTitle(f.name,'user');answer(f);}};
const state = () => ({model:{provider:'fixture',id:model,name:model,input:${options.omitModelInput ? 'undefined' : "model==='image'||forcedImages?['text','image']:['text']"}},thinkingLevel:thinkingLevel==='inherit'?undefined:thinkingLevel??(model==='image'?'high':'off'),isSettled:settled,isStreaming:!settled&&!background,hasPendingAsyncWork:background,queuedMessages,queuedMessageCount:queuedCount??queuedMessages.steering.length+queuedMessages.followUp.length,contextUsage,todoPhases,sessionId,sessionFile:editFile,sessionName:sessionTitle.name});
const rl = createInterface({input:process.stdin, crlfDelay:Infinity});
emit({type:'ready',protocolVersion:1,supportedProtocolVersions:${options.v1 ? '[1]' : '[1,2]'},maxFrameBytes:${options.limit ?? 1048576},maxReassembledFrameBytes:67108864});
rl.on('line', line => {
 const f = JSON.parse(line); appendFileSync(root + '/commands.log', line + '\\n');
 switch(f.type) {
 case 'negotiate_protocol': answer(f,{protocolVersion:2}); break;
 case 'first': pendingState = f; break;
 case 'second': answer(f,{value:'second'}); if(pendingState){answer(pendingState,{value:'first'});pendingState=null;} break;
 case 'never': break;
 case 'fixture_status': answer(f,{levelsPending:!!pendingLevels,statePending:!!heldState,catalogPending:!!pendingCatalog,namePending:!!pendingName,generatedTitlePending:pendingGeneratedTitle,removalPending:!!heldRemoval,model});break;
 case 'malformed': process.stdout.write('{broken JSON\\n'); break;
 case 'mismatch': emit({type:'response',id:f.id,command:'wrong',success:true,data:{}}); break;
 case 'fail': fail(f,'permission_denied','api_key=secret Denied'); break;
 case 'get_available_models':
   if(${JSON.stringify(options.catalog)} === 'held') pendingCatalog=f;
   else if(${JSON.stringify(options.catalog)} === 'invalid') answer(f,{models:null});
   else if(${JSON.stringify(options.catalog)} === 'empty') answer(f,{models:[]});
   else answer(f,{models:providerModels??[{provider:'fixture',id:'text',name:'Text',input:${options.catalogImages ? "['text','image']" : "['text']"}}]});
   break;
 case 'release_catalog':
   answer(f);
   if(pendingCatalog){answer(pendingCatalog,f.invalid?{models:null}:{models:[{provider:'fixture',id:'text',name:'Text',input:['text']}]});pendingCatalog=null;}
   break;
 case 'get_available_thinking_levels':
   if(levelsHeld) pendingLevels = f; else answer(f,{levels:model==='image'?['off','high']:['off']}); break;
 case 'get_state':
   if(holdNextState){holdNextState=false;heldState={frame:f,data:state()};}
   else if(staleState){staleState=false; emit({type:'session_settled'});emit({type:'queue_update',steering:[],followUp:['new queue']});setTimeout(()=>answer(f,{...state(),isSettled:false,isStreaming:true,queuedMessages:{steering:['stale'],followUp:['stale']}}),50);}
   else answer(f,state()); break;
 case 'set_event_filter': answer(f,{messageUpdates:'delta'}); break;
 case 'set_subagent_subscription': answer(f,{level:'progress'}); break;
 case 'get_subagents': answer(f,{subagents:[]}); break;
 case 'get_available_commands': answer(f,{commands:${options.nativeTitles ? "[{name:'rename',source:'builtin'}]" : '[]'}});break;
 case 'get_messages_page':
   if(${options.editing === true}) {answer(f,{messages:editHistory,totalMessages:editHistory.length});break;}
   ${options.restoredContextUsage === undefined ? '' : `contextUsage = ${JSON.stringify(options.restoredContextUsage)};`}
   ${options.restoredTodoPhases === undefined ? '' : `todoPhases = ${JSON.stringify(options.restoredTodoPhases)};`}
   if(${JSON.stringify(options.history ?? 'empty')} === 'empty') answer(f,{messages:[],totalMessages:0});
   else if(f.cursor && ${JSON.stringify(options.history)} === 'stale') fail(f,'stale_cursor','Snapshot changed');
   else if(f.cursor && ${JSON.stringify(options.history)} === 'repeat') answer(f,{messages:[{role:'assistant',content:'bad'}],totalMessages:4,nextCursor:'cursor'});
   else if(f.cursor) answer(f,{messages:[{role:'assistant',content:[{type:'toolCall',id:'saved-tool',name:'read',arguments:{path:'a.ts'}}]},{role:'toolResult',toolCallId:'saved-tool',toolName:'read',content:[{type:'text',text:'saved contents'}]}],totalMessages:4});
   else answer(f,{messages:[{role:'user',content:'Original prompt'},{role:'assistant',content:'Original answer'}],totalMessages:4,nextCursor:'cursor'});
   break;
 case 'get_messages': answer(f,{messages:[{role:'user',content:'Authoritative fallback'}]}); break;
 case 'get_entries':
   if(workDuringEntries){workDuringEntries=false;settled=false;emit({type:'agent_start'});}
   answer(f,{entries:editHistory.map((message,index)=>({type:'message',id:'native-'+index,parentId:index?'native-'+(index-1):null,message})),leafId:'native-'+(editHistory.length-1)});break;
 case 'edit_behavior': cancelBranch=f.cancel===true;workDuringEntries=f.startWork===true;answer(f);break;
 case 'branch': {
   if(cancelBranch){answer(f,{cancelled:true,text:''});break;}
   const index=editHistory.findIndex((_,index)=>'native-'+index===f.entryId);
   if(index<0){fail(f,'invalid_entry','Missing entry');break;}
   editHistory=editHistory.slice(0,index);editFile=root+'/edited.jsonl';
   answer(f,{cancelled:false,text:'Repeated prompt'});break;
 }
 case 'switch_session': editFile=f.sessionPath;if(editFile===originalEditFile)editHistory=editOriginal;answer(f,{cancelled:false});break;
 case 'hold_model': model='image';levelsHeld=true;emit({type:'model_changed'});answer(f);break;
 case 'switch_model': model=f.model; forcedImages=false;levelsHeld=false;emit({type:'model_changed'});answer(f);break;
 case 'switch_capabilities': model='text';forcedImages=true;emit({type:'model_changed'});answer(f);break;
 case 'release_levels': levelsHeld=false;if(pendingLevels){answer(pendingLevels,{levels:['off','high']});pendingLevels=null;}answer(f);break;
 case 'emit_event': emit(f.frame);answer(f);break;
 case 'stale_next_state': staleState=true;answer(f);break;
 case 'hold_next_state': holdNextState=true;answer(f);break;
 case 'release_state': if(heldState){answer(heldState.frame,heldState.data);heldState=null;}answer(f);break;
 case 'set_context_usage': contextUsage=f.value;if(Array.isArray(f.events))for(const frame of f.events)emit(frame);answer(f);break;
 case 'set_todos': todoPhases=f.phases;answer(f,{todoPhases});break;
 case 'set_todo_state': todoPhases=f.phases;if(Array.isArray(f.events))for(const frame of f.events)emit(frame);answer(f);break;
 case 'set_queue_state': queuedMessages={steering:f.steering??[],followUp:f.followUp??[]};queuedCount=f.count;if(Array.isArray(f.events))for(const frame of f.events)emit(frame);answer(f);break;
 case 'set_work_state': settled=f.settled===true;background=f.background===true;answer(f);break;
 case 'set_model': model=f.modelId;emit({type:'model_changed'});answer(f);break;
 case 'set_thinking_level': thinkingLevel=f.level;emit({type:'thinking_level_changed',thinkingLevel:state().thinkingLevel});answer(f);break;
 case 'set_session_name': if(holdName)pendingName=f;else rename(f);break;
 case 'rename_behavior': holdName=f.hold===true;rejectName=f.reject===true;answer(f);break;
 case 'release_name': if(pendingName){rename(pendingName);pendingName=null;}holdName=false;answer(f);break;
 case 'set_native_title':
   if(sessionTitle.source!=='user'){saveTitle(f.title,'auto');if(f.emit!==false)emit({type:'session_info_update',sessionId,title:f.title});}
   answer(f);break;
 case 'finish_generated_title':
   if(pendingGeneratedTitle){pendingGeneratedTitle=false;if(f.error)emit({type:'command_output',text:'Rename failed: title provider unavailable'});else if(sessionTitle.source!=='user'){saveTitle(f.title??'Native generated title','user');emit({type:'session_info_update',sessionId,title:sessionTitle.name});emit({type:'command_output',text:'Session renamed to '+sessionTitle.name+'.'});}}
   answer(f);break;
 case 'prompt': case 'abort_and_prompt':
   if(${options.editing === true}) {
     if(f.message==='reject-edit'){fail(f,'denied','Input hook rejected this edit');break;}
     const user={role:'user',content:[{type:'text',text:f.message},...(f.images??[])],timestamp:50};
     const reply={role:'assistant',content:[{type:'text',text:'Response to edited turn'}],timestamp:60};
     editHistory=[...editHistory,user,reply];
     emit({type:'message_end',messageId:'edited-user',message:user});
     answer(f,{agentInvoked:true});
     emit({type:'message_end',messageId:'edited-answer',message:reply});
     emit({type:'prompt_result',id:f.id,status:'completed',sessionSettled:true});
     break;
   }
   if(f.message==='/rename'){pendingGeneratedTitle=true;answer(f,{agentInvoked:false});break;}
   lastPrompts.push(f); if(f.message==='held'){heldPrompt=f;settled=false;break;}
   if(f.message==='local'){answer(f,{agentInvoked:false});break;}
   if(${options.nativeQueues === true} && f.streamingBehavior){if(holdNextQueue){holdNextQueue=false;heldQueue=f;}else{enqueue(f);answer(f);}break;}
   settled=false;answer(f,{agentInvoked:true}); break;
 case 'release_prompt':
   if(heldPrompt){settled=true;if(f.failed)fail(heldPrompt,'denied','Local hook denied');else answer(heldPrompt,{agentInvoked:false});heldPrompt=null;}
   answer(f);break;
 case 'complete_prompt':
   settled=f.settled;emit({type:'prompt_result',id:lastPrompts[f.index??0]?.id,status:f.status??'completed',sessionSettled:f.settled});answer(f);break;
 case 'settle': settled=true;background=false;emit({type:'session_settled'});answer(f);break;
 case 'finish_native_turn':
   settled=true;background=false;emit({type:'agent_end',yielded:true});
   for(const prompt of lastPrompts)emit({type:'prompt_result',id:prompt.id,status:'completed',sessionSettled:!queuedPayloads.steering.length&&!queuedPayloads.followUp.length});
   emit({type:'session_settled'});answer(f);break;
 case 'hold_next_queue_admission': holdNextQueue=true;answer(f);break;
 case 'release_queued_admission':
   if(heldQueue){const entry=heldQueue;heldQueue=null;if(f.failed)fail(entry,'denied','Queued input denied');else if(f.local)answer(entry,{agentInvoked:false});else{enqueue(entry);answer(entry);}}
   answer(f);break;
 case 'promote_after_delivery': deliverBeforePromotion=true;answer(f);break;
 case 'promote_queued_message': {
   if(deliverBeforePromotion){deliverBeforePromotion=false;deliverQueued('followUp');}
   let index=queuedPayloads.followUp.findIndex(entry=>entry.message===f.message);
   if(index<0)index=queuedPayloads.followUp.findIndex(entry=>chip(entry)===f.message);
   if(index<0)answer(f,{promoted:false});else{queuedPayloads.steering.push(queuedPayloads.followUp.splice(index,1)[0]);queueUpdate();answer(f,{promoted:true});}
   break;
 }
 case 'queue_removal_behavior': removalBehavior=f;answer(f);break;
 case 'remove_queued_message':
   if(removalBehavior.hold){removalBehavior.hold=false;heldRemoval={frame:f};}else removeQueued(f);break;
 case 'release_queue_removal':
   if(heldRemoval){const pending=heldRemoval;heldRemoval=null;if(pending.data)answer(pending.frame,pending.data);else removeQueued(pending.frame);}answer(f);break;
 case 'clear_queued':
   if(f.queue)queuedPayloads[f.queue]=[];else{queuedPayloads.steering=[];queuedPayloads.followUp=[];}queueUpdate();answer(f);break;
 case 'deliver_queued': deliverQueued(f.queue??'followUp',f.notify!==false);answer(f);break;
 case 'abort': answer(f);break;
 case 'dialog': emit({type:'extension_ui_request',...f.frame});answer(f);break;
 case 'pause_input': answer(f);rl.pause();if(f.cancel)setTimeout(()=>emit({type:'extension_ui_request',method:'cancel',targetId:f.cancel}),100);setTimeout(()=>rl.resume(),400);break;
 case 'extension_ui_response': case 'filler': break;
 case 'stderr': process.stderr.write('authorization: Bear');setTimeout(()=>process.stderr.write('er sk-abcdef0123456789\\n'),10);answer(f);break;
 default: answer(f,{value:f.type});
 }
});
`;
  await writeFile(executable, source); await chmod(executable, 0o700);
  const record: ThreadRecord = { id: root, projectPath: root, displayTitle: options.history === 'empty' ? 'New thread' : 'Saved thread', ompSessionDirectory: join(root, 'OMP'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), draft: '', wasRunning: false };
  const events: RuntimeEvent[] = [];
  const cache = new Map<string, RuntimeSnapshot>();
  const runtime = new ThreadRuntime(record, event => { events.push(event); reduceRuntime(cache, event); });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, executable, record, runtime, events, cache };
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Fixture observation timed out'); await delay(5); }
}
async function commands(root: string): Promise<JsonRecord[]> {
  const text = await readFile(join(root, 'commands.log'), 'utf8');
  return text.trim().split('\n').map(line => { const value: unknown = JSON.parse(line); assert.ok(isRecord(value)); return value; });
}
async function heldLevels(client: RpcClient): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const status = await client.request('fixture_status');
    if (isRecord(status) && status.levelsPending === true) return;
    assert.ok(Date.now() < deadline, 'Model refresh did not reach held levels');
  }
}

async function heldUsageState(client: RpcClient): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const status = await client.request('fixture_status');
    if (isRecord(status) && status.statePending === true) return;
    assert.ok(Date.now() < deadline, 'Usage refresh did not reach held state');
  }
}

async function heldSessionName(client: RpcClient): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const status = await client.request('fixture_status');
    if (isRecord(status) && status.namePending === true) return;
    assert.ok(Date.now() < deadline, 'Rename did not reach the held native command');
  }
}

async function heldGeneratedTitle(client: RpcClient): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const status = await client.request('fixture_status');
    if (isRecord(status) && status.generatedTitlePending === true) return;
    assert.ok(Date.now() < deadline, 'Native title generation was not requested');
  }
}

async function heldQueueRemoval(client: RpcClient): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const status = await client.request('fixture_status');
    if (isRecord(status) && status.removalPending === true) return;
    assert.ok(Date.now() < deadline, 'Retraction did not reach the held native command');
  }
}

async function applicationFixture(t: TestContext, history: 'pages' | 'empty' = 'pages', options: { selected?: boolean; bootstrap?: boolean; catalog?: 'invalid' | 'held'; sessionName?: string; nativeTitles?: boolean; editing?: boolean } = {}) {
  const f = await fixture(t, { history, nativeTitles: options.nativeTitles ?? false, ...(options.catalog ? { catalog: options.catalog } : {}), ...(options.sessionName ? { sessionName: options.sessionName } : {}), ...(options.editing ? { editing: true } : {}) });
  const persistence = new Persistence(join(f.root, 'Storage'));
  const threads = Array.from({ length: 4 }, (_, index): ThreadRecord => {
    const id = randomUUID().toUpperCase();
    return { ...f.record, id, displayTitle: history === 'empty' ? 'New thread' : `Saved ${index}`, ompSessionDirectory: persistence.sessionDirectory(id) };
  });
  await persistence.save({ projects: [], threads, selectedThreadID: options.selected ? threads[0]?.id ?? null : null, sidebarVisible: true });
  await persistence.savePreferences({ executableOverride: f.executable, appearance: 'system', defaultProjectPath: f.root, sidebarWidth: 244 });
  const terminalCommands: string[] = [];
  const host: DesktopHost = {
    chooseDirectory: async () => null, chooseExecutable: async () => null, chooseImages: async () => [],
    confirmDelete: async () => true, confirmTerminal: async () => true, reveal: async () => {},
    terminal: async command => { terminalCommands.push(command); }, darkMode: () => false,
  };
  const cache = new Map<string, RuntimeSnapshot>();
  const accepted: RuntimeEvent[] = [];
  const delivered: RuntimeEvent[] = [];
  const app = new AppController(persistence, host, event => {
    if (event.kind !== 'runtime') return;
    delivered.push(event.event);
    if (reduceRuntime(cache, event.event)) accepted.push(event.event);
  });
  if (options.bootstrap !== false) await app.bootstrap();
  return { ...f, app, persistence, threads, cache, accepted, delivered, terminalCommands };
}

test('selected startup connects once, while Settings tests independently and reopening replaces only the process', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    assert.equal(f.app.connectionStatus, 'Connected to OMP');
    assert.equal(runtime.summary().status.kind, 'ready');
    assert.deepEqual(f.cache.get(first.id)?.messages.map(message => message.text), ['Original prompt', 'Original answer', '']);
    const starts = (await readFile(join(f.root, 'args.log'), 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line));
    assert.equal(starts.length, 1);
    assert.ok(Array.isArray(starts[0]) && starts[0].includes('--continue') && starts[0].includes(first.ompSessionDirectory));
    f.app.setDraft(first.id, 'Keep my unsent draft');
    const revision = runtime.summary().revision;
    await f.app.testConnection();
    assert.equal(f.app.connectionStatus, 'Connected to OMP');
    assert.equal(await f.app.runtimeFor(first.id), runtime);
    assert.equal(runtime.summary().revision, revision);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.draft, 'Keep my unsent draft');
    const tested = (await readFile(join(f.root, 'args.log'), 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line));
    assert.equal(tested.length, 2);
    assert.ok(Array.isArray(tested[1]) && !tested[1].includes('--continue') && !tested[1].includes(first.ompSessionDirectory));
    await f.app.selectThread(first.id, true);
    assert.equal(await f.app.runtimeFor(first.id), runtime);
    assert.ok(runtime.summary().revision > revision);
    assert.equal(f.cache.get(first.id)?.status.kind, 'ready');
    assert.equal((await readFile(join(f.root, 'args.log'), 'utf8')).trim().split('\n').length, 3);
    assert.equal((await commands(f.root)).some(frame => frame.type === 'prompt'), false);
  } finally { await f.app.shutdown(); }
});

test('startup without a selected project still tests OMP without opening a saved conversation', async t => {
  const f = await applicationFixture(t);
  try {
    assert.equal(f.app.connectionStatus, 'Connected to OMP');
    assert.equal(f.app.manifest.selectedThreadID, null);
    assert.equal(f.app.runtimes.size, 0);
    const starts: unknown = JSON.parse((await readFile(join(f.root, 'args.log'), 'utf8')).trim());
    assert.ok(Array.isArray(starts) && !starts.includes('--continue'));
    assert.deepEqual((await commands(f.root)).map(frame => frame.type), ['negotiate_protocol', 'get_state']);
  } finally { await f.app.shutdown(); }
});

test('selected startup reports failed runtime validation without a second probe or hiding recovery', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, catalog: 'invalid' });
  try {
    const first = f.threads[0]; assert.ok(first);
    assert.match(f.app.connectionStatus, /OMP connection failed:.*invalid model catalog/);
    assert.equal(f.app.executablePath, await realpath(f.executable));
    assert.equal(f.cache.get(first.id)?.status.kind, 'closed');
    assert.match(f.cache.get(first.id)?.error ?? '', /invalid model catalog/);
    assert.equal((await readFile(join(f.root, 'args.log'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await commands(f.root)).some(frame => frame.type === 'get_state'), false);
  } finally { await f.app.shutdown(); }
});

test('selected startup with a missing executable remains visible and never starts OMP', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, bootstrap: false });
  try {
    await f.persistence.savePreferences({ ...f.app.preferences, executableOverride: join(f.root, 'missing-omp') });
    await f.app.bootstrap();
    assert.equal(f.app.executablePath, null);
    assert.match(f.app.connectionStatus, /OMP executable not found/);
    assert.equal(f.app.runtimes.size, 0);
    await assert.rejects(readFile(join(f.root, 'args.log')), { code: 'ENOENT' });
  } finally { await f.app.shutdown(); }
});

for (const metadata of ['manifest.json', 'prefs.json']) test(`startup preserves corrupt ${metadata} and keeps metadata read-only`, async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, bootstrap: false });
  f.app.preferences.executableOverride = f.executable;
  const path = join(f.persistence.root, metadata);
  await writeFile(path, '{broken');
  try {
    await f.app.bootstrap();
    assert.match(f.app.error ?? '', /original file was not overwritten/);
    const first = f.threads[0]; assert.ok(first);
    assert.throws(() => f.app.renameThread(first.id, 'Overwrite'), /Repair local metadata/);
    await assert.rejects(f.app.newThread(f.root), /Repair local metadata/);
    f.app.setDraft(first.id, 'Overwrite');
  } finally { await f.app.shutdown(); }
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('shutdown during metadata loading prevents selected startup from spawning a process', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, bootstrap: false });
  const startup = f.app.bootstrap();
  await f.app.shutdown();
  await startup;
  assert.equal(f.app.runtimes.size, 0);
  await assert.rejects(readFile(join(f.root, 'args.log')), { code: 'ENOENT' });
});

test('shutdown during selected connection cancels the process and never publishes ready', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, bootstrap: false, catalog: 'held' });
  const startup = f.app.bootstrap();
  try {
    const first = f.threads[0]; assert.ok(first);
    await waitUntil(() => f.app.runtimes.get(first.id)?.client.ready === true);
    const runtime = await f.app.runtimeFor(first.id);
    const status = await runtime.client.request('fixture_status');
    assert.ok(isRecord(status) && status.catalogPending === true);
    await f.app.shutdown();
    await startup;
    assert.equal(runtime.client.ready, false);
    assert.equal(runtime.summary().status.kind, 'closed');
    assert.notEqual(f.app.connectionStatus, 'Connected to OMP');
    assert.equal(f.delivered.some(event => (event.kind === 'summary' || event.kind === 'snapshot') && event.runtime.status.kind === 'ready'), false);
    assert.equal((await readFile(join(f.root, 'args.log'), 'utf8')).trim().split('\n').length, 1);
  } finally { await f.app.shutdown(); await startup; }
});

for (const succeeds of [false, true]) test(`newer explicit connection ${succeeds ? 'success' : 'failure'} cannot be overwritten by selected startup`, async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, bootstrap: false, catalog: 'held' });
  const startup = f.app.bootstrap();
  try {
    const first = f.threads[0]; assert.ok(first);
    await waitUntil(() => f.app.runtimes.get(first.id)?.client.ready === true);
    const runtime = await f.app.runtimeFor(first.id);
    const pending = await runtime.client.request('fixture_status');
    assert.ok(isRecord(pending) && pending.catalogPending === true);
    if (!succeeds) f.app.preferences.executableOverride = join(f.root, 'missing-omp');
    await f.app.testConnection();
    const status = f.app.connectionStatus;
    const executable = f.app.executablePath;
    if (succeeds) assert.equal(status, 'Connected to OMP');
    else assert.match(status, /OMP executable not found/);
    await runtime.client.request('release_catalog', { invalid: succeeds });
    await startup;
    assert.equal(f.app.connectionStatus, status);
    assert.equal(f.app.executablePath, executable);
    assert.equal(runtime.summary().status.kind, succeeds ? 'closed' : 'ready');
    if (succeeds) assert.match(runtime.summary().error ?? '', /invalid model catalog/);
  } finally { await f.app.shutdown(); await startup; }
});

test('ready publishes engine defaults and hydrated usage from one authoritative post-history state', async t => {
  const restored = { tokens: 1200, contextWindow: 922000 };
  const f = await fixture(t, { history: 'pages', catalog: 'empty', contextUsage: { tokens: 2500, contextWindow: 922000 }, restoredContextUsage: restored });
  await f.runtime.connect(f.executable);
  const snapshot = f.cache.get(f.record.id);
  assert.equal(snapshot?.status.kind, 'ready');
  assert.equal(snapshot?.selectedModelID, 'fixture/text');
  assert.equal(snapshot?.thinkingLevel, 'off');
  assert.deepEqual(snapshot?.thinkingLevels, ['off']);
  assert.deepEqual(snapshot?.contextUsage, restored);
  assert.equal(snapshot?.messages.length, 3);
  assert.equal(snapshot?.notice, null);
  assert.equal(snapshot?.models[0]?.id, 'fixture/text');
  const log = await commands(f.root);
  assert.equal(log.filter(frame => frame.type === 'get_state').length, 1);
  assert.ok(log.findIndex(frame => frame.type === 'get_state') > log.findLastIndex(frame => frame.type === 'get_messages_page'));
});

test('native session names hydrate existing threads and replace provisional names without submitting another prompt', async t => {
  const f = await applicationFixture(t, 'empty');
  try {
    const first = f.threads[0]; assert.ok(first);
    await f.app.selectThread(first.id);
    const runtime = await f.app.runtimeFor(first.id);
    assert.equal(await f.app.prompt(first.id, 'Provisional first-message label', false, []), true);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Provisional first-message label');
    await runtime.client.request('set_native_title', { title: 'Native event title' });
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Native event title');
    await runtime.client.request('set_native_title', { title: 'Native state title', emit: false });
    await runtime.client.request('emit_event', { frame: { type: 'turn_end' } });
    await waitUntil(() => f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle === 'Native state title');
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Native state title');
    assert.equal((await commands(f.root)).filter(frame => frame.type === 'prompt').length, 1);
    assert.equal((await commands(f.root)).some(frame => frame.type === 'set_session_name'), false);
    await f.app.shutdown();
    const saved = await f.persistence.load();
    assert.equal(saved.threads.find(thread => thread.id === first.id)?.displayTitle, 'Native state title');
    const savedFirst = saved.threads.find(thread => thread.id === first.id); assert.ok(savedFirst);
    savedFirst.displayTitle = 'Stale local label';
    await f.persistence.save(saved);
    const reopened = new AppController(f.persistence, f.app.host, () => {});
    try {
      await reopened.bootstrap();
      assert.equal(reopened.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Native state title');
      assert.equal((await reopened.runtimeFor(first.id)).sessionName, 'Native state title');
    } finally { await reopened.shutdown(); }
  } finally { await f.app.shutdown(); }
});

test('OMP generates a native title after the first reply once, without adding control traffic to chat', async t => {
  const f = await applicationFixture(t, 'empty', { selected: true, nativeTitles: true });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    await f.app.prompt(first.id, 'Make the sidebar less cluttered', false, []);
    await runtime.client.request('emit_event', { frame: { type: 'message_end', messageId: 'user', message: { role: 'user', content: 'Make the sidebar less cluttered' } } });
    await runtime.client.request('emit_event', { frame: { type: 'message_end', messageId: 'reply', message: { role: 'assistant', content: 'The sidebar now uses compact controls.' } } });
    assert.equal((await commands(f.root)).some(command => command.type === 'prompt' && command.message === '/rename'), false);
    await runtime.client.request('complete_prompt', { settled: true });
    await heldGeneratedTitle(runtime.client);
    await runtime.client.request('finish_generated_title', { title: 'Compact sidebar controls' });
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Compact sidebar controls');
    assert.deepEqual(runtime.snapshot().messages.map(message => message.text), ['Make the sidebar less cluttered', 'The sidebar now uses compact controls.']);
    assert.deepEqual(runtime.summary().status, { kind: 'ready', activity: 'idle' });
    await runtime.client.request('emit_event', { frame: { type: 'command_output', text: 'Other command output remains visible' } });
    assert.equal(runtime.snapshot().messages.at(-1)?.text, 'Other command output remains visible');
    await runtime.client.request('emit_event', { frame: { type: 'command_output', text: 'Rename failed: an explicit later command' } });
    assert.equal(runtime.snapshot().messages.at(-1)?.text, 'Rename failed: an explicit later command');
    await f.app.shutdown();
    const saved = await f.persistence.load();
    assert.ok(saved.threads.find(thread => thread.id === first.id)?.nativeTitleAttemptedFor);
    const reopened = new AppController(f.persistence, f.app.host, () => {});
    try {
      await reopened.bootstrap();
      assert.equal(reopened.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Compact sidebar controls');
      assert.equal((await commands(f.root)).filter(command => command.type === 'prompt' && command.message === '/rename').length, 1);
    } finally { await reopened.shutdown(); }
  } finally { await f.app.shutdown(); }
});

test('opening an unnamed conversation requests its native title but a manual rename wins the race', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, nativeTitles: true });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    await heldGeneratedTitle(runtime.client);
    await f.app.renameThread(first.id, 'My deliberate name');
    await runtime.client.request('finish_generated_title', { title: 'Late generated title' });
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'My deliberate name');
    assert.equal(runtime.sessionName, 'My deliberate name');
    assert.equal(runtime.snapshot().messages.some(message => message.text.includes('Late generated title')), false);
  } finally { await f.app.shutdown(); }
});

test('native title failures keep the provisional title and do not repeat after reopening', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, nativeTitles: true });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    await heldGeneratedTitle(runtime.client);
    await runtime.client.request('finish_generated_title', { error: true });
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Saved 0');
    assert.match(runtime.summary().notice ?? '', /title provider unavailable/);
    assert.equal(runtime.summary().error, null);
    assert.equal(runtime.snapshot().messages.some(message => message.text.includes('Rename failed:')), false);
    await f.app.shutdown();
    const reopened = new AppController(f.persistence, f.app.host, () => {});
    try {
      await reopened.bootstrap();
      assert.equal((await commands(f.root)).filter(command => command.type === 'prompt' && command.message === '/rename').length, 1);
    } finally { await reopened.shutdown(); }
  } finally { await f.app.shutdown(); }
});

test('existing native names are not regenerated automatically', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, nativeTitles: true, sessionName: 'Existing native name' });
  try {
    const first = f.threads[0]; assert.ok(first);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Existing native name');
    assert.equal((await commands(f.root)).some(command => command.type === 'prompt' && command.message === '/rename'), false);
  } finally { await f.app.shutdown(); }
});

test('an unavailable native rename command is not sent to the conversation model', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    await waitUntil(() => runtime.summary().notice?.includes('does not expose its native /rename generator') === true);
    assert.equal((await commands(f.root)).some(command => command.type === 'prompt'), false);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Saved 0');
  } finally { await f.app.shutdown(); }
});

test('saved native names restore on connect and title events outrank older state snapshots', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, sessionName: 'Saved native title' });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    assert.equal(runtime.sessionName, 'Saved native title');
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Saved native title');
    await runtime.client.request('hold_next_state');
    const stale = runtime.refreshState();
    await heldUsageState(runtime.client);
    await runtime.client.request('set_native_title', { title: 'Newer native title' });
    await runtime.client.request('release_state');
    await stale;
    assert.equal(runtime.sessionName, 'Newer native title');
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Newer native title');
    await runtime.client.request('emit_event', { frame: { type: 'session_info_update', sessionId: 'foreign-session', title: 'Foreign title' } });
    await runtime.client.request('emit_event', { frame: { type: 'session_info_update', sessionId: first.ompSessionDirectory, title: 42 } });
    assert.equal(runtime.sessionName, 'Newer native title');
    await runtime.shutdown();
    runtime.consume({ type: 'session_info_update', sessionId: first.ompSessionDirectory, title: 'Closed runtime title' });
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Newer native title');
    await f.app.selectThread(first.id);
    assert.equal(runtime.sessionName, 'Newer native title');
    assert.equal((await commands(f.root)).some(frame => frame.type === 'prompt' || frame.type === 'set_session_name'), false);
  } finally { await f.app.shutdown(); }
});

test('an engine-owned name equal to the default label is not replaced by the first prompt', async t => {
  const f = await applicationFixture(t, 'empty', { selected: true, sessionName: 'New thread' });
  try {
    const first = f.threads[0]; assert.ok(first);
    assert.equal(await f.app.prompt(first.id, 'Not the saved native title', false, []), true);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'New thread');
  } finally { await f.app.shutdown(); }
});

test('desktop rename waits for native confirmation, blocks stale reads and preserves user title ownership across reopen', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, sessionName: 'Automatic title' });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    await runtime.client.request('hold_next_state');
    const stale = runtime.refreshState();
    await heldUsageState(runtime.client);
    await runtime.client.request('rename_behavior', { hold: true });
    const naming = f.app.renameThread(first.id, '  Intentional\u0007   name  ');
    await heldSessionName(runtime.client);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Automatic title');
    await runtime.client.request('set_native_title', { title: 'Racing automatic title' });
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Automatic title');
    await runtime.client.request('release_name');
    await naming;
    await runtime.client.request('release_state');
    await stale;
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Intentional name');
    await runtime.client.request('set_native_title', { title: 'Unwanted automatic title' });
    const state = await runtime.client.request('get_state');
    assert.ok(isRecord(state));
    assert.equal(state.sessionName, 'Intentional name');
    await f.app.selectThread(first.id, true);
    assert.equal(runtime.sessionName, 'Intentional name');
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, 'Intentional name');
    assert.deepEqual((await commands(f.root)).filter(frame => frame.type === 'set_session_name').map(frame => frame.name), ['Intentional name']);
    await f.app.shutdown();
    assert.equal((await f.persistence.load()).threads.find(thread => thread.id === first.id)?.displayTitle, 'Intentional name');
  } finally { await f.app.shutdown(); }
});

test('closed, connecting and failed native renames leave saved metadata untouched', async t => {
  const f = await applicationFixture(t, 'pages', { catalog: 'held' });
  try {
    const first = f.threads[0]; assert.ok(first);
    assert.throws(() => f.app.renameThread(first.id, 'Disconnected rename'), /Open the conversation/);
    const opening = f.app.selectThread(first.id);
    const runtime = await f.app.runtimeFor(first.id);
    await waitUntil(() => runtime.client.ready);
    assert.throws(() => f.app.renameThread(first.id, 'Connecting rename'), /Open the conversation/);
    await runtime.client.request('release_catalog');
    await opening;
    await runtime.client.request('rename_behavior', { reject: true });
    await assert.rejects(f.app.renameThread(first.id, 'Denied rename'), /Session rename denied/);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, first.displayTitle);
    assert.match(runtime.summary().error ?? '', /Session rename denied/);
    await runtime.client.request('rename_behavior', {});
    await f.app.renameThread(first.id, first.displayTitle);
    assert.equal(runtime.summary().error, null);
    await runtime.client.request('rename_behavior', { hold: true });
    const naming = assert.rejects(f.app.renameThread(first.id, 'Interrupted rename'), /closed|shut|cancel/i);
    await heldSessionName(runtime.client);
    await runtime.shutdown();
    await naming;
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.displayTitle, first.displayTitle);
  } finally { await f.app.shutdown(); }
});

test('transport negotiates, correlates out-of-order replies, rejects reuse and preserves command codes', async t => {
  const f = await fixture(t);
  const client = f.runtime.client;
  await client.start({ executable: f.executable, projectPath: f.root, sessionDirectory: f.record.ompSessionDirectory, resume: true });
  const first = client.request('first', {}, { id: 'one' });
  assert.deepEqual(await client.request('second'), { value: 'second' }); assert.deepEqual(await first, { value: 'first' });
  await assert.rejects(client.request('first', {}, { id: 'one' }), error => error instanceof RpcError && error.kind === 'invalid');
  await assert.rejects(client.request('fail'), error => error instanceof RpcError && error.code === 'permission_denied' && !error.message.includes('secret'));
  const log = await commands(f.root); assert.equal(log[0]?.type, 'negotiate_protocol');
});

test('v1 input limit, cancellation before enqueue, timeout isolation and shared bounded shutdown', async t => {
  const f = await fixture(t, { v1: true, limit: 1024 });
  const client = f.runtime.client;
  await client.start({ executable: f.executable, projectPath: f.root, sessionDirectory: f.record.ompSessionDirectory, resume: true });
  await assert.rejects(client.send({ type: 'filler', text: 'x'.repeat(1024) }), /input limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.request('never', {}, { signal: controller.signal }), error => error instanceof RpcError && error.kind === 'cancelled');
  await assert.rejects(client.request('never', {}, { timeout: 20 }), error => error instanceof RpcError && error.kind === 'timeout');
  assert.deepEqual(await client.request('working'), { value: 'working' });
  const pending = client.request('never'); const rejected = assert.rejects(pending, /shut down/);
  await Promise.all([client.shutdown(), client.shutdown()]); await rejected;
  assert.equal(client.ready, false);
});

for (const command of ['malformed', 'mismatch']) test(`transport fails closed on ${command} and rejects all pending requests`, async t => {
  const f = await fixture(t); const client = f.runtime.client; const frames: JsonRecord[] = [];
  client.on('event', frame => frames.push(frame));
  await client.start({ executable: f.executable, projectPath: f.root, sessionDirectory: f.record.ompSessionDirectory, resume: true });
  const pending = assert.rejects(client.request('never'), RpcError);
  await assert.rejects(client.request(command), RpcError); await pending;
  assert.equal(client.ready, false); assert.equal(frames.filter(frame => frame.type === 'transport_error').length, 1);
});

test('two clients isolate sessions and IDs; reconnect keeps event subscription and redacts stderr', async t => {
  const a = await fixture(t), b = await fixture(t);
  await Promise.all([a.runtime.connect(a.executable), b.runtime.connect(b.executable)]);
  const values = await Promise.all([a.runtime.client.request('alpha', {}, { id: 'shared' }), b.runtime.client.request('beta', {}, { id: 'shared' })]);
  assert.deepEqual(values, [{ value: 'alpha' }, { value: 'beta' }]);
  await a.runtime.client.request('stderr'); await waitUntil(() => a.runtime.client.diagnostics().includes('redacted'));
  assert.doesNotMatch(a.runtime.client.diagnostics(), /abcdef0123456789/);
  await a.runtime.shutdown(); await a.runtime.connect(a.executable);
  await a.runtime.client.request('emit_event', { frame: { type: 'queue_update', steering: ['live'], followUp: [] } });
  assert.deepEqual(a.runtime.summary().queuedSteers.map(entry => entry.text), ['live']);
});

for (const history of ['pages', 'stale', 'repeat', 'empty'] as const) test(`history ${history} is restored without replay or duplicate pages`, async t => {
  const f = await fixture(t, { history }); await f.runtime.connect(f.executable);
  const snapshot = f.runtime.snapshot(); const log = await commands(f.root);
  assert.equal(log.some(frame => ['prompt', 'steer', 'follow_up', 'abort_and_prompt', 'restore'].includes(String(frame.type))), false);
  const args: unknown = JSON.parse((await readFile(join(f.root, 'args.log'), 'utf8')).trim());
  assert.ok(Array.isArray(args)); assert.ok(args.includes('--continue')); assert.ok(args.includes(f.record.ompSessionDirectory));
  if (history === 'repeat') { assert.equal(snapshot.status.kind, 'closed'); assert.match(snapshot.error ?? '', /repeated/); }
  else { assert.equal(snapshot.status.kind, 'ready', snapshot.error ?? ''); }
  if (history === 'pages') { assert.equal(snapshot.messages.length, 3); assert.equal(snapshot.tools[0]?.state, 'succeeded'); assert.deepEqual(snapshot.messages[2]?.toolIDs, ['saved-tool']); assert.equal(snapshot.tools[0]?.output, 'saved contents'); }
  if (history === 'stale') { assert.deepEqual(snapshot.messages.map(message => message.text), ['Authoritative fallback']); assert.equal(snapshot.error, null); }
  if (history === 'empty') { assert.equal(snapshot.messages.length, 0); assert.equal(snapshot.notice, null); }
});

test('prompt admission, correlated completion, background yield and Stop acknowledgement are distinct', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime;
  await r.connect(f.executable);
  assert.equal(await r.sendPrompt('first'), true);
  await r.client.request('emit_event', { frame: { type: 'agent_end', messages: [], awaitingAsyncWork: true } });
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'background' });
  assert.equal(await r.sendPrompt('follow'), true); assert.equal(await r.sendPrompt('steer', { steer: true }), true);
  const prompts = (await commands(f.root)).filter(frame => frame.type === 'prompt');
  assert.equal(prompts[0]?.streamingBehavior, undefined); assert.equal(prompts[1]?.streamingBehavior, 'followUp'); assert.equal(prompts[2]?.streamingBehavior, 'steer');
  r.consume({ type: 'prompt_result', id: 'foreign', sessionSettled: true });
  await r.client.request('complete_prompt', { index: 0, settled: true });
  assert.notDeepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
  await r.stop(); assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'stopping' });
  await r.client.request('complete_prompt', { index: 1, settled: false }); await r.client.request('complete_prompt', { index: 2, settled: false });
  assert.notDeepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
  await r.client.request('settle'); assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
  assert.equal(await r.sendPrompt('local'), true); assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
});

test('pending submission is visible and anchors work before held admission, then local handling removes it', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const sending = r.sendPrompt('held');
  const admitted = r.summary().workPeriods?.[0];
  assert.ok(admitted); assert.equal(admitted.startedAt, now); assert.equal(admitted.endedAt, null);
  const pending = f.cache.get(f.record.id)?.messages[0]; assert.ok(pending);
  assert.equal(pending.role, 'user'); assert.equal(pending.text, 'held'); assert.equal(admitted.messageID, pending.id);
  assert.equal(f.cache.get(f.record.id)?.workPeriods?.[0]?.id, admitted.id);
  now += 2300;
  await r.client.request('release_prompt');
  assert.equal(await sending, true);
  const finished = r.summary().workPeriods?.[0];
  assert.ok(finished); assert.ok(finished.endedAt !== null); assert.equal(finished.endedAt, now); assert.equal(finished.endedAt - finished.startedAt, 2300);
  assert.equal(finished.messageID, null); assert.equal(admitted.endedAt, null);
  assert.deepEqual(f.cache.get(f.record.id)?.messages, []);
  now += 9000; await r.refreshState();
  assert.deepEqual(r.summary().workPeriods, [finished]);
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'prompt').length, 1);
});

test('native delivery replaces the optimistic user exactly once, including hook edits and images', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  const sending = r.sendPrompt('held', { images: [image] });
  const optimistic = f.cache.get(f.record.id)?.messages[0]; assert.ok(optimistic);
  assert.deepEqual(optimistic.images, [image]);
  const start = r.summary().workPeriods?.[0]?.startedAt;
  r.consume({ type: 'message_start', messageId: 'native-submission', message: { role: 'user', content: [{ type: 'text', text: 'Hook-edited prompt' }, image] } });
  r.consume({ type: 'message_end', messageId: 'native-submission', message: { role: 'user', content: [{ type: 'text', text: 'Hook-edited prompt' }, image] } });
  const confirmed = f.cache.get(f.record.id); assert.ok(confirmed);
  assert.deepEqual(confirmed.messages.map(message => [message.id, message.text, message.images]), [['native-submission', 'Hook-edited prompt', [image]]]);
  assert.equal(confirmed.workPeriods?.[0]?.messageID, 'native-submission');
  assert.equal(confirmed.workPeriods?.[0]?.startedAt, start);
  await r.client.request('release_prompt');
  assert.equal(await sending, true);
  assert.equal(f.cache.get(f.record.id)?.messages[0]?.id, 'native-submission');
});

test('rejected admission removes only the unconfirmed bubble and leaves no ghost work anchor', async t => {
  const f = await fixture(t, { history: 'pages' }); const r = f.runtime; await r.connect(f.executable);
  const saved = r.snapshot().messages;
  const sending = r.sendPrompt('held');
  assert.equal(f.cache.get(f.record.id)?.messages.at(-1)?.text, 'held');
  await r.client.request('release_prompt', { failed: true });
  assert.equal(await sending, false);
  assert.deepEqual(f.cache.get(f.record.id)?.messages, saved);
  assert.equal(r.summary().workPeriods?.[0]?.messageID, null);
  assert.match(r.summary().error ?? '', /denied/i);
});

test('one work period spans native message anchors, overlapping admissions, tools and background yields', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  await r.sendPrompt('same text');
  const admitted = r.summary().workPeriods?.[0]; assert.ok(admitted);
  now += 1000;
  r.consume({ type: 'agent_start' });
  r.consume({ type: 'message_start', messageId: 'native-first-user', message: { role: 'user', content: 'Native hooks changed this text' } });
  r.consume({ type: 'message_end', messageId: 'native-first-user', message: { role: 'user', content: 'Native hooks changed this text' } });
  assert.equal(r.summary().workPeriods?.[0]?.messageID, 'native-first-user');
  assert.equal(f.cache.get(f.record.id)?.messages[0]?.id, 'native-first-user');
  now += 1000;
  await r.sendPrompt('same text'); await r.sendPrompt('same text', { steer: true });
  r.consume({ type: 'agent_start' });
  r.consume({ type: 'message_end', messageId: 'native-steer', message: { role: 'user', content: 'same text', steering: true } });
  r.consume({ type: 'message_end', messageId: 'native-assistant', message: { role: 'assistant', content: 'Still working' } });
  r.consume({ type: 'tool_execution_start', toolCallId: 'work-read', toolName: 'read', args: { path: 'a.ts' } });
  r.consume({ type: 'tool_execution_end', toolCallId: 'work-read', toolName: 'read', result: 'contents' });
  assert.equal(r.summary().workPeriods?.length, 1);
  assert.deepEqual(r.summary().workPeriods?.[0], { ...admitted, messageID: 'native-first-user' });
  await r.client.request('set_work_state', { settled: false, background: true });
  await r.client.request('emit_event', { frame: { type: 'agent_end', awaitingAsyncWork: true } });
  for (let index = 0; index < 3; index++) await r.client.request('complete_prompt', { index, settled: false });
  await r.refreshState();
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'background' });
  assert.equal(r.summary().workPeriods?.[0]?.endedAt, null);
  now += 4000;
  r.consume({ type: 'agent_start' }); r.consume({ type: 'agent_end', awaitingAsyncWork: true });
  assert.equal(r.summary().workPeriods?.[0]?.startedAt, admitted.startedAt);
  await r.stop();
  assert.equal(r.summary().workPeriods?.[0]?.endedAt, null);
  await r.client.request('settle');
  const finished = r.summary().workPeriods?.[0]; assert.ok(finished); assert.ok(finished.endedAt !== null); assert.equal(finished.endedAt, now);
  assert.equal(finished.endedAt - finished.startedAt, 6000);
  now += 8000; await r.refreshState();
  assert.deepEqual(r.summary().workPeriods, [finished]);
  assert.equal(f.cache.get(f.record.id)?.workPeriods?.[0]?.endedAt, finished.endedAt);
  const log = await commands(f.root);
  assert.deepEqual(log.filter(frame => frame.type === 'prompt').map(frame => frame.streamingBehavior), [undefined, 'followUp', 'steer']);
});

test('late Advisor feedback resumes the completed user stream until a new submission', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  await r.sendPrompt('Check the project');
  r.consume({ type: 'message_end', messageId: 'review-user', message: { role: 'user', content: 'Check the project' } });
  r.consume({ type: 'message_end', messageId: 'review-answer', message: { role: 'assistant', content: 'The project is ready.' } });
  now += 2000;
  await r.client.request('complete_prompt', { settled: true });
  const finished = r.summary().workPeriods?.[0]; assert.ok(finished);
  assert.equal(finished.endedAt, now);
  const advisor = (id: string) => ({ type: 'message_end', messageId: id, message: { role: 'custom', customType: 'advisor', display: true, content: '<advisory severity="concern">Check the cleanup path.</advisory>' } });
  now += 3000;
  r.consume(advisor('late-review'));
  assert.deepEqual(r.summary().workPeriods, [finished], 'A note alone must not restart the timer.');
  await r.client.request('set_work_state', { settled: false });
  r.consume({ type: 'agent_start' });
  r.consume({ type: 'message_start', messageId: 'review-fix', message: { role: 'assistant', content: 'Checking the cleanup path.' } });
  assert.deepEqual(r.summary().workPeriods, [{ ...finished, endedAt: null }]);
  assert.deepEqual(f.cache.get(f.record.id)?.messages.map(message => message.id), ['review-user', 'review-answer', 'late-review', 'review-fix']);
  now += 1000; await r.client.request('settle');
  const reviewed = r.summary().workPeriods?.[0]; assert.ok(reviewed);
  assert.equal(reviewed.endedAt, now);
  r.consume(advisor('late-review-again'));
  await r.client.request('set_work_state', { settled: false });
  await r.refreshState();
  assert.deepEqual(r.summary().workPeriods, [{ ...reviewed, endedAt: null }], 'Authoritative running state must also resume the same stream.');
  await r.client.request('settle');
  r.consume(advisor('review-before-next-prompt'));
  await r.sendPrompt('Next task');
  const periods = r.summary().workPeriods; assert.ok(periods);
  assert.equal(periods.length, 2); assert.notEqual(periods[1]?.id, finished.id);
  assert.equal(periods[0]?.endedAt, now);
});

test('native work without a Desktop prompt has distinct equal-time rounds and bounded observed history', async t => {
  const f = await fixture(t, { history: 'pages' }); const r = f.runtime; await r.connect(f.executable);
  assert.deepEqual(r.summary().workPeriods, []);
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const ids: string[] = [];
  for (let index = 0; index < 40; index++) {
    const user = { type: 'message_end', messageId: `native-user-${index}`, message: { role: 'user', content: 'identical text' } };
    if (index % 2 === 0) r.consume(user);
    r.consume({ type: 'agent_start' });
    if (index % 2 !== 0) r.consume(user);
    const active = r.summary().workPeriods?.at(-1); assert.ok(active);
    ids.push(active.id); assert.equal(active.messageID, `native-user-${index}`); assert.equal(active.endedAt, null);
    r.consume({ type: 'session_settled' });
    assert.equal(r.summary().workPeriods?.at(-1)?.endedAt, now);
  }
  assert.equal(new Set(ids).size, 40);
  const periods = r.summary().workPeriods; assert.ok(periods); assert.equal(periods.length, 32);
  assert.deepEqual(periods.map(period => period.id), ids.slice(-32));
  assert.ok(periods.every(period => period.startedAt === now && period.endedAt === now));
  assert.equal((await commands(f.root)).some(frame => frame.type === 'prompt'), false);
});

test('settled interruption freezes once and a successive prompt gets a new identity at the same clock time', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  await r.sendPrompt('interrupt this');
  const first = r.summary().workPeriods?.[0]; assert.ok(first);
  now += 1100; await r.stop();
  assert.equal(r.summary().workPeriods?.[0]?.endedAt, null);
  await r.client.request('complete_prompt', { status: 'aborted', settled: true });
  const frozen = r.summary().workPeriods?.[0]; assert.ok(frozen); assert.equal(frozen.endedAt, now);
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
  r.consume({ type: 'session_settled' });
  await r.sendPrompt('next');
  const second = r.summary().workPeriods?.[1]; assert.ok(second);
  assert.notEqual(second.id, first.id); assert.equal(second.startedAt, frozen.endedAt);
  assert.equal(second.endedAt, null);
  assert.equal(second.messageID, f.cache.get(f.record.id)?.messages.at(-1)?.id);
  assert.deepEqual(r.summary().workPeriods?.[0], frozen);
  r.consume({ type: 'message_end', messageId: 'second-native-user', message: { role: 'user', content: 'next' } });
  assert.equal(r.summary().workPeriods?.[1]?.messageID, 'second-native-user');
});

for (const closure of ['shutdown', 'transport_error'] as const) test(`${closure} freezes active work and reconnect does not time restored history`, async t => {
  const f = await fixture(t, { history: 'pages' }); const r = f.runtime; await r.connect(f.executable);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const sending = r.sendPrompt('held');
  const active = r.summary().workPeriods?.[0]; assert.ok(active);
  now += 1700;
  if (closure === 'transport_error') r.consume({ type: 'transport_error', error: 'fixture disconnected' });
  await r.shutdown(); assert.equal(await sending, false);
  const finished = r.summary().workPeriods?.[0]; assert.ok(finished); assert.ok(finished.endedAt !== null); assert.equal(finished.endedAt, now);
  assert.equal(finished.endedAt - finished.startedAt, 1700);
  now += 3000;
  r.consume({ type: 'agent_start' });
  assert.deepEqual(r.summary().workPeriods, [finished]);
  const connecting = r.connect(f.executable);
  assert.deepEqual(r.summary().workPeriods, []);
  await connecting;
  assert.deepEqual(r.summary().workPeriods, []);
  assert.ok(r.snapshot().messages.length > 0);
  await r.sendPrompt('new round');
  const next = r.summary().workPeriods?.[0]; assert.ok(next);
  assert.notEqual(next.id, active.id); assert.equal(next.startedAt, now);
  assert.equal(next.messageID, f.cache.get(f.record.id)?.messages.at(-1)?.id);
  r.consume({ type: 'message_end', messageId: 'new-process-user', message: { role: 'user', content: 'new round' } });
  assert.equal(r.summary().workPeriods?.[0]?.messageID, 'new-process-user');
});


for (const command of ['prompt', 'abort_and_prompt']) for (const failed of [false, true]) test(`late ${command} ${failed ? 'failed' : 'local'} response retires timed-out prompt ticket without replay`, async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  // Shorten only the deadline; all transport and server processing remain real.
  const request = r.client.request.bind(r.client);
  r.client.request = (type, fields = {}, options = {}) => request(type === 'prompt' ? command : type, fields, type === 'prompt' ? { ...options, timeout: 20 } : options);
  assert.equal(await r.sendPrompt('held'), false);
  await r.client.request('release_prompt', { failed });
  await waitUntil(() => { const status = r.summary().status; return status.kind === 'ready' && status.activity === 'idle'; });
  assert.equal((await commands(f.root)).filter(frame => frame.type === command).length, 1);
  await r.client.request('settle'); assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
});

test('stale state reply cannot reverse newer settled and queue events', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  r.consume({ type: 'agent_start' }); await r.client.request('stale_next_state'); await r.stop();
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' }); assert.deepEqual(r.summary().queuedSteers, []); assert.deepEqual(r.summary().queuedFollowUps.map(entry => entry.text), ['new queue']);
});

test('inherit resets thinking outside discovery while unknown levels leave engine state unchanged', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('switch_model', { model: 'image' });
  await waitUntil(() => r.summary().selectedModelID === 'fixture/image' && r.summary().thinkingLevels.includes('high'));
  assert.equal(r.summary().thinkingLevel, 'high');
  assert.deepEqual(r.summary().thinkingLevels, ['off', 'high']);
  await r.selectThinking('off');
  assert.equal(r.summary().thinkingLevel, 'off');
  await r.selectThinking('inherit');
  assert.equal(r.summary().thinkingLevel, 'inherit');
  const inheritedState = await r.refreshState();
  assert.ok(inheritedState);
  assert.equal(inheritedState.thinkingLevel, undefined);
  for (const level of ['unknown', 'auto']) {
    await r.selectThinking(level);
    await r.refreshState();
    assert.equal(r.summary().thinkingLevel, 'inherit');
    assert.deepEqual(r.summary().thinkingLevels, ['off', 'high']);
  }
});

for (const event of ['agent_start', 'session_settled', 'thinking_level_changed']) test(`model refresh is independent of ${event}, while preserving newer thinking`, async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('hold_model');
  await heldLevels(r.client);
  await r.client.request('emit_event', { frame: event === 'thinking_level_changed' ? { type: event, level: 'off' } : { type: event } });
  await r.client.request('emit_event', { frame: { type: 'queue_update', steering: [], followUp: ['newer queue'] } });
  await r.client.request('release_levels');
  await waitUntil(() => r.summary().selectedModelID === 'fixture/image');
  assert.deepEqual(r.summary().thinkingLevels, ['off', 'high']); assert.equal(r.summary().thinkingLevel, event === 'thinking_level_changed' ? 'off' : 'high');
  assert.equal(r.summary().models.find(model => model.id === 'fixture/image')?.supportsImages, true);
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: event === 'agent_start' ? 'running' : 'idle' });
  assert.deepEqual(r.summary().queuedFollowUps.map(entry => entry.text), ['newer queue']);
});

test('new model event cancels old refresh and shutdown prevents stale configuration applying on reconnect', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('hold_model'); await heldLevels(r.client);
  assert.equal(r.summary().selectedModelID, 'fixture/text');
  await r.client.request('switch_model', { model: 'text' });
  await r.client.request('release_levels');
  await waitUntil(() => r.summary().selectedModelID === 'fixture/text' && r.summary().thinkingLevels.length === 1);
  assert.equal(r.summary().selectedModelID, 'fixture/text'); assert.deepEqual(r.summary().thinkingLevels, ['off']); assert.equal(r.summary().error, null);
  await r.client.request('hold_model'); await heldLevels(r.client); await r.shutdown(); await r.connect(f.executable);
  assert.equal(r.summary().selectedModelID, 'fixture/text'); assert.equal(r.summary().error, null);
});

test('context usage is restored from actual state and copied into immutable renderer snapshots', async t => {
  const initial = { tokens: 2500, contextWindow: 922000 };
  const restored = { tokens: 4000000, contextWindow: 922000 };
  const f = await fixture(t, { history: 'pages', contextUsage: initial, restoredContextUsage: restored });
  assert.equal(f.runtime.summary().contextUsage, null);
  await f.runtime.connect(f.executable);
  assert.deepEqual(f.cache.get(f.record.id)?.contextUsage, restored);
  const summary = f.runtime.summary(); const snapshot = f.runtime.snapshot();
  assert.ok(summary.contextUsage); assert.ok(snapshot.contextUsage);
  summary.contextUsage.tokens = 1; snapshot.contextUsage.contextWindow = 1;
  assert.deepEqual(f.runtime.summary().contextUsage, restored);
  assert.equal((await commands(f.root)).some(frame => frame.type === 'prompt'), false);
});

test('missing and invalid context usage stays unknown', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime;
  await r.connect(f.executable);
  assert.equal(r.summary().contextUsage, null);
  const unavailable: Array<Json | undefined> = [undefined, null, {}, { tokens: 1 }, { contextWindow: 922000 }, { tokens: -1, contextWindow: 922000 }, { tokens: '2500', contextWindow: 922000 }, { tokens: 2500, contextWindow: 0 }, { tokens: 2500, contextWindow: -1 }, { tokens: 2500, contextWindow: '922000' }];
  for (const value of unavailable) {
    await r.client.request('set_context_usage', { value: { tokens: 2500, contextWindow: 922000 } });
    await r.refreshState(); assert.equal(r.summary().contextUsage?.tokens, 2500);
    await r.client.request('set_context_usage', value === undefined ? {} : { value });
    await r.refreshState();
    assert.equal(r.summary().contextUsage, null, JSON.stringify(value));
  }
  for (const value of [{ tokens: 0, contextWindow: 922000 }, { tokens: 4000000, contextWindow: 922000 }]) {
    await r.client.request('set_context_usage', { value: { ...value, percent: 999 } });
    await r.refreshState();
    assert.deepEqual(r.summary().contextUsage, value);
  }
});

test('live context refresh coalesces overlapping boundaries and never polls token deltas', async t => {
  const f = await fixture(t, { history: 'empty', contextUsage: { tokens: 2500, contextWindow: 922000 } }); const r = f.runtime;
  await r.connect(f.executable);
  const before = (await commands(f.root)).filter(frame => frame.type === 'get_state').length;
  for (let index = 0; index < 20; index++) await r.client.request('emit_event', { frame: { type: 'message_update', messageId: 'live', assistantMessageEvent: { type: 'text_delta', delta: 'word ' } } });
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'get_state').length, before);
  await r.client.request('hold_next_state');
  await r.client.request('set_context_usage', { value: { tokens: 8000, contextWindow: 922000 }, events: [
    { type: 'message_end', messageId: 'live', message: { role: 'assistant', content: 'Completed answer' } },
    { type: 'turn_end' }, { type: 'auto_compaction_end' },
  ] });
  await heldUsageState(r.client);
  await r.client.request('set_context_usage', { value: { tokens: 1200, contextWindow: 922000 }, events: [
    { type: 'session_settled' }, { type: 'queue_update', steering: [], followUp: ['keep this queue'] },
    { type: 'thinking_level_changed', level: 'high' },
  ] });
  await r.client.request('release_state');
  await waitUntil(() => f.cache.get(f.record.id)?.contextUsage?.tokens === 1200);
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'get_state').length - before, 2);
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
  assert.deepEqual(r.summary().queuedFollowUps.map(entry => entry.text), ['keep this queue']);
  assert.equal(r.summary().thinkingLevel, 'high');
  for (const [type, tokens] of [['agent_end', 1500], ['auto_compaction_end', 700], ['turn_end', 900]] as const) {
    await r.client.request('set_context_usage', { value: { tokens, contextWindow: 922000 }, events: [{ type }] });
    await waitUntil(() => f.cache.get(f.record.id)?.contextUsage?.tokens === tokens);
  }
  assert.equal(await r.sendPrompt('context turn'), true);
  await r.client.request('set_context_usage', { value: { tokens: 1800, contextWindow: 922000 } });
  await r.client.request('complete_prompt', { settled: true });
  await waitUntil(() => f.cache.get(f.record.id)?.contextUsage?.tokens === 1800);
  await r.client.request('set_context_usage', { value: { tokens: 500, contextWindow: 922000 } });
  await r.client.request('compact');
  await waitUntil(() => f.cache.get(f.record.id)?.contextUsage?.tokens === 500);
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'get_available_models').length, 1);
});

test('a model switch rejects held usage from the previous model without reversing thread state', async t => {
  const f = await fixture(t, { history: 'empty', contextUsage: { tokens: 2500, contextWindow: 922000 } }); const r = f.runtime;
  await r.connect(f.executable);
  await r.client.request('hold_next_state');
  await r.client.request('set_context_usage', { value: { tokens: 8000, contextWindow: 922000 }, events: [{ type: 'turn_end' }] });
  await heldUsageState(r.client);
  await r.client.request('set_context_usage', { value: { tokens: 4000000, contextWindow: 200000 } });
  await r.client.request('switch_model', { model: 'image' });
  assert.equal(r.summary().contextUsage, null);
  const boundary = f.events.length;
  await r.client.request('emit_event', { frame: { type: 'agent_start' } });
  await r.client.request('emit_event', { frame: { type: 'queue_update', steering: ['new steer'], followUp: [] } });
  await r.client.request('emit_event', { frame: { type: 'thinking_level_changed', level: 'off' } });
  await r.client.request('release_state');
  await waitUntil(() => f.cache.get(f.record.id)?.contextUsage?.tokens === 4000000 && r.summary().selectedModelID === 'fixture/image');
  assert.deepEqual(r.summary().contextUsage, { tokens: 4000000, contextWindow: 200000 });
  assert.equal(f.events.slice(boundary).some(event => (event.kind === 'summary' || event.kind === 'snapshot') && event.runtime.contextUsage?.tokens === 8000), false);
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'running' });
  assert.deepEqual(r.summary().queuedSteers.map(entry => entry.text), ['new steer']);
  assert.equal(r.summary().thinkingLevel, 'off');
});

test('thread usage remains independent and reconnect hides cached usage until authoritative state returns', async t => {
  const a = await fixture(t, { history: 'empty', contextUsage: { tokens: 2500, contextWindow: 922000 } });
  const b = await fixture(t, { history: 'empty', contextUsage: { tokens: 4000000, contextWindow: 200000 } });
  await Promise.all([a.runtime.connect(a.executable), b.runtime.connect(b.executable)]);
  const cache = new Map([...a.cache, ...b.cache]);
  let selected = a.record.id;
  assert.deepEqual(cache.get(selected)?.contextUsage, { tokens: 2500, contextWindow: 922000 });
  selected = b.record.id;
  assert.deepEqual(cache.get(selected)?.contextUsage, { tokens: 4000000, contextWindow: 200000 });
  await a.runtime.client.request('set_context_usage', { events: [{ type: 'auto_compaction_end' }] });
  await waitUntil(() => a.cache.get(a.record.id)?.contextUsage === null);
  assert.deepEqual(b.runtime.summary().contextUsage, { tokens: 4000000, contextWindow: 200000 });
  await b.runtime.shutdown();
  assert.equal(b.runtime.summary().contextUsage, null);
  const reconnect = b.runtime.connect(b.executable);
  assert.equal(b.runtime.summary().status.kind, 'connecting');
  assert.equal(b.runtime.summary().contextUsage, null);
  await reconnect;
  assert.deepEqual(b.cache.get(b.record.id)?.contextUsage, { tokens: 4000000, contextWindow: 200000 });
});

test('invalid and oversized dialog responses retain dialog and input until corrected', async t => {
  const f = await fixture(t, { history: 'empty', limit: 1024 }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('dialog', { frame: { id: 'input', method: 'input', title: 'Name', placeholder: 'Short name', timeout: 10000 } });
  assert.equal(await r.respond('input', { value: 42 }), false); assert.equal(r.summary().dialogs.length, 1); assert.match(r.summary().dialogs[0]?.error ?? '', /text/);
  assert.equal(await r.respond('input', { value: 'x'.repeat(1024) }), false); assert.equal(r.summary().dialogs.length, 1); assert.match(r.summary().dialogs[0]?.error ?? '', /input limit/);
  assert.equal(await r.respond('input', { value: 'short' }), true); assert.equal(r.summary().dialogs.length, 0);
  await r.client.request('barrier');
  const responses = (await commands(f.root)).filter(frame => frame.type === 'extension_ui_response');
  assert.deepEqual(responses, [{ type: 'extension_ui_response', id: 'input', value: 'short' }]);
});

for (const expiry of [false, true]) test(`queued dialog approval is cancelled by ${expiry ? 'expiry' : 'targetId cancellation'}`, async t => {
  const f = await fixture(t, { history: 'empty', limit: 1024 }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('dialog', { frame: { id: 'approval', method: 'confirm', title: 'Approve', message: 'Proceed?', timeout: expiry ? 150 : 10000 } });
  await r.client.request('pause_input', expiry ? {} : { cancel: 'approval' });
  const writes = Array.from({ length: 1200 }, () => r.client.send({ type: 'filler', text: 'x'.repeat(900) }));
  const response = r.respond('approval', { confirmed: true });
  await waitUntil(() => r.summary().dialogs.length === 0);
  assert.equal(await response, false);
  await Promise.all(writes); await r.client.request('barrier');
  assert.equal((await commands(f.root)).some(frame => frame.type === 'extension_ui_response' && frame.confirmed === true), false);
  assert.equal(r.summary().dialogs.length, 0);
});

test('partial active stdin cancellation fails transport closed and never appends queued approval', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('pause_input');
  const controller = new AbortController();
  const active = assert.rejects(r.client.send({ type: 'filler', text: 'x'.repeat(900000) }, { signal: controller.signal }), /cancelled during a write/);
  const queued = assert.rejects(r.client.send({ type: 'extension_ui_response', id: 'no', confirmed: true }), /cancelled during a write/);
  controller.abort(); await Promise.all([active, queued]);
  assert.equal(r.client.ready, false); assert.equal(r.summary().status.kind, 'closed');
});

test('dialogs validate canonical schemas, deny malformed requests, and never autoapprove', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  const families: Array<[JsonRecord, JsonRecord]> = [
    [{ id: 'confirm', method: 'confirm', title: 'Approve', message: 'Proceed?' }, { confirmed: false }],
    [{ id: 'select', method: 'select', title: 'Pick', options: ['A', 'B'], optionDetails: [{ description: 'First' }, {}] }, { value: 'B' }],
    [{ id: 'input', method: 'input', title: 'Name' }, { value: 'Name' }],
    [{ id: 'editor', method: 'editor', title: 'Edit', prefill: 'old', timeout: 0 }, { value: 'new\ntext' }],
    [{ id: 'ask', method: 'ask', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multi: true }] }, { answers: [{ id: 'q', selectedOptions: ['A', 'B'], customInput: ' extra ' }] }],
  ];
  for (const [frame, fields] of families) {
    const dialog = parseDialog({ type: 'extension_ui_request', ...frame }); assert.ok(dialog);
    const response = dialogResponse(dialog, fields); assert.equal(response.type, 'extension_ui_response'); assert.equal(response.id, frame.id);
    if (frame.method === 'editor') assert.equal(dialog.deadline, null);
    await r.client.request('dialog', { frame }); assert.equal(await r.respond(dialog.id, fields), true);
  }
  const ask = parseDialog({ id: 'ask', method: 'ask', questions: [{ id: 'one', question: 'Choose', options: [{ label: 'A' }] }] }); assert.ok(ask);
  const invalidAnswers: JsonRecord[] = [{ answers: [] }, { answers: [{ id: 'wrong', selectedOptions: [] }] }, { answers: [{ id: 'one', selectedOptions: ['foreign'] }] }, { answers: [{ id: 'one', selectedOptions: ['A', 'A'] }] }, { answers: [{ id: 'one', selectedOptions: ['A'], customInput: 'also' }] }];
  for (const fields of invalidAnswers) assert.throws(() => dialogResponse(ask, fields), RpcError);
  assert.deepEqual(dialogResponse(ask, { cancelled: true }), { type: 'extension_ui_response', id: 'ask', cancelled: true });
  const invalidFrames: JsonRecord[] = [{ id: 'bad', method: 'select', title: 'Pick', options: ['A', 'A'] }, { id: 'bad', method: 'ask', questions: [{ id: 'q', question: 'Q', options: [], recommended: 0 }] }, { id: 'bad', method: 'input', title: 'Secret', secret: true }, { id: 'bad', method: 'unknown', title: 'X' }];
  for (const frame of invalidFrames) assert.equal(parseDialog(frame), null);
  await r.client.request('dialog', { frame: { id: 'bad', method: 'unknown', title: 'X' } });
  await waitUntil(() => r.summary().error?.includes('No approval') === true);
  await r.client.request('barrier'); assert.equal((await commands(f.root)).some(frame => frame.type === 'extension_ui_response' && frame.id === 'bad' && frame.cancelled === true), true);
});

test('canonical full/delta finalization, interleaved identity, tool association and immutable incremental events', () => {
  const messages: ChatMessage[] = [], tools: ToolActivity[] = [];
  const store = new MessageStore(message => messages.push(structuredClone(message)), tool => tools.push({ ...tool }));
  store.consume({ type: 'message_start', messageId: 'a', message: { role: 'assistant', content: [] } });
  store.consume({ type: 'message_update', messageId: 'a', assistantMessageEvent: { type: 'text_delta', delta: 'Hello', contentIndex: 0 } });
  store.consume({ type: 'message_end', messageId: 'injected', message: { role: 'user', content: 'Injected' } });
  store.consume({ type: 'message_update', messageId: 'a', assistantMessageEvent: { type: 'text_delta', delta: ' world', contentIndex: 0 } });
  assert.equal(store.messages.get('a')?.text, 'Hello world');
  store.consume({ type: 'message_update', messageId: 'a', assistantMessageEvent: { type: 'text_end', content: 'Hello world', contentIndex: 0 } });
  assert.equal(store.messages.get('a')?.text, 'Hello world');
  store.consume({ type: 'message_update', messageId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'Snapshot' }, { type: 'thinking', thinking: 'Reasoning' }, { type: 'toolCall', id: 'tool', name: 'read', arguments: { path: 'a.ts', api_key: 'hidden' } }] } });
  store.consume({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: { path: 'a.ts' } });
  store.consume({ type: 'tool_execution_end', toolCallId: 'tool', result: { content: [{ type: 'text', text: 'output' }] }, isError: false });
  assert.deepEqual(store.messages.get('a')?.toolIDs, ['tool']); assert.deepEqual(store.messages.get('injected')?.toolIDs, []); assert.equal(store.tools.get('tool')?.state, 'succeeded');
  store.consume({ type: 'message_end', messageId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'Final' }, { type: 'image' }] } });
  store.consume({ type: 'message_update', messageId: 'a', assistantMessageEvent: { type: 'text_delta', delta: 'late', contentIndex: 0 } });
  assert.equal(store.messages.get('a')?.text, 'Final'); assert.deepEqual(store.messages.get('a')?.images, []); assert.equal(store.messages.get('a')?.isStreaming, false);
  assert.equal(messages[1]?.text, 'Hello'); assert.ok(tools.length > 0);
});

test('live and restored messages retain real image blocks without placeholder text', () => {
  const png = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  const store = new MessageStore(() => {}, () => {});
  store.consume({ type: 'message_end', messageId: 'image-only', message: { role: 'user', content: [png] } });
  assert.equal(store.messages.get('image-only')?.text, '');
  assert.deepEqual(store.messages.get('image-only')?.images, [png]);
  const content = [{ type: 'text', text: 'Compare these' }, png, png];
  store.consume({ type: 'message_end', messageId: 'mixed', message: { role: 'user', content } });
  assert.equal(store.messages.get('mixed')?.text, 'Compare these');
  assert.deepEqual(store.messages.get('mixed')?.images, [png, png]);
  store.restore([{ role: 'user', content }, { role: 'user', content: [png] }]);
  assert.deepEqual(store.messages.get('history-0')?.images, [png, png]);
  assert.equal(store.messages.get('history-1')?.text, '');
  assert.deepEqual(store.messages.get('history-1')?.images, [png]);
});

test('restored pending tools are interrupted and toolResult messages retain actual owners', () => {
  const store = new MessageStore(() => {}, () => {});
  store.restore([{ role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'read', arguments: {} }] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'finished', name: 'read', arguments: {} }] }, { role: 'toolResult', toolCallId: 'finished', content: [{ type: 'text', text: 'done' }] }]);
  assert.equal(store.messages.size, 2); assert.equal(store.tools.get('pending')?.state, 'interrupted'); assert.equal(store.tools.get('finished')?.state, 'succeeded'); assert.deepEqual(store.messages.get('history-1')?.toolIDs, ['finished']);
});

test('runtime deltas emit one message event, no full histories, summaries and snapshots do not alias state', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable); f.events.length = 0;
  r.consume({ type: 'message_update', messageId: 'one', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
  assert.equal(f.events.length, 1); assert.equal(f.events[0]?.kind, 'message');
  const snapshot = r.snapshot(); if (snapshot.messages[0]) snapshot.messages[0].text = 'corrupt';
  r.consume({ type: 'queue_update', steering: ['one'], followUp: ['two'] }); const summary = r.summary(); summary.queuedSteers.push({ text: 'corrupt', imageCount: 0, imageRef: null }); if (summary.models[0]) summary.models[0].name = 'corrupt';
  assert.equal(r.snapshot().messages[0]?.text, 'hello'); assert.deepEqual(r.summary().queuedSteers.map(entry => entry.text), ['one']);
  assert.ok(f.events.every(event => event.kind !== 'snapshot'));
  const revisions = f.events.map(event => event.kind === 'summary' ? event.runtime.revision : event.revision);
  assert.ok(revisions.every((revision, index) => index === 0 || revision > (revisions[index - 1] ?? 0)));
  r.consume({ type: 'subagent_progress', payload: { progress: { id: 'sub', status: 'running', currentTool: 'Read a.ts' } } });
  assert.equal(r.summary().subagents[0]?.id, 'sub'); assert.equal(r.snapshot().messages.length, 1);
  r.consume({ type: 'future_informational_event' }); assert.equal(r.summary().error, null);
  r.consume({ type: 'transport_error', error: 'password=secret disconnected' });
  assert.equal(r.summary().status.kind, 'closed'); assert.doesNotMatch(r.summary().error ?? '', /secret/); assert.equal(r.snapshot().messages[0]?.isStreaming, false);
});

test('concurrent start is reserved before filesystem awaits and shutdown cancels pre-spawn startup', async t => {
  const f = await fixture(t, { history: 'empty' }); const client = f.runtime.client;
  const options = { executable: f.executable, projectPath: f.root, sessionDirectory: f.record.ompSessionDirectory, resume: true };
  const first = client.start(options);
  await assert.rejects(client.start(options), /already owns/);
  await first; await client.shutdown();
  const cancelled = client.start(options);
  const rejected = assert.rejects(cancelled, /startup was cancelled/);
  await client.shutdown(); await rejected;
  assert.equal(client.ready, false);
});

test('missing saved history is visible and never replays the interrupted action', async t => {
  const f = await fixture(t, { history: 'empty' });
  f.record.displayTitle = 'Interrupted work'; f.record.wasRunning = true;
  await f.runtime.connect(f.executable);
  assert.equal(f.runtime.summary().status.kind, 'ready');
  assert.match(f.runtime.summary().notice ?? '', /Saved session missing or empty/);
  assert.equal((await commands(f.root)).some(frame => frame.type === 'prompt'), false);
});

test('a background prompt yield remains busy until session_settled; queues replace instead of accumulating', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.sendPrompt('background');
  await r.client.request('emit_event', { frame: { type: 'agent_end', awaitingAsyncWork: true } });
  await r.client.request('complete_prompt', { settled: false });
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'background' });
  r.consume({ type: 'queue_update', steering: ['old'], followUp: ['next'] });
  r.consume({ type: 'queue_update', steering: [], followUp: ['replacement'] });
  assert.deepEqual(r.summary().queuedSteers, []); assert.deepEqual(r.summary().queuedFollowUps.map(entry => entry.text), ['replacement']);
  await r.client.request('settle'); assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'idle' });
});

test('canonical queues clear a delivered image steer without a queue_update notification', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  const message = 'Move the spinner to the far right.';
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  await r.sendPrompt('Working turn');
  await r.client.request('set_queue_state', { steering: [message], events: [{ type: 'queue_update', steering: [message], followUp: [] }] });
  assert.deepEqual(f.cache.get(f.record.id)?.queuedSteers.map(entry => entry.text), [message]);
  await r.client.request('set_queue_state', { steering: [], events: [{ type: 'message_end', messageId: 'delivered-steer', message: { role: 'user', steering: true, content: [{ type: 'text', text: message }, image] } }] });
  await waitUntil(() => f.cache.get(f.record.id)?.queuedSteers.length === 0);
  const delivered = f.cache.get(f.record.id)?.messages.find(item => item.id === 'delivered-steer');
  assert.equal(delivered?.text, message); assert.deepEqual(delivered?.images, [image]);
  assert.deepEqual(r.summary().status, { kind: 'ready', activity: 'running' });
});

test('a pre-delivery state read cannot resurrect a delivered queued steer', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('set_queue_state', { steering: ['queued'], events: [{ type: 'queue_update', steering: ['queued'], followUp: [] }] });
  await r.client.request('hold_next_state');
  await r.client.request('emit_event', { frame: { type: 'turn_end' } }); await heldUsageState(r.client);
  await r.client.request('set_queue_state', { steering: [], events: [{ type: 'message_end', messageId: 'delivered', message: { role: 'user', content: 'queued' } }] });
  assert.deepEqual(r.summary().queuedSteers.map(entry => entry.text), ['queued']);
  await r.client.request('release_state');
  await waitUntil(() => f.cache.get(f.record.id)?.queuedSteers.length === 0);
  assert.equal(f.cache.get(f.record.id)?.messages.find(item => item.id === 'delivered')?.text, 'queued');
});

test('newer queue events outrank held boundary reads while fresh queued state is reconciled', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('hold_next_state');
  await r.client.request('emit_event', { frame: { type: 'turn_end' } }); await heldUsageState(r.client);
  await r.client.request('set_context_usage', { value: { tokens: 1800, contextWindow: 922000 } });
  await r.client.request('emit_event', { frame: { type: 'queue_update', steering: ['new intent'], followUp: [] } });
  const boundary = f.events.length;
  await r.client.request('release_state');
  await waitUntil(() => f.cache.get(f.record.id)?.contextUsage?.tokens === 1800);
  assert.deepEqual(f.cache.get(f.record.id)?.queuedSteers.map(entry => entry.text), ['new intent']);
  for (const event of f.events.slice(boundary)) if (event.kind === 'summary') assert.deepEqual(event.runtime.queuedSteers.map(entry => entry.text), ['new intent']);
});

test('native live-steer and identical pending messages are not deduplicated against history', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  await r.client.request('set_queue_state', { steering: ['same', 'same'], count: 0, events: [{ type: 'turn_end' }] });
  await waitUntil(() => f.cache.get(f.record.id)?.queuedSteers.length === 2);
  await r.client.request('set_queue_state', { steering: ['same'], count: 0, events: [{ type: 'message_end', messageId: 'one-delivered', message: { role: 'user', content: 'same' } }] });
  await waitUntil(() => f.cache.get(f.record.id)?.queuedSteers.length === 1);
  assert.deepEqual(r.summary().queuedSteers.map(entry => entry.text), ['same']);
  await r.client.request('set_queue_state', { steering: ['same', 'same'], events: [{ type: 'turn_end' }] });
  await waitUntil(() => f.cache.get(f.record.id)?.queuedSteers.length === 2);
  assert.deepEqual(r.summary().queuedSteers.map(entry => entry.text), ['same', 'same']);
  assert.equal(r.snapshot().messages.filter(message => message.role === 'user').length, 1);
});

test('block-end values replace only their own block and do not duplicate earlier text or reasoning', () => {
  const store = new MessageStore(() => {}, () => {});
  for (const [index, kind, value] of [[0, 'thinking', 'Reason'], [1, 'text', 'Answer'], [2, 'text', 'Tail']] as const) store.consume({ type: 'message_update', messageId: 'reply', assistantMessageEvent: { type: `${kind}_delta`, contentIndex: index, delta: value } });
  store.consume({ type: 'message_update', messageId: 'reply', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Canonical answer' } });
  assert.equal(store.messages.get('reply')?.thinking, 'Reason');
  assert.equal(store.messages.get('reply')?.text, 'Canonical answer\n\nTail');
  store.consume({ type: 'message_update', messageId: 'reply', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Final reasoning' } });
  assert.equal(store.messages.get('reply')?.thinking, 'Final reasoning');
  assert.equal(store.messages.get('reply')?.text, 'Canonical answer\n\nTail');
});

test('payload-free model changes update existing capabilities without duplicate models', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime; await r.connect(f.executable);
  assert.equal(r.summary().models.find(model => model.id === 'fixture/text')?.supportsImages, false);
  await r.client.request('switch_capabilities');
  await waitUntil(() => r.summary().models.find(model => model.id === 'fixture/text')?.supportsImages === true);
  assert.equal(r.summary().models.filter(model => model.id === 'fixture/text').length, 1);
  await r.client.request('switch_model', { model: 'text' });
  await waitUntil(() => r.summary().models.find(model => model.id === 'fixture/text')?.supportsImages === false);
});

for (const omitted of [false, true]) test(`model state ${omitted ? 'preserves catalog capabilities when omitted' : 'overrides catalog capabilities when explicit'}`, async t => {
  const f = await fixture(t, { history: 'empty', catalogImages: true, omitModelInput: omitted });
  await f.runtime.connect(f.executable);
  assert.equal(f.runtime.summary().models.find(model => model.id === 'fixture/text')?.supportsImages, omitted);
});

for (const retirement of ['idle eviction', 'Terminal handoff'] as const) test(`${retirement} recreates a runtime above cached revisions and accepts connecting, restored, dialog and streamed states`, async t => {
  const f = await applicationFixture(t);
  try {
    const first = f.threads[0];
    assert.ok(first);
    await f.app.selectThread(first.id);
    const old = await f.app.runtimeFor(first.id);
    for (let index = 0; index < 32; index++) await old.client.request('emit_event', { frame: { type: 'notice', message: `Prior revision ${index}` } });
    await old.client.request('emit_event', { frame: { type: 'message_update', messageId: 'old-stream', assistantMessageEvent: { type: 'text_delta', delta: 'Previous runtime only' } } });
    const beforeShutdown = old.summary().revision;
    if (retirement === 'idle eviction') {
      for (const thread of f.threads.slice(1)) await f.app.selectThread(thread.id);
    } else {
      await f.app.terminal(first.id);
      assert.equal(f.terminalCommands.length, 1);
      assert.match(f.terminalCommands[0] ?? '', /--session-dir .* --continue$/);
    }
    assert.equal(f.app.runtimes.has(first.id), false);
    assert.ok(old.summary().revision > beforeShutdown, 'Shutdown interruption must advance the reserved revision');
    assert.equal(f.cache.get(first.id)?.revision, old.summary().revision);
    const opening = f.app.selectThread(first.id);
    const connecting = f.cache.get(first.id);
    assert.equal(connecting?.status.kind, 'connecting');
    assert.ok(connecting && connecting.revision > old.summary().revision);
    await opening;
    const replacement = await f.app.runtimeFor(first.id);
    assert.notEqual(replacement, old);
    assert.equal(f.cache.get(first.id)?.status.kind, 'ready');
    assert.deepEqual(f.cache.get(first.id)?.messages.map(message => message.text), ['Original prompt', 'Original answer', '']);
    const deliveredBeforeObsolete = f.delivered.length;
    const metadataBeforeObsolete = structuredClone(f.app.manifest);
    for (let index = 0; index < 64; index++) old.consume({ type: 'notice', message: 'Obsolete instance' });
    old.consume({ type: 'agent_start' });
    old.consume({ type: 'extension_ui_request', method: 'set_editor_text', text: 'Obsolete draft' });
    old.onSessionName?.('Obsolete native title callback');
    old.consume({ type: 'session_info_update', sessionId: first.ompSessionDirectory, title: 'Obsolete native title event' });
    assert.equal(f.delivered.length, deliveredBeforeObsolete);
    assert.deepEqual(f.app.manifest, metadataBeforeObsolete);
    await replacement.client.request('dialog', { frame: { id: 'replacement-dialog', method: 'input', title: 'Current input' } });
    assert.equal(f.cache.get(first.id)?.dialogs[0]?.id, 'replacement-dialog');
    await replacement.client.request('emit_event', { frame: { type: 'message_update', messageId: 'replacement-stream', assistantMessageEvent: { type: 'text_delta', delta: 'Current streamed text' } } });
    assert.equal(f.cache.get(first.id)?.messages.find(message => message.id === 'replacement-stream')?.text, 'Current streamed text');
    const acceptedForThread = f.accepted.filter(event => (event.kind === 'summary' || event.kind === 'snapshot' ? event.runtime.id : event.threadID) === first.id);
    const revisions = acceptedForThread.map(event => event.kind === 'summary' || event.kind === 'snapshot' ? event.runtime.revision : event.revision);
    assert.ok(revisions.every((revision, index) => index === 0 || revision > (revisions[index - 1] ?? 0)));
    assert.equal((await commands(f.root)).some(frame => ['prompt', 'steer', 'follow_up', 'abort_and_prompt', 'restore'].includes(String(frame.type))), false);
  } finally { await f.app.shutdown(); }
});

for (const recovery of ['named closed', 'interrupted closed', 'named reopen'] as const) test(`${recovery} reconnect uses current metadata for empty-history recovery without resetting revisions or replaying`, async t => {
  const f = await applicationFixture(t, 'empty');
  try {
    const first = f.threads[0];
    assert.ok(first);
    await f.app.selectThread(first.id);
    const runtime = await f.app.runtimeFor(first.id);
    assert.equal(runtime.summary().notice, null);
    await f.app.renameThread(first.id, 'Named after connection');
    const interrupted = recovery === 'interrupted closed';
    if (interrupted) await runtime.client.request('emit_event', { frame: { type: 'agent_start' } });
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.wasRunning, interrupted);
    assert.equal(runtime.record.displayTitle, 'New thread');
    assert.equal(runtime.record.wasRunning, false);
    if (recovery !== 'named reopen') await runtime.shutdown();
    const previousRevision = runtime.summary().revision;
    const start = f.accepted.length;
    await f.app.selectThread(first.id, recovery === 'named reopen');
    assert.equal(await f.app.runtimeFor(first.id), runtime);
    assert.ok(runtime.summary().revision > previousRevision);
    const connecting = f.accepted.slice(start).find(event => event.kind === 'summary' && event.runtime.status.kind === 'connecting');
    assert.ok(connecting && connecting.kind === 'summary');
    if (interrupted) assert.match(connecting.runtime.notice ?? '', /previous process was interrupted/);
    else assert.equal(connecting.runtime.notice, null);
    assert.equal(runtime.record.displayTitle, 'Named after connection');
    assert.equal(runtime.record.wasRunning, interrupted);
    assert.match(f.cache.get(first.id)?.notice ?? '', /Saved session missing or empty/);
    assert.equal(f.cache.get(first.id)?.status.kind, 'ready');
    assert.equal((await commands(f.root)).some(frame => ['prompt', 'steer', 'follow_up', 'abort_and_prompt', 'restore'].includes(String(frame.type))), false);
  } finally { await f.app.shutdown(); }
});

for (const kind of ['text', 'thinking'] as const) test(`adjacent ${kind} start/delta/end blocks preserve rendered contributors and full-snapshot separators`, () => {
  const store = new MessageStore(() => {}, () => {});
  const update = (type: string, index: number, fields: JsonRecord = {}) => store.consume({ type: 'message_update', messageId: 'adjacent', assistantMessageEvent: { type, contentIndex: index, ...fields } });
  update(`${kind}_start`, 0);
  update(`${kind}_start`, 1);
  update(`${kind}_delta`, 1, { delta: 'First' });
  assert.equal(store.messages.get('adjacent')?.[kind], 'First', 'A start-only earlier block contributes no separator');
  update(`${kind}_end`, 1, { content: 'First' });
  update(`${kind}_start`, 2);
  assert.equal(store.messages.get('adjacent')?.[kind], 'First');
  update(`${kind}_delta`, 2, { delta: 'Second' });
  assert.equal(store.messages.get('adjacent')?.[kind], 'First\n\nSecond', 'The first delta must already match canonical block separation');
  update(`${kind}_delta`, 2, { delta: ' tail' });
  assert.equal(store.messages.get('adjacent')?.[kind], 'First\n\nSecond tail');
  update(`${kind}_end`, 2, { content: 'Second tail' });
  assert.equal(store.messages.get('adjacent')?.[kind], 'First\n\nSecond tail');
  store.consume({ type: 'message_end', messageId: 'adjacent', message: { role: 'assistant', content: [{ type: kind }, { type: kind, [kind]: 'First' }, { type: kind, [kind]: 'Second tail' }] } });
  assert.equal(store.messages.get('adjacent')?.[kind], 'First\n\nSecond tail');
});

for (const kind of ['text', 'thinking'] as const) test(`${kind} deltas distinguish empty rendered strings from start-only blocks`, () => {
  const store = new MessageStore(() => {}, () => {});
  store.consume({ type: 'message_start', messageId: 'empty-contributor', message: { role: 'assistant', content: [{ type: kind, [kind]: '' }, { type: kind }, { type: kind }] } });
  store.consume({ type: 'message_update', messageId: 'empty-contributor', assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 1, delta: 'Second' } });
  assert.equal(store.messages.get('empty-contributor')?.[kind], '\n\nSecond');
  store.consume({ type: 'message_end', messageId: 'empty-contributor', message: { role: 'assistant', content: [{ type: kind, [kind]: '' }, { type: kind, [kind]: 'Second' }, { type: kind }] } });
  assert.equal(store.messages.get('empty-contributor')?.[kind], '\n\nSecond');
});

test('canonical todo state restores after history hydration, stays thread-local, and is defensively copied', async t => {
  const initial = [{ name: 'Old', tasks: [{ content: 'Previous', status: 'pending' }] }];
  const restored = [{ name: 'Build', tasks: [{ content: 'Implemented', status: 'completed' }, { content: 'Verify', status: 'in_progress' }] }];
  const a = await fixture(t, { history: 'pages', todoPhases: initial, restoredTodoPhases: restored });
  const b = await fixture(t, { history: 'empty' });
  await a.runtime.connect(a.executable); await b.runtime.connect(b.executable);
  assert.deepEqual(a.cache.get(a.record.id)?.todoPhases, restored);
  assert.deepEqual(b.runtime.summary().todoPhases, []);
  const snapshot = a.runtime.snapshot(); snapshot.todoPhases[0]?.tasks.splice(0, 1);
  assert.deepEqual(a.runtime.summary().todoPhases, restored);
  await a.runtime.shutdown(); await a.runtime.connect(a.executable);
  assert.deepEqual(a.runtime.summary().todoPhases, restored);
  assert.equal((await commands(a.root)).some(frame => frame.type === 'prompt'), false);
});

test('todo completion and eval commits supersede an in-flight older state read without rollback', async t => {
  const pending = [{ name: 'Build', tasks: [{ content: 'Implement', status: 'in_progress' }] }];
  const completed = [{ name: 'Build', tasks: [{ content: 'Implement', status: 'completed' }] }];
  const f = await fixture(t, { history: 'empty', todoPhases: pending }); const r = f.runtime;
  await r.connect(f.executable);
  await r.client.request('hold_next_state');
  await r.client.request('emit_event', { frame: { type: 'turn_end' } });
  await heldUsageState(r.client);
  await r.client.request('set_todo_state', { phases: completed, events: [{
    type: 'tool_execution_end', toolCallId: 'done-task', toolName: 'todo', isError: false,
    result: { content: [{ type: 'text', text: 'Completed' }], details: { op: 'done', phases: completed } },
  }] });
  assert.deepEqual(r.summary().todoPhases, completed);
  const boundary = f.events.length;
  await r.client.request('release_state');
  await r.refreshState();
  assert.deepEqual(r.summary().todoPhases, completed);
  assert.ok(f.events.slice(boundary).filter(event => event.kind === 'summary').every(event => event.kind === 'summary' && event.runtime.todoPhases[0]?.tasks[0]?.status === 'completed'));
  await r.client.request('set_todo_state', { phases: [], events: [{
    type: 'tool_execution_end', toolCallId: 'eval-clear', toolName: 'eval', isError: false, result: { content: [{ type: 'text', text: 'Cleared in eval' }] },
  }] });
  await waitUntil(() => f.cache.get(f.record.id)?.todoPhases.length === 0);
  assert.deepEqual(r.summary().todoPhases, []);
});

test('subagent updates retain their original tool-call anchor across newer parent messages', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime;
  r.consume({ type: 'subagent_lifecycle', payload: { id: 'child', parentToolCallId: 'spawn', description: 'Inspect', status: 'started' } });
  assert.equal(r.summary().subagents[0]?.messageID, null);
  r.consume({ type: 'message_end', messageId: 'origin', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'spawn', name: 'task', arguments: {} }] } });
  assert.equal(r.summary().subagents[0]?.messageID, 'origin');
  r.consume({ type: 'message_end', messageId: 'newer', message: { role: 'assistant', content: 'New turn' } });
  r.consume({ type: 'subagent_progress', payload: { progress: { id: 'child', status: 'running', lastMessage: 'Still inspecting' } } });
  assert.equal(r.summary().subagents[0]?.messageID, 'origin');
});

test('subagent names do not become role labels during progress updates', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime;
  r.consume({ type: 'subagent_lifecycle', payload: { id: 'TranscriptAudit', agent: 'scout', description: 'Review rendering', status: 'started' } });
  r.consume({ type: 'subagent_progress', payload: { id: 'TranscriptAudit', agent: 'task', progress: { status: 'completed' } } });
  assert.equal(r.summary().subagents[0]?.title, 'TranscriptAudit');
  r.consume({ type: 'subagent_lifecycle', payload: { id: 'opaque-id', name: 'NamedReview', agent: 'scout', status: 'started' } });
  r.consume({ type: 'subagent_progress', payload: { id: 'opaque-id', agent: 'task', progress: { status: 'running' } } });
  assert.equal(r.summary().subagents.find(agent => agent.id === 'opaque-id')?.title, 'NamedReview');
});

test('successful todo RPC responses update the live cache before returning and clearing removes tasks', async t => {
  const f = await fixture(t, { history: 'empty' }); const r = f.runtime;
  await r.connect(f.executable);
  const phases = [{ name: 'Build', tasks: [{ content: 'Implement', status: 'in_progress' }] }];
  await r.client.request('set_todos', { phases });
  assert.deepEqual(f.cache.get(f.record.id)?.todoPhases, phases);
  await r.client.request('set_todos', { phases: [] });
  assert.deepEqual(f.cache.get(f.record.id)?.todoPhases, []);
});

test('account changes refresh idle catalogs without selecting chats, losing drafts, or replaying turns', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true });
  try {
    const [first, second] = f.threads;
    assert.ok(first && second);
    f.app.setDraft(first.id, 'Keep this unfinished draft');
    await f.app.selectThread(second.id);
    const before = f.cache.get(first.id);
    assert.ok(before);
    await writeFile(join(f.root, 'provider-models.json'), JSON.stringify([{ provider: 'connected', id: 'new-account-model', name: 'New account model', input: ['text'] }]));
    await f.app.refreshProviderConnections();
    assert.equal(f.app.manifest.selectedThreadID, second.id);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.draft, 'Keep this unfinished draft');
    for (const thread of [first, second]) {
      const restored = f.cache.get(thread.id);
      assert.ok(restored);
      assert.ok(restored.models.some(model => model.id === 'connected/new-account-model'));
      assert.equal(restored.status.kind, 'ready');
      assert.deepEqual(restored.messages.filter(message => message.role === 'user').map(message => message.text), ['Original prompt']);
    }
    assert.ok((f.cache.get(first.id)?.revision ?? 0) > before.revision);
    assert.equal((await commands(f.root)).some(frame => ['prompt', 'abort', 'abort_and_prompt', 'restore'].includes(String(frame.type))), false);
  } finally { await f.app.shutdown(); }
});

test('account changes leave background work running and adopt new catalogs only after native settlement', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true });
  try {
    const first = f.threads[0];
    assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    f.app.setDraft(first.id, 'Do not clear this draft');
    await runtime.client.request('set_work_state', { settled: false, background: true });
    await runtime.client.request('emit_event', { frame: { type: 'agent_start' } });
    await runtime.refreshState();
    const work = runtime.summary().workPeriods?.[0];
    assert.ok(work);
    await writeFile(join(f.root, 'provider-models.json'), JSON.stringify([{ provider: 'connected', id: 'later-model', name: 'Later model', input: ['text'] }]));
    await f.app.refreshProviderConnections();
    assert.deepEqual(runtime.summary().status, { kind: 'ready', activity: 'background' });
    assert.equal(runtime.summary().models.some(model => model.provider === 'connected'), false);
    assert.equal(runtime.client.ready, true);
    await runtime.client.request('settle');
    await waitUntil(() => f.cache.get(first.id)?.models.some(model => model.id === 'connected/later-model') === true);
    const restored = f.cache.get(first.id);
    assert.deepEqual(restored?.status, { kind: 'ready', activity: 'idle' });
    assert.equal(restored?.workPeriods?.[0]?.startedAt, work.startedAt);
    assert.equal(typeof restored?.workPeriods?.[0]?.endedAt, 'number');
    assert.equal(f.app.manifest.selectedThreadID, first.id);
    assert.equal(f.app.manifest.threads.find(thread => thread.id === first.id)?.draft, 'Do not clear this draft');
    assert.equal((await commands(f.root)).some(frame => ['prompt', 'abort', 'abort_and_prompt'].includes(String(frame.type))), false);
  } finally { await f.app.shutdown(); }
});

function queueContents(entries: readonly QueuedMessage[]): { text: string; imageCount: number }[] {
  for (const entry of entries) {
    if (entry.imageCount > 0) assert.ok(entry.imageRef);
    else assert.equal(entry.imageRef, null);
  }
  return entries.map(({ text, imageCount }) => ({ text, imageCount }));
}

function queuedImageRef(entry: QueuedMessage | undefined): string {
  assert.ok(entry?.imageRef);
  return entry.imageRef;
}

test('queued image lookup exposes only active canonical occurrences with their distinct images', () => {
  const queues = new QueueAttachments();
  const first: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const second: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
  const firstImages = [first], secondImages = [second];
  queues.submitted('first', 'followUp', 'same', firstImages);
  queues.submitted('second', 'followUp', 'same', secondImages);
  assert.throws(() => queues.getImages('first'), /Queued image preview has expired\./);
  const snapshot = queues.reconcile([], ['same', 'same']);
  assert.notEqual(snapshot.followUp[0]?.imageRef, snapshot.followUp[1]?.imageRef);
  assert.deepEqual(queues.getImages(queuedImageRef(snapshot.followUp[0])), firstImages);
  assert.deepEqual(queues.getImages(queuedImageRef(snapshot.followUp[1])), secondImages);
  queues.reconcile([], ['same']);
  assert.throws(() => queues.getImages('first'), /Queued image preview has expired\./);
  assert.deepEqual(queues.getImages('second'), secondImages);
  const promotion = queues.promote('same');
  const promoted = queues.reconcile(['same'], []);
  queues.finishPromotion(promotion);
  assert.equal(promoted.steering[0]?.imageRef, snapshot.followUp[1]?.imageRef);
  assert.deepEqual(queues.getImages('second'), secondImages);
});

test('promotion keeps the promoted picture when earlier same-text steers were consumed without a queue update', () => {
  const queues = new QueueAttachments();
  const consumed: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const retained: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
  const promoted: ImageContent = { type: 'image', mimeType: 'image/png', data: 'Ag==' };
  queues.submitted('consumed', 'steering', 'same', [consumed]);
  queues.submitted('retained', 'steering', 'same', [retained]);
  queues.submitted('promoted', 'followUp', 'same', [promoted]);
  const before = queues.reconcile(['same', 'same'], ['same']);
  const promotion = queues.promote('same');
  const after = queues.reconcile(['same', 'same'], []);
  queues.finishPromotion(promotion);
  assert.deepEqual(after.steering.map(entry => entry.imageRef), [before.steering[1]?.imageRef, before.followUp[0]?.imageRef]);
  assert.deepEqual(queues.getImages(queuedImageRef(after.steering[0])), [retained]);
  assert.deepEqual(queues.getImages(queuedImageRef(after.steering[1])), [promoted]);
  assert.throws(() => queues.getImages(queuedImageRef(before.steering[0])), /expired/);
});

for (const ending of ['clear', 'reject', 'reset', 'lost-continuity'] as const) test(`queued image ${ending} releases its reference without reassociating equal text`, () => {
  const queues = new QueueAttachments();
  const images: ImageContent[] = [{ type: 'image', mimeType: 'image/png', data: 'AA==' }];
  queues.submitted('old', 'followUp', 'same', images);
  queues.reconcile([], ['same']);
  if (ending === 'clear') queues.reconcile([], []);
  else if (ending === 'reject') queues.rejected('old');
  else if (ending === 'reset') queues.reset();
  else {
    queues.submitted('replacement', 'followUp', 'same', []);
    queues.admitted('replacement', 1);
    queues.reconcile([], ['same'], 1);
  }
  assert.throws(() => queues.getImages('old'), /Queued image preview has expired\./);
  const snapshot = queues.reconcile([], ['same']);
  assert.deepEqual(snapshot.followUp, [{ text: 'same', imageCount: 0, imageRef: null }]);
  queues.submitted('new', 'followUp', 'same', images);
  const appended = queues.reconcile([], ['same', 'same']);
  assert.equal(appended.followUp[0]?.imageRef, null);
  assert.equal(appended.followUp[1]?.imageRef, 'new');
  assert.deepEqual(queues.getImages('new'), images);
  assert.throws(() => queues.getImages('old'), /Queued image preview has expired\./);
});

test('same-count FIFO consumption publishes the surviving image reference to runtime summaries', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const first = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const second = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
  await r.sendPrompt('Working turn');
  await r.sendPrompt('same', { images: [first] });
  await r.sendPrompt('same', { images: [second] });
  const firstRef = queuedImageRef(r.summary().queuedFollowUps[0]);
  const secondRef = queuedImageRef(r.summary().queuedFollowUps[1]);
  assert.notEqual(firstRef, secondRef);
  assert.deepEqual(r.getQueuedImages(firstRef)[0], first);
  assert.deepEqual(r.getQueuedImages(secondRef)[0], second);
  await r.client.request('deliver_queued');
  assert.deepEqual(queueContents(r.summary().queuedFollowUps), [{ text: 'same', imageCount: 1 }]);
  assert.equal(r.summary().queuedFollowUps[0]?.imageRef, secondRef);
  assert.equal(f.cache.get(f.record.id)?.queuedFollowUps[0]?.imageRef, secondRef);
  assert.deepEqual(r.getQueuedImages(secondRef)[0], second);
  assert.throws(() => r.getQueuedImages(firstRef), /Queued image preview has expired\./);
  await r.client.request('set_queue_state', { followUp: [], events: [{ type: 'queue_update', steering: [], followUp: [] }] });
  assert.throws(() => r.getQueuedImages(secondRef), /Queued image preview has expired\./);
});

test('admitted images that never bind cannot attach to a later equal-text canonical entry', () => {
  const queues = new QueueAttachments();
  queues.submitted('missing', 'followUp', 'same', [{ type: 'image', mimeType: 'image/png', data: 'AA==' }]);
  queues.admitted('missing', 1);
  queues.reconcile([], [], 1);
  assert.throws(() => queues.getImages('missing'), /Queued image preview has expired\./);
  assert.deepEqual(queues.reconcile([], ['same']).followUp, [{ text: 'same', imageCount: 0, imageRef: null }]);
});

test('queued follow-ups and steers retain submitted image counts, including image-only Send now and canonical delivery', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  await r.sendPrompt('Working turn');
  await r.sendPrompt('Review these', { images: [image, image] });
  await r.sendPrompt('', { images: [image] });
  await r.sendPrompt('Steer with image', { steer: true, images: [image] });
  assert.deepEqual(queueContents(r.summary().queuedFollowUps), [{ text: 'Review these', imageCount: 2 }, { text: '', imageCount: 1 }]);
  assert.deepEqual(queueContents(r.summary().queuedSteers), [{ text: 'Steer with image', imageCount: 1 }]);
  const imageOnlyRef = queuedImageRef(r.summary().queuedFollowUps[1]);
  assert.deepEqual(r.getQueuedImages(imageOnlyRef)[0], image);
  assert.equal(JSON.stringify(r.summary()).includes(image.data), false);
  assert.equal(await r.promoteQueued(''), true);
  assert.deepEqual(queueContents(r.summary().queuedFollowUps), [{ text: 'Review these', imageCount: 2 }]);
  assert.deepEqual(queueContents(r.summary().queuedSteers), [{ text: 'Steer with image', imageCount: 1 }, { text: '', imageCount: 1 }]);
  assert.equal(r.summary().queuedSteers[1]?.imageRef, imageOnlyRef);
  assert.deepEqual(r.getQueuedImages(imageOnlyRef)[0], image);
  await r.client.request('deliver_queued', { queue: 'followUp', notify: false });
  await waitUntil(() => r.summary().queuedFollowUps.length === 0);
  assert.deepEqual(r.snapshot().messages.find(message => message.id === 'delivered-queue-1')?.images, [image, image]);
  await r.client.request('deliver_queued', { queue: 'steering' });
  assert.deepEqual(queueContents(r.summary().queuedSteers), [{ text: '', imageCount: 1 }]);
  await r.client.request('deliver_queued', { queue: 'steering' });
  await waitUntil(() => r.summary().queuedSteers.length === 0);
  assert.throws(() => r.getQueuedImages(imageOnlyRef), /Queued image preview has expired\./);
});

test('equal-text promotion follows the surviving occurrence after the first image message delivers', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const image = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const secondImage = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
  await r.sendPrompt('Working turn');
  await r.sendPrompt('same', { images: [image] });
  await r.sendPrompt('same', { images: [secondImage, secondImage] });
  const firstRef = queuedImageRef(r.summary().queuedFollowUps[0]);
  const secondRef = queuedImageRef(r.summary().queuedFollowUps[1]);
  assert.notEqual(firstRef, secondRef);
  assert.deepEqual(r.getQueuedImages(firstRef)[0], image);
  assert.deepEqual(r.getQueuedImages(secondRef)[0], secondImage);
  assert.deepEqual(r.summary().queuedFollowUps.map(entry => entry.imageCount), [1, 2]);
  await r.client.request('promote_after_delivery');
  assert.equal(await r.promoteQueued('same'), true);
  assert.deepEqual(r.summary().queuedFollowUps, []);
  assert.deepEqual(queueContents(r.summary().queuedSteers), [{ text: 'same', imageCount: 2 }]);
  assert.equal(r.summary().queuedSteers[0]?.imageRef, secondRef);
  assert.deepEqual(r.getQueuedImages(secondRef)[0], secondImage);
  assert.throws(() => r.getQueuedImages(firstRef), /Queued image preview has expired\./);
  await r.client.request('deliver_queued', { queue: 'steering' });
  assert.throws(() => r.getQueuedImages(secondRef), /Queued image preview has expired\./);
  await r.sendPrompt('same');
  assert.deepEqual(queueContents(r.summary().queuedFollowUps), [{ text: 'same', imageCount: 0 }]);
});

for (const outcome of ['failed', 'local', 'admitted'] as const) test(`late queued ${outcome} response cannot misattribute images to later equal text`, async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const image = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  await r.sendPrompt('Working turn');
  const request = r.client.request.bind(r.client);
  r.client.request = (type, fields = {}, options = {}) => request(type, fields, type === 'prompt' ? { ...options, timeout: 20 } : options);
  await r.client.request('hold_next_queue_admission');
  assert.equal(await r.sendPrompt('same', { images: [image, image] }), false);
  const heldID = (await commands(f.root)).filter(frame => frame.type === 'prompt').at(-1)?.id;
  assert.equal(typeof heldID, 'string');
  if (typeof heldID !== 'string') throw new Error('Missing held prompt ID.');
  assert.throws(() => r.getQueuedImages(heldID), /Queued image preview has expired\./);
  await r.client.request('release_queued_admission', { failed: outcome === 'failed', local: outcome === 'local' });
  if (outcome === 'admitted') {
    await waitUntil(() => r.summary().queuedFollowUps[0]?.imageCount === 2);
    assert.deepEqual(r.getQueuedImages(queuedImageRef(r.summary().queuedFollowUps[0]))[0], image);
    await r.client.request('deliver_queued', { queue: 'followUp' });
  }
  assert.throws(() => r.getQueuedImages(heldID), /Queued image preview has expired\./);
  await r.sendPrompt('same');
  await waitUntil(() => r.summary().queuedFollowUps.length === 1);
  assert.deepEqual(queueContents(r.summary().queuedFollowUps), [{ text: 'same', imageCount: 0 }]);
});

test('literal image marker text never invents an attachment and annotations do not leak between runtimes or reconnects', async t => {
  const a = await fixture(t, { history: 'empty', nativeQueues: true });
  const b = await fixture(t, { history: 'empty', nativeQueues: true });
  await Promise.all([a.runtime.connect(a.executable), b.runtime.connect(b.executable)]);
  const image = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  await Promise.all([a.runtime.sendPrompt('Working'), b.runtime.sendPrompt('Working')]);
  await a.runtime.sendPrompt('', { images: [image] });
  await b.runtime.sendPrompt('[Image]');
  assert.deepEqual(queueContents(a.runtime.summary().queuedFollowUps), [{ text: '', imageCount: 1 }]);
  assert.deepEqual(queueContents(b.runtime.summary().queuedFollowUps), [{ text: '[Image]', imageCount: 0 }]);
  const imageRef = queuedImageRef(a.runtime.summary().queuedFollowUps[0]);
  assert.deepEqual(a.runtime.getQueuedImages(imageRef)[0], image);
  assert.throws(() => b.runtime.getQueuedImages(imageRef), /Queued image preview has expired\./);
  await a.runtime.shutdown();
  assert.throws(() => a.runtime.getQueuedImages(imageRef), /Queued image preview has expired\./);
  await a.runtime.connect(a.executable);
  assert.throws(() => a.runtime.getQueuedImages(imageRef), /Queued image preview has expired\./);
  await a.runtime.client.request('set_queue_state', { followUp: ['[Image]'], events: [{ type: 'queue_update', steering: [], followUp: ['[Image]'] }] });
  assert.deepEqual(queueContents(a.runtime.summary().queuedFollowUps), [{ text: '[Image]', imageCount: 0 }]);
  assert.throws(() => a.runtime.getQueuedImages(imageRef), /Queued image preview has expired\./);
});

for (const queue of ['steering', 'followUp'] as const) for (const content of ['text', 'image', 'image-only'] as const) {
  test(`retracting ${queue} ${content} restores exact editor content without sending or changing other queued entries`, async t => {
    const f = await fixture(t, { history: 'empty', nativeQueues: true });
    const r = f.runtime;
    await r.connect(f.executable);
    const image: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
    const otherImage: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
    const message = content === 'image-only' ? '' : '  Edit this\nexactly  ';
    const images = content === 'text' ? [] : [image, image];
    const steer = queue === 'steering';
    await r.sendPrompt('Working turn');
    await r.sendPrompt('Before', { steer, images: [otherImage] });
    await r.sendPrompt(message, { steer, images });
    await r.sendPrompt('After', { steer, images: [otherImage] });
    await r.sendPrompt('Other queue', { steer: !steer, images: [otherImage] });
    const before = r.summary();
    const ownEntries = steer ? before.queuedSteers : before.queuedFollowUps;
    const target = ownEntries[1];
    assert.ok(target);
    const removed = await r.retractQueued(queue, message, target.imageRef);
    assert.deepEqual(removed, { text: message, images, imagesDropped: false });
    const after = r.summary();
    assert.deepEqual(steer ? after.queuedSteers : after.queuedFollowUps, [ownEntries[0], ownEntries[2]]);
    assert.deepEqual(steer ? after.queuedFollowUps : after.queuedSteers, steer ? before.queuedFollowUps : before.queuedSteers);
    const imageRef = target.imageRef;
    if (imageRef) assert.throws(() => r.getQueuedImages(imageRef), /expired/);
    for (const entry of [...after.queuedSteers, ...after.queuedFollowUps]) {
      assert.deepEqual(r.getQueuedImages(queuedImageRef(entry)), [otherImage]);
    }
    const logged = await commands(f.root);
    assert.deepEqual(logged.filter(frame => frame.type === 'remove_queued_message').map(frame => ({ queue: frame.queue, message: frame.message })), [{ queue, message }]);
    assert.equal(logged.filter(frame => frame.type === 'prompt').length, 5);
    assert.equal(r.snapshot().messages.some(entry => entry.text === message), false);
    assert.deepEqual(f.cache.get(f.record.id)?.queuedSteers, after.queuedSteers);
    assert.deepEqual(f.cache.get(f.record.id)?.queuedFollowUps, after.queuedFollowUps);
  });
}

for (const queue of ['steering', 'followUp'] as const) test(`ambiguous ${queue} image duplicates and stale references never remove another picture`, async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const first: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const second: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
  const steer = queue === 'steering';
  await r.sendPrompt('Working turn');
  await r.sendPrompt('same', { steer, images: [first] });
  await r.sendPrompt('same', { steer, images: [second] });
  const entries = steer ? r.summary().queuedSteers : r.summary().queuedFollowUps;
  const firstRef = queuedImageRef(entries[0]), secondRef = queuedImageRef(entries[1]);
  await assert.rejects(r.retractQueued(queue, 'same', firstRef), /cannot be retracted safely/);
  await assert.rejects(r.retractQueued(queue, 'same', secondRef), /cannot be retracted safely/);
  assert.equal(await r.retractQueued(queue, 'same', 'expired-reference'), null);
  assert.equal(await r.retractQueued(queue, 'same', null), null);
  assert.equal(await r.retractQueued(steer ? 'followUp' : 'steering', 'same', secondRef), null);
  assert.equal((await commands(f.root)).some(frame => frame.type === 'remove_queued_message'), false);
  assert.deepEqual(r.getQueuedImages(firstRef), [first]);
  assert.deepEqual(r.getQueuedImages(secondRef), [second]);
  await r.client.request('deliver_queued', { queue });
  assert.equal(await r.retractQueued(queue, 'same', firstRef), null);
  assert.deepEqual(await r.retractQueued(queue, 'same', secondRef), { text: 'same', images: [second], imagesDropped: false });
  assert.deepEqual(steer ? r.summary().queuedSteers : r.summary().queuedFollowUps, []);
  assert.deepEqual(r.snapshot().messages.find(entry => entry.id === 'delivered-queue-1')?.images, [first]);
  await r.client.request('finish_native_turn');
  await waitUntil(() => r.canRefreshProviderConnections);
});

test('mixed image and text duplicates reject even when the selected duplicate has no images', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  await r.sendPrompt('Working turn');
  await r.sendPrompt('same');
  await r.sendPrompt('same', { images: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] });
  await assert.rejects(r.retractQueued('followUp', 'same', null), /cannot be retracted safely/);
  assert.equal((await commands(f.root)).some(frame => frame.type === 'remove_queued_message'), false);
  assert.equal(r.summary().queuedFollowUps.length, 2);
});

test('text-only duplicates can retract one FIFO occurrence while literal image text stays text', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  await r.sendPrompt('Working turn');
  await r.sendPrompt('[Image]');
  await r.sendPrompt('[Image]');
  assert.deepEqual(await r.retractQueued('followUp', '[Image]', null), { text: '[Image]', images: [], imagesDropped: false });
  assert.deepEqual(queueContents(r.summary().queuedFollowUps), [{ text: '[Image]', imageCount: 0 }]);
  assert.deepEqual(await r.retractQueued('followUp', '[Image]', null), { text: '[Image]', images: [], imagesDropped: false });
  assert.equal(await r.retractQueued('followUp', '[Image]', null), null);
  await r.client.request('finish_native_turn');
  await waitUntil(() => r.canRefreshProviderConnections);
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'remove_queued_message').length, 2);
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'prompt').length, 3);
});

for (const queue of ['steering', 'followUp'] as const) test(`${queue} retraction distinguishes image-only raw text from a literal image chip`, async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const image: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const steer = queue === 'steering';
  await r.sendPrompt('Working turn');
  await r.sendPrompt('', { steer, images: [image] });
  await r.sendPrompt('[Image]', { steer });
  const imageRef = queuedImageRef((steer ? r.summary().queuedSteers : r.summary().queuedFollowUps)[0]);
  assert.deepEqual(await r.retractQueued(queue, '[Image]', null), { text: '[Image]', images: [], imagesDropped: false });
  assert.deepEqual(steer ? r.summary().queuedSteers : r.summary().queuedFollowUps, [{ text: '', imageCount: 1, imageRef }]);
  assert.deepEqual(r.getQueuedImages(imageRef), [image]);
  assert.deepEqual(await r.retractQueued(queue, '', imageRef), { text: '', images: [image], imagesDropped: false });
  assert.deepEqual(steer ? r.summary().queuedSteers : r.summary().queuedFollowUps, []);
  await r.client.request('finish_native_turn');
  await waitUntil(() => r.canRefreshProviderConnections);
  assert.deepEqual((await commands(f.root)).filter(frame => frame.type === 'remove_queued_message').map(frame => frame.message), ['[Image]', '']);
});

test('delivery immediately before native removal returns null without recovering images from history', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const image: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  await r.sendPrompt('Working turn');
  await r.sendPrompt('Already delivered', { images: [image] });
  await r.sendPrompt('Still queued', { steer: true, images: [image] });
  const imageRef = queuedImageRef(r.summary().queuedFollowUps[0]);
  const unrelated = r.summary().queuedSteers;
  await r.client.request('queue_removal_behavior', { deliverBefore: true });
  assert.equal(await r.retractQueued('followUp', 'Already delivered', imageRef), null);
  assert.deepEqual(r.summary().queuedFollowUps, []);
  assert.deepEqual(r.summary().queuedSteers, unrelated);
  assert.throws(() => r.getQueuedImages(imageRef), /expired/);
  assert.deepEqual(r.snapshot().messages.find(entry => entry.id === 'delivered-queue-1')?.images, [image]);
  assert.equal(await r.retractQueued('followUp', 'Already delivered', imageRef), null);
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'remove_queued_message').length, 1);
});

for (const mode of ['returned', 'omitted', 'dropped', 'native-returned', 'native-dropped'] as const) {
  test(`native ${mode} image response restores only authoritative or explicitly dropped tracked bytes`, async t => {
    const f = await fixture(t, { history: 'empty', nativeQueues: true });
    const r = f.runtime;
    await r.connect(f.executable);
    const tracked: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
    const actual: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
    const native = mode.startsWith('native-');
    await r.sendPrompt('Working turn');
    if (native) await r.client.request('prompt', { message: 'Edit', images: [actual], streamingBehavior: 'followUp' });
    else await r.sendPrompt('Edit', { images: [tracked] });
    const target = r.summary().queuedFollowUps[0];
    assert.ok(target);
    await r.client.request('queue_removal_behavior', { ...(mode === 'returned' ? { images: [actual] } : {}), omitImages: mode === 'omitted', dropImages: mode.endsWith('dropped') });
    assert.deepEqual(await r.retractQueued('followUp', 'Edit', target.imageRef), {
      text: 'Edit',
      images: mode === 'omitted' || mode === 'native-dropped' ? [] : mode === 'dropped' ? [tracked] : [actual],
      imagesDropped: mode === 'native-dropped',
    });
    assert.deepEqual(r.summary().queuedFollowUps, []);
    const imageRef = target.imageRef;
    if (imageRef) assert.throws(() => r.getQueuedImages(imageRef), /expired/);
    await r.client.request('finish_native_turn');
    await waitUntil(() => r.canRefreshProviderConnections);
  });
}

for (const result of [
  { removed: 'yes' },
  { removed: true, imagesDropped: 'yes' },
  { removed: true, images: {} },
  { removed: true, images: [{ type: 'image', mimeType: 'image/png', data: 'not base64' }] },
  { removed: true, images: Array.from({ length: 21 }, () => ({ type: 'image', mimeType: 'image/png', data: 'AA==' })) },
] satisfies JsonRecord[]) test(`malformed native removal ${JSON.stringify(result).slice(0, 80)} cannot restore external payload`, async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  await r.sendPrompt('Working turn');
  await r.sendPrompt('Edit', { images: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] });
  const imageRef = queuedImageRef(r.summary().queuedFollowUps[0]);
  await r.client.request('queue_removal_behavior', { result, notify: false });
  await assert.rejects(r.retractQueued('followUp', 'Edit', imageRef), /invalid/);
  assert.deepEqual(r.summary().queuedFollowUps, []);
  assert.throws(() => r.getQueuedImages(imageRef), /expired/);
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'prompt').length, 2);
});

test('a queue clear while native removal waits cannot replay its captured images', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  await r.sendPrompt('Working turn');
  await r.sendPrompt('Edit', { images: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] });
  const imageRef = queuedImageRef(r.summary().queuedFollowUps[0]);
  await r.client.request('queue_removal_behavior', { hold: true, dropImages: true });
  const removal = r.retractQueued('followUp', 'Edit', imageRef);
  await heldQueueRemoval(r.client);
  await r.client.request('clear_queued');
  assert.throws(() => r.getQueuedImages(imageRef), /expired/);
  await r.client.request('release_queue_removal');
  assert.equal(await removal, null);
  assert.deepEqual(r.summary().queuedFollowUps, []);
  await r.client.request('finish_native_turn');
  await waitUntil(() => r.canRefreshProviderConnections);
});

test('shutdown fences a removed payload and queued operations from the next runtime generation', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  await r.sendPrompt('Working turn');
  await r.sendPrompt('Edit', { images: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] });
  const imageRef = queuedImageRef(r.summary().queuedFollowUps[0]);
  await r.client.request('queue_removal_behavior', { holdResponse: true, dropImages: true });
  const removal = r.retractQueued('followUp', 'Edit', imageRef);
  await heldQueueRemoval(r.client);
  const stalePromotion = r.promoteQueued('Edit');
  await r.shutdown();
  assert.equal(await removal, null);
  assert.equal(await stalePromotion, false);
  await r.connect(f.executable);
  assert.deepEqual(r.summary().queuedFollowUps, []);
  assert.deepEqual(r.summary().queuedSteers, []);
  assert.throws(() => r.getQueuedImages(imageRef), /expired/);
  assert.equal((await commands(f.root)).filter(frame => frame.type === 'remove_queued_message').length, 1);
  assert.equal((await commands(f.root)).some(frame => frame.type === 'promote_queued_message'), false);
});

test('promotion and retraction share a serial queue and preserve the surviving image identity', async t => {
  const f = await fixture(t, { history: 'empty', nativeQueues: true });
  const r = f.runtime;
  await r.connect(f.executable);
  const image: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const other: ImageContent = { type: 'image', mimeType: 'image/png', data: 'AQ==' };
  await r.sendPrompt('Working turn');
  await r.sendPrompt('Withdraw', { images: [image] });
  await r.sendPrompt('Promote', { images: [other] });
  const withdrawRef = queuedImageRef(r.summary().queuedFollowUps[0]);
  const promoteRef = queuedImageRef(r.summary().queuedFollowUps[1]);
  await r.client.request('queue_removal_behavior', { hold: true, dropImages: true });
  const removal = r.retractQueued('followUp', 'Withdraw', withdrawRef);
  await heldQueueRemoval(r.client);
  const promotion = r.promoteQueued('Promote');
  const secondRemoval = r.retractQueued('followUp', 'Promote', promoteRef);
  await r.client.request('fixture_status');
  assert.equal((await commands(f.root)).some(frame => frame.type === 'promote_queued_message'), false);
  await r.client.request('release_queue_removal');
  assert.deepEqual(await removal, { text: 'Withdraw', images: [image], imagesDropped: false });
  assert.equal(await promotion, true);
  assert.equal(await secondRemoval, null);
  assert.deepEqual(r.summary().queuedFollowUps, []);
  assert.deepEqual(r.summary().queuedSteers, [{ text: 'Promote', imageCount: 1, imageRef: promoteRef }]);
  assert.deepEqual(r.getQueuedImages(promoteRef), [other]);
  assert.deepEqual(await r.retractQueued('steering', 'Promote', promoteRef), { text: 'Promote', images: [other], imagesDropped: false });
  await r.client.request('finish_native_turn');
  await waitUntil(() => r.canRefreshProviderConnections);
  const operations = (await commands(f.root)).filter(frame => frame.type === 'remove_queued_message' || frame.type === 'promote_queued_message');
  assert.deepEqual(operations.map(frame => ({ type: frame.type, message: frame.message })), [
    { type: 'remove_queued_message', message: 'Withdraw' },
    { type: 'promote_queued_message', message: 'Promote' },
    { type: 'remove_queued_message', message: 'Promote' },
  ]);
});

test('editing a duplicate sent prompt replaces only the selected continuation and preserves its native images', async t => {
  const f = await fixture(t, { editing: true, catalogImages: true });
  await f.runtime.connect(f.executable);
  const before = f.runtime.snapshot();
  assert.equal(before.messages[2]?.text, 'Repeated prompt');
  assert.equal(await f.runtime.editMessage('history-2', 'Edited second turn'), true);
  await waitUntil(() => f.runtime.summary().status.kind === 'ready' && !isBusy(f.runtime.summary().status) && f.runtime.snapshot().messages.some(message => message.text === 'Response to edited turn'));
  const after = f.runtime.snapshot();
  assert.deepEqual(after.messages.map(message => message.text), ['Repeated prompt', 'First answer', 'Edited second turn', 'Response to edited turn']);
  assert.deepEqual(after.messages[2]?.images, before.messages[2]?.images);
  assert.equal(f.runtime.record.ompSessionFile, join(f.root, 'edited.jsonl'));
  assert.equal(after.status.kind === 'ready' && after.status.activity, 'idle');
  const observed = new Map<string, RuntimeSnapshot>();
  for (const event of f.events) {
    reduceRuntime(observed, event);
    const visible = observed.get(f.record.id)?.messages.map(message => message.text) ?? [];
    assert.ok(!(visible.includes('Later answer to replace') && visible.includes('Edited second turn')), 'An edited turn was appended to stale pre-branch history before the replacement snapshot.');
  }
});

test('rejected edited prompt admission restores native history and retains the original rendered message identity', async t => {
  const f = await fixture(t, { editing: true, catalogImages: true });
  await f.runtime.connect(f.executable);
  const before = f.runtime.snapshot();
  const marker = f.events.length;
  await assert.rejects(f.runtime.editMessage('history-2', 'reject-edit'), /Input hook rejected/);
  assert.deepEqual(f.runtime.snapshot().messages, before.messages);
  assert.equal(f.runtime.record.ompSessionFile, join(f.root, 'original.jsonl'));
  const native = await f.runtime.client.request('get_state');
  assert.ok(isRecord(native)); assert.equal(native.sessionFile, join(f.root, 'original.jsonl'));
  assert.ok(!f.events.slice(marker).some(event => event.kind === 'snapshot' && event.runtime.messages.length < before.messages.length), 'Rejected admission exposed truncated history to the inline editor.');
  assert.equal(await f.runtime.editMessage('history-2', 'Retry with a new edit'), true);
  assert.equal(f.runtime.snapshot().messages[2]?.text, 'Retry with a new edit');
});

test('branch cancellation, queued work, stale targets and oversized edits never replace native history', async t => {
  const f = await fixture(t, { editing: true });
  await f.runtime.connect(f.executable);
  const before = f.runtime.snapshot().messages;
  await f.runtime.client.request('edit_behavior', { cancel: true });
  await assert.rejects(f.runtime.editMessage('history-2', 'Edited'), /cancelled/);
  assert.deepEqual(f.runtime.snapshot().messages, before);
  await f.runtime.client.request('edit_behavior', { cancel: false });
  await f.runtime.client.request('set_queue_state', { followUp: ['Queued work'] });
  await assert.rejects(f.runtime.editMessage('history-2', 'Edited'), /queued work/);
  await f.runtime.client.request('set_queue_state', { followUp: [] });
  await f.runtime.refreshState();
  await assert.rejects(f.runtime.editMessage('missing', 'Edited'), /no longer available/);
  await assert.rejects(f.runtime.editMessage('history-2', 'x'.repeat(1_048_576)), /input limit/);
  assert.deepEqual(f.runtime.snapshot().messages, before);
  assert.equal(await f.runtime.editMessage('history-0', 'Edit the first turn'), true);
  await waitUntil(() => !isBusy(f.runtime.summary().status) && f.runtime.snapshot().messages.some(message => message.text === 'Response to edited turn'));
  assert.deepEqual(f.runtime.snapshot().messages.map(message => message.text), ['Edit the first turn', 'Response to edited turn']);
});

test('sent-message edits keep an unrelated composer draft and persist the selected native session file', async t => {
  const f = await applicationFixture(t, 'pages', { selected: true, editing: true });
  try {
    const first = f.threads[0]; assert.ok(first);
    const runtime = await f.app.runtimeFor(first.id);
    await waitUntil(() => runtime.canRefreshProviderConnections);
    f.app.setDraft(first.id, 'Keep this separate composer draft');
    assert.equal(await f.app.editMessage(first.id, 'history-2', 'Revised question'), true);
    const thread = f.app.manifest.threads.find(thread => thread.id === first.id); assert.ok(thread);
    assert.equal(thread.draft, 'Keep this separate composer draft');
    assert.equal(thread.ompSessionFile, join(f.root, 'edited.jsonl'));
    await f.app.shutdown();
    const saved = (await f.persistence.load()).threads.find(thread => thread.id === first.id);
    assert.equal(saved?.ompSessionFile, join(f.root, 'edited.jsonl'));
    assert.equal(saved?.draft, 'Keep this separate composer draft');
  } finally { await f.app.shutdown(); }
});

test('work starting during history lookup prevents editing from branching away from active work', async t => {
  const f = await fixture(t, { editing: true });
  await f.runtime.connect(f.executable);
  const before = f.runtime.snapshot().messages;
  await f.runtime.client.request('edit_behavior', { startWork: true });
  await assert.rejects(f.runtime.editMessage('history-2', 'Unsafe edit'), /current and queued work/);
  assert.deepEqual(f.runtime.snapshot().messages, before);
  const native = await f.runtime.client.request('get_state'); assert.ok(isRecord(native));
  assert.equal(native.sessionFile, join(f.root, 'original.jsonl'));
  assert.ok(!(await commands(f.root)).some(frame => frame.type === 'branch'));
});

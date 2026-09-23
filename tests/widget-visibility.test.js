import test from 'node:test';
import assert from 'node:assert/strict';
import {registerWidgetVisibility} from '../extension/widget-visibility.js';

function fixture() {
  const memory={},listeners=[];let removed;
  const api={runtime:{id:'framekeep-test',getURL:p=>'chrome-extension://framekeep-test/'+p,onMessage:{addListener:f=>listeners.push(f)}},
    storage:{session:{get:async k=>({[k]:memory[k]}),set:async v=>Object.assign(memory,v),remove:async k=>{delete memory[k];}}},
    tabs:{onRemoved:{addListener:f=>removed=f}}};
  registerWidgetVisibility(api);
  const call=(action,sender={id:api.runtime.id,tab:{id:7},frameId:0},fields={})=>new Promise(resolve=>listeners[0]({target:'framekeep-widget-state',action,...fields},sender,resolve));
  return {call,api,memory,removed};
}
test('hidden state survives another document/worker view, stays per tab, and clears on tab close',async()=>{
  const f=fixture();assert.equal((await f.call('hide')).hidden,true);assert.equal((await f.call('get')).hidden,true);
  assert.equal((await f.call('get',{id:f.api.runtime.id,tab:{id:8},frameId:0})).hidden,false);
  f.removed(7);assert.equal((await f.call('get')).hidden,false);
});
test('toolbar restore preserves other tabs and rejects website/iframe senders',async()=>{
  const f=fixture();await f.call('hide');
  assert.equal((await f.call('restore',{id:'wrong',tab:{id:7},frameId:0})).ok,false);
  assert.equal((await f.call('restore',{id:f.api.runtime.id,tab:{id:7},frameId:1})).ok,false);
  assert.equal((await f.call('get')).hidden,true);
  assert.equal((await f.call('restore',{id:f.api.runtime.id,url:f.api.runtime.getURL('popup.html')},{tabId:7})).hidden,false);
});

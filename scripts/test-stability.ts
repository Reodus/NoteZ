import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { blockMove } from '../src/editor/blockMove.ts';
import { commentField } from '../src/editor/commentRanges.ts';
import { moveInTree, removeFromTree } from '../src/core/bookmarkTree.ts';
import { createWriteQueue } from '../src/core/writeQueue.ts';
import { startResize } from '../src/ui/resize.ts';

const c = { id:'c', from:{line:1,ch:0}, to:{line:1,ch:3}, quote:'AAA', body:'Review', created:'',updated:'',resolved:false,replies:[] };
const field=commentField(()=>[c]);
const view={ state:EditorState.create({doc:'AAA\n\nBBB\n\nCCC', selection:{anchor:1,head:2}, extensions:[history(),field]}), dispatch:(spec:any)=>{ view.state=spec.state??view.state.update(spec).state; } };
view.dispatch(blockMove(view.state,{from:0,to:3},false,8,false)!);
assert.equal(view.state.doc.toString(),'BBB\n\nAAA\n\nCCC');
assert.equal(view.state.selection.main.anchor,6);assert.equal(view.state.selection.main.head,7);
assert.equal(view.state.field(field)[0].from.line,3);assert.ok(!view.state.field(field)[0].orphaned);
assert.ok(undo(view));assert.equal(view.state.doc.toString(),'AAA\n\nBBB\n\nCCC');assert.equal(view.state.field(field)[0].from.line,1);
assert.ok(redo(view));assert.equal(view.state.field(field)[0].from.line,3);
view.dispatch({changes:{from:5,to:8},annotations:isolateHistory.of('full')});
assert.ok(view.state.field(field)[0].orphaned);assert.ok(undo(view));assert.ok(!view.state.field(field)[0].orphaned);assert.equal(view.state.field(field)[0].quote,'AAA');
for(const [from,to,at,before,want] of [[10,13,0,true,'CCC\n\nAAA\n\nBBB'],[5,8,13,false,'AAA\n\nCCC\n\nBBB']] as const){
 const state=EditorState.create({doc:'AAA\n\nBBB\n\nCCC'});const tr=state.update(blockMove(state,{from,to},false,at,before)!);assert.equal(tr.newDoc.toString(),want);
}
assert.equal(blockMove(view.state,{from:5,to:8},false,6,true),null);
const leaf={type:'file' as const,path:'A.md'}, nested={type:'group' as const,title:'same',items:[leaf]}, outer={type:'group' as const,title:'same',items:[nested]}, other={type:'group' as const,title:'same',items:[]};
assert.deepEqual(removeFromTree([outer],nested),[{...outer,items:[]}]);
assert.equal(moveInTree([outer],outer,nested,true)[0],outer);
const moved=moveInTree([outer,other],leaf,other,true);assert.equal(moved[1].items![0],leaf);assert.equal(moved[0].items![0].items!.length,0);
// Pending writes must execute in order; failed data can be retried by a barrier.
let release!:()=>void;const gate=new Promise<void>(r=>release=r);const writes:string[]=[];
const queue=createWriteQueue(async(_p,text)=>{if(text==='old')await gate;writes.push(text);});
const old=queue.write('A','old'), latest=queue.write('A','new');await Promise.resolve();assert.deepEqual(writes,[]);release();await Promise.all([old,latest]);assert.deepEqual(writes,['old','new']);
let fails=true;const retry=createWriteQueue(async()=>{if(fails)throw Error('disk full');});
await assert.rejects(retry.write('A','keep me'));await assert.rejects(retry.flush());fails=false;await retry.flush();
// Pointer release before requestAnimationFrame must still commit the final width.
for(const dir of ['ltr','rtl']){
 const handlers=new Map<string,Function>();let raf:Function|null=null,width=0,captured=false;
 const events={addEventListener:(n:string,f:Function)=>handlers.set(n,f),removeEventListener:(n:string)=>handlers.delete(n)};
 const classList={add(){},remove(){}};
 Object.assign(globalThis,{getComputedStyle:()=>({direction:dir}),requestAnimationFrame:(f:Function)=>(raf=f,1),cancelAnimationFrame:()=>raf=null,document:{body:{classList}},window:events});
 const handle={...events,classList,setPointerCapture(){captured=true;},hasPointerCapture(){return captured;},releasePointerCapture(){captured=false;}};
 startResize({button:0,preventDefault(){},currentTarget:handle,clientX:100,pointerId:1} as any,{getBoundingClientRect:()=>({width:300})} as any,1,w=>width=w);
 handlers.get('lostpointercapture')!({pointerId:1,buttons:1});
 handlers.get('pointermove')!({clientX:130,pointerId:1});handlers.get('pointerup')!({clientX:130,pointerId:1});assert.equal(width,dir==='ltr'?330:270);assert.equal(captured,false);assert.equal(handlers.size,0);assert.equal(raf,null);
}
console.log('Stability: block moves + comment undo/redo, nested bookmarks, write ordering/retry and fast resize passed');

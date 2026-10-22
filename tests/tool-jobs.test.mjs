import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({entryPoints:['src/service/toolJobs.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {ToolPublicationQueue} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
test('overlapping same-source processes publish once with replace then append, later runs replace', async () => {
  const queue = new ToolPublicationQueue();
  const first = queue.begin('board#source'), second = queue.begin('board#source');
  const calls=[];
  let release;
  const waiting = new Promise(resolve => {release=resolve;});
  const a=first.publish(async replace => {calls.push(['a',replace]); await waiting; calls.push(['a finished']);});
  const b=second.publish(async replace => {calls.push(['b',replace]);});
  await Promise.resolve();
  assert.deepEqual(calls,[['a',true]]);
  release(); await Promise.all([a,b]);
  assert.deepEqual(calls,[['a',true],['a finished'],['b',false]]);
  first.finish(); first.finish(); second.finish();
  const later = queue.begin('board#source');
  await later.publish(async replace => assert.equal(replace,true)); later.finish();
});
test('publication failure leaves queue usable and another source independent', async () => {
  const queue = new ToolPublicationQueue();
  const bad=queue.begin('board#source'), good=queue.begin('board#source'), other=queue.begin('board#other');
  await assert.rejects(bad.publish(async () => {throw new Error('source gone');}),/source gone/);
  await good.publish(async replace => assert.equal(replace,true));
  await other.publish(async replace => assert.equal(replace,true));
  bad.finish();good.finish();other.finish();
});

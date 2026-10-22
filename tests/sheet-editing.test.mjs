import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync('excel-modded/main.js','utf8');
const method = source.match(/  setViewData\(data, clear\) \{([\s\S]*?)\n  \}\n/)[1];
const setViewData = vm.runInNewContext(`(function(data, clear) {${method}})`);
test('a sheet save acknowledgement preserves the active editor; external data refreshes it', () => {
  let refreshed = 0;
  const editor = {selectionStart: 4, composing: true};
  const view = {data:'saved',sheet:editor,app:{workspace:{onLayoutReady:fn=>fn()}},refresh(){refreshed++;}};
  setViewData.call(view,'saved',false);
  assert.equal(refreshed,0); assert.equal(view.sheet,editor);
  setViewData.call(view,'external',false);
  assert.equal(refreshed,1); assert.equal(view.data,'external');
  setViewData.call(view,'external',true);
  assert.equal(refreshed,2);
});

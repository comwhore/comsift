import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: ['src/analysis/connectionIdentity.ts'], bundle:true, platform:'node', format:'esm', write:false });
const { exactProfileMatch } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
test('missing fields do not prevent scoped exact account matches', () => {
 assert.equal(exactProfileMatch({username:'@Alice',platform:'roblox',display_name:'Alice'}, {username:'alice',platform:'roblox'}),true);
 assert.equal(exactProfileMatch({username:'alice',platform:'roblox',user_id:'1'}, {username:'alice',platform:'roblox',user_id:'2'}),false);
 assert.equal(exactProfileMatch({username:'alice',platform:'roblox'}, {username:'alice',platform:'instagram'}),false);
});
test('common names, generic URLs and malformed profile labels cannot merge strangers', () => {
 assert.equal(exactProfileMatch({display_name:'Sam'}, {display_name:'Sam'}),false);
 for (const profile_url of ['https://roblox.com/','https://roblox.com/users','unknown']) assert.equal(exactProfileMatch({profile_url}, {profile_url}),false);
 assert.equal(exactProfileMatch({profile_url:'https://www.roblox.com/users/11/profile/'}, {profile_url:'https://roblox.com/users/11/profile'}),true);
});

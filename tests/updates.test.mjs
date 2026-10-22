import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['src/service/updates.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { newerVersion, releaseVersion } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
test('release comparison handles numeric versions, tag prefixes and prereleases', () => {
  assert.equal(newerVersion('1.9.0', 'v1.10.0'), true);
  assert.equal(newerVersion('1.10.0', '1.9.9'), false);
  assert.equal(newerVersion('1.1.2', '1.1.2'), false);
  assert.equal(newerVersion('1.1.2-beta.1', '1.1.2'), true);
  assert.equal(newerVersion('1.1.2', '1.2.0-beta.1'), false);
  assert.equal(newerVersion('broken', '1.2.0'), false);
});
test('only stable releases with valid tags produce update notifications', () => {
  assert.equal(releaseVersion({ tag_name: 'v2.0.0' }), '2.0.0');
  for (const release of [null, {}, { tag_name: 'latest' }, { tag_name: 'v2.0.0', draft: true }, { tag_name: 'v2.0.0', prerelease: true }]) assert.equal(releaseVersion(release), null);
});

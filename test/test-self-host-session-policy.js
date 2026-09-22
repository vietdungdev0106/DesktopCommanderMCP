import assert from 'node:assert/strict';
import {
  isSessionEvictable,
  isSessionIdle,
} from '../dist/self-host/session-policy.js';

const now = 10_000;
const idleMs = 1_000;

const idle = {
  closing: false,
  activeRequests: 0,
  openStreams: 0,
  lastActivityAt: 8_000,
};
assert.equal(isSessionEvictable(idle), true);
assert.equal(isSessionIdle(idle, now, idleMs), true);

const liveSse = {
  ...idle,
  openStreams: 1,
};
assert.equal(isSessionEvictable(liveSse), false);
assert.equal(isSessionIdle(liveSse, now, idleMs), false);

const busy = {
  ...idle,
  activeRequests: 1,
};
assert.equal(isSessionEvictable(busy), false);
assert.equal(isSessionIdle(busy, now, idleMs), false);

const closing = {
  ...idle,
  closing: true,
};
assert.equal(isSessionEvictable(closing), false);
assert.equal(isSessionIdle(closing, now, idleMs), false);

const recentlyActive = {
  ...idle,
  lastActivityAt: 9_500,
};
assert.equal(isSessionEvictable(recentlyActive), true);
assert.equal(isSessionIdle(recentlyActive, now, idleMs), false);

console.log('PASS self-host session policy');

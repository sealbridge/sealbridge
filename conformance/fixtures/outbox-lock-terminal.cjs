// Observe the real CLI's exclusive lock attempt, adapting no storage behavior.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.openSync;
let reported = false;
fs.openSync = function (path, ...args) {
  try {
    return original.call(this, path, ...args);
  } catch (error) {
    if (!reported && String(path).endsWith('.lock') && error.code === 'EEXIST') {
      reported = true;
      process.stderr.write('TEST_OUTBOX_LOCK_WAIT\n');
    }
    throw error;
  }
};
syncBuiltinESMExports();

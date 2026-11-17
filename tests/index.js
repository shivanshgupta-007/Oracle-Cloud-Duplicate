// Entry point so 'node --test tests/' works on Node versions that do not expand directories.
// Loads every *.test.js in this folder (one per module).
const fs = require('fs');
const path = require('path');
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) require(path.join(__dirname, f));

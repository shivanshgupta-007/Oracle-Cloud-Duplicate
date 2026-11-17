/* Node loader for tests and scripts: loads the engine, every extension module in the same
 * order as index.html, then the seed. Usage: const { E, seed } = require('../js/load-node.js'); */
const E = require('./engine.js');
const EXTENSIONS = require('./extensions.json');
for (const f of EXTENSIONS) require('./' + f);
const seed = require('./seed.js');
module.exports = { E, seed, EXTENSIONS };

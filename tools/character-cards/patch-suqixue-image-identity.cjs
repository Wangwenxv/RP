// Deprecated command: clear the old provider-specific profile instead of adding it.
const path = require('node:path');
const { attach } = require('./attach-image-references.cjs');
const patch = file => attach(file);
if (require.main === module) console.log(JSON.stringify(patch(path.resolve(process.argv[2] || path.join(__dirname, '../../card/suqixue/苏祈雪v2.json')))));
module.exports = { patch };

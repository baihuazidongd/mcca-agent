const fs = require(`node:fs`);
const src = process.env.USERPROFILE + `/.pi/agent/models.json`;
const m = JSON.parse(fs.readFileSync(src).toString());
fs.writeFileSync(`D:/dshpi/config/.pi-models-dump.json`, JSON.stringify(m, null, 1));
console.log(`dumped`);

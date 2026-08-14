// CI / release guard: dsh's JSON.parse crashes on a UTF-8 BOM in package.json.
// Run: node scripts/check-no-bom.js
import { readFile } from 'node:fs/promises';

const bytes = await readFile(new URL('../package.json', import.meta.url));
if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    console.error('package.json has a UTF-8 BOM; dsh JSON.parse crashes on install — rewrite it without BOM.');
    process.exit(1);
}
console.log('no BOM, JSON OK:', JSON.parse(bytes.toString('utf8')).name);

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
console.log('CWD:', process.cwd());
console.log('__dirname:', __dirname);
console.log('resolve ../../facebook.js:', resolve(__dirname, '../../facebook.js'));
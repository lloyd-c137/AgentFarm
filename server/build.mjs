// copy the farm page and the setup page into public/, which wrangler serves as static assets
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('public', { recursive: true });
copyFileSync('../index.html', 'public/index.html');
copyFileSync('setup.html', 'public/setup.html');
console.log('public/ ready');

// Renders macos/icon.svg to a 1024×1024 transparent PNG (used to build the .icns).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const svg = fs.readFileSync(path.join(import.meta.dirname, 'icon.svg'), 'utf8');
const out = process.argv[2] ?? 'icon-1024.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
await page.screenshot({ path: out, omitBackground: true });
await browser.close();

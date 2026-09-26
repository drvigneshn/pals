// Renders icon.svg to icon-192.png and icon-512.png with the pre-installed Chromium.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'icon.svg'), 'utf8');
  const b = await chromium.launch();
  for (const n of [192, 512]) {
    const p = await b.newPage({ viewport: { width: n, height: n } });
    await p.setContent(`<style>html,body{margin:0;background:#0b1016}</style>${svg.replace('<svg ', `<svg width="${n}" height="${n}" `)}`);
    await p.screenshot({ path: path.join(__dirname, '..', `icon-${n}.png`) });
  }
  await b.close();
})();

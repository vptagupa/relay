// One-off: rasterize assets/icon.svg → icon.png (512), then icon.ico + icon.icns.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const png2icons = require('png2icons');

const dir = path.join(__dirname, '..', 'assets');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'));
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng();
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, 'icon.ico'), png2icons.createICO(png, png2icons.BICUBIC, 0, false));
fs.writeFileSync(path.join(dir, 'icon.icns'), png2icons.createICNS(png, png2icons.BICUBIC, 0));
console.log('icons written:', fs.readdirSync(dir).join(', '));

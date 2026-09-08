/* Converts stock_car_01 into a self-contained glTF 2.0 asset with hit-damage blend shapes. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const code = String(process.argv[2] || '01').padStart(2, '0');
if (!/^\d{2}$/.test(code) || !fs.existsSync(path.join(root, 'stock_car_pack', `stock_car_${code}.obj`))) throw new Error('Pass a valid stock-car code, e.g. 01 through 10.');
const source = path.join(root, 'stock_car_pack', `stock_car_${code}.obj`);
const outDir = path.join(root, 'web_stock_car_pack');
fs.mkdirSync(outDir, { recursive: true });

const materialDefs = {
  paint: [0.067, 0.404, 0.769, 1], accent: [0.965, 0.969, 0.953, 1], number: [0.949, 0.718, 0.02, 1],
  glass: [0.045, 0.095, 0.125, .62], tire: [.025, .025, .028, 1], wheel: [.20, .22, .24, 1],
  grille: [.015, .017, .02, 1], light: [.9, .93, .95, 1], brake: [.7, .22, .12, 1]
};
// Preserve every original paint scheme from its OBJ companion material file.
const mtlText = fs.readFileSync(path.join(root, 'stock_car_pack', `stock_car_${code}.mtl`), 'utf8');
let parsedMaterial = '';
for (const line of mtlText.split(/\r?\n/)) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'newmtl') parsedMaterial = p[1];
  if (p[0] === 'Kd' && materialDefs[parsedMaterial]) materialDefs[parsedMaterial] = [+p[1], +p[2], +p[3], materialDefs[parsedMaterial][3]];
  if (p[0] === 'd' && materialDefs[parsedMaterial]) materialDefs[parsedMaterial][3] = +p[1];
}
const sourceLines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
const positions = [];
const groups = new Map();
let active = 'paint';
for (const line of sourceLines) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
  else if (p[0] === 'usemtl') active = p[1];
  else if (p[0] === 'f') {
    if (!groups.has(active)) groups.set(active, []);
    groups.get(active).push(p.slice(1).map(x => +x.split('/')[0] - 1));
  }
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
function damageDeltas([x, y, z]) {
  // Values are relative vertex offsets in metres.  They are deliberately smooth,
  // so engines can interpolate 0..1 damage cleanly instead of snapping a panel.
  const front = smooth((z - 1.10) / 1.55) * smooth((1.20 - y) / .90);
  const rear = smooth((-z - 1.10) / 1.55) * smooth((1.15 - y) / .85);
  const middle = smooth((1.70 - Math.abs(z)) / .65) * smooth((1.25 - y) / .85);
  const left = x < -.45 ? smooth((-x - .45) / .72) * middle : 0;
  const right = x > .45 ? smooth((x - .45) / .72) * middle : 0;
  return [
    [x * front * .07, -front * .10, -front * (.18 + .34 * smooth((z - 1.1) / 1.55))],
    [left * .36, -left * .05, z * left * -.045],
    [-right * .36, -right * .05, z * right * -.045],
    [x * rear * .06, -rear * .07, rear * (.15 + .31 * smooth((-z - 1.1) / 1.55))]
  ];
}

const chunks = [], views = [], accessors = [];
let offset = 0;
function add(bytes, target) {
  const pad = (4 - offset % 4) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  const view = views.length; chunks.push(bytes); views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) }); offset += bytes.length; return view;
}
function floatAccessor(values, kind, minmax = false) {
  const data = new Float32Array(values); const count = data.length / 3; const acc = { bufferView: add(Buffer.from(data.buffer), 34962), componentType: 5126, count, type: kind };
  if (minmax) { const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity]; for(let i=0;i<data.length;i+=3) for(let j=0;j<3;j++){min[j]=Math.min(min[j],data[i+j]);max[j]=Math.max(max[j],data[i+j]);} acc.min=min;acc.max=max; }
  accessors.push(acc); return accessors.length - 1;
}
function indexAccessor(values) { const data = new Uint16Array(values); accessors.push({ bufferView:add(Buffer.from(data.buffer),34963), componentType:5123, count:data.length, type:'SCALAR' }); return accessors.length-1; }

const materialNames = Object.keys(materialDefs);
const gltfMaterials = materialNames.map(name => ({ name, pbrMetallicRoughness: { baseColorFactor: materialDefs[name], metallicFactor: name === 'wheel' ? .75 : .12, roughnessFactor: name === 'glass' ? .12 : .52 }, ...(name === 'glass' ? { alphaMode:'BLEND', doubleSided:true } : {}) }));
const primitives = [];
for (const [name, faces] of groups) {
  const pos=[], front=[], left=[], right=[], rear=[], ind=[];
  for (const face of faces) for (const idx of face) { const p=positions[idx]; const d=damageDeltas(p); const n=pos.length/3; pos.push(...p); front.push(...d[0]); left.push(...d[1]); right.push(...d[2]); rear.push(...d[3]); ind.push(n); }
  primitives.push({ attributes:{ POSITION:floatAccessor(pos,'VEC3',true) }, indices:indexAccessor(ind), material:materialNames.indexOf(name), mode:4, targets:[{POSITION:floatAccessor(front,'VEC3')},{POSITION:floatAccessor(left,'VEC3')},{POSITION:floatAccessor(right,'VEC3')},{POSITION:floatAccessor(rear,'VEC3')}] });
}
const binary = Buffer.concat(chunks);
const gltf = {
  asset:{version:'2.0',generator:'Original Stock Car Damage Asset Builder'},
  scene:0, scenes:[{nodes:[0]}], nodes:[{name:`WebStockCar_${code}`,mesh:0}],
  meshes:[{name:`WebStockCar_${code}`,weights:[0,0,0,0],primitives,extras:{targetNames:['FrontImpact','LeftSideImpact','RightSideImpact','RearImpact']}}],
  materials:gltfMaterials, buffers:[{byteLength:binary.length,uri:'data:application/octet-stream;base64,'+binary.toString('base64')}], bufferViews:views, accessors
};
fs.writeFileSync(path.join(outDir,`web_stock_car_${code}.gltf`), JSON.stringify(gltf));
fs.writeFileSync(path.join(outDir,`web_stock_car_${code}.damage.json`), JSON.stringify({
  asset:`web_stock_car_${code}.gltf`, unit:'metres', forwardAxis:'+Z',
  blendShapes:{FrontImpact:{index:0,collisionZone:'front bumper / hood'},LeftSideImpact:{index:1,collisionZone:'driver-side doors'},RightSideImpact:{index:2,collisionZone:'passenger-side doors'},RearImpact:{index:3,collisionZone:'rear bumper / spoiler'}},
  usage:'Set the matching morph-target/blend-shape weight from 0.0 (undamaged) to 1.0 (full damage) after a collision. Keep weights below 0.7 for ordinary impacts; combine side and front/rear weights for corner hits.'
}, null, 2));
console.log(`Created web_stock_car_${code}.gltf: ${binary.length} bytes binary data, ${primitives.length} material primitives.`);

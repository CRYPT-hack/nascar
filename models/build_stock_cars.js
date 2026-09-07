/* Creates ten original, low-poly stock-car OBJ assets and MTL materials. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stock_car_pack');
fs.mkdirSync(output, { recursive: true });

const schemes = [
  ['01', 'Apex Blue', '#1167c4', '#f6f7f3', '#f2b705'],
  ['02', 'Solar Yellow', '#f5bd13', '#202a66', '#f4f4f1'],
  ['03', 'Crimson Flash', '#b92f3d', '#191919', '#f4f4f1'],
  ['04', 'Volt Green', '#53a630', '#171b22', '#f6f7f3'],
  ['05', 'Canyon Orange', '#e66b20', '#202a66', '#f6f7f3'],
  ['06', 'Purple Shift', '#633f95', '#32b6ca', '#f6f7f3'],
  ['07', 'Night Teal', '#006777', '#f5c513', '#f4f4f1'],
  ['08', 'Ruby Black', '#1b1c20', '#c4313c', '#f2eee4'],
  ['09', 'Skyline Cyan', '#119bc2', '#f3f1e8', '#1c3447'],
  ['10', 'Silver Bolt', '#858c95', '#202c48', '#ed582d'],
];

function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
function mtl(name, base, accent, number) {
  const c = (v) => hex(v).map(n => n.toFixed(4)).join(' ');
  return `# ${name} — original stock-car material set\nnewmtl paint\nKd ${c(base)}\nKs 0.2500 0.2500 0.2500\nNs 90\n\nnewmtl accent\nKd ${c(accent)}\nKs 0.1800 0.1800 0.1800\nNs 65\n\nnewmtl number\nKd ${c(number)}\nKs 0.1200 0.1200 0.1200\nNs 35\n\nnewmtl glass\nKd 0.0450 0.0950 0.1250\nKs 0.7000 0.7000 0.7000\nNs 180\nd 0.62\n\nnewmtl tire\nKd 0.0250 0.0250 0.0280\nKs 0.0800 0.0800 0.0800\nNs 18\n\nnewmtl wheel\nKd 0.2000 0.2200 0.2400\nKs 0.6500 0.6500 0.6500\nNs 120\n\nnewmtl grille\nKd 0.0150 0.0170 0.0200\nKs 0.2000 0.2000 0.2000\nNs 35\n\nnewmtl light\nKd 0.9000 0.9300 0.9500\nKs 0.9000 0.9000 0.9000\nNs 200\n\nnewmtl brake\nKd 0.7000 0.2200 0.1200\nKs 0.4500 0.4500 0.4500\nNs 80\n`;
}

function makeCar(code, name, base, accent, number) {
  let v = [], f = [], use = [], g = [];
  const V = (x,y,z) => (v.push([x,y,z]), v.length);
  const tri = (a,b,c,mat) => { f.push([a,b,c]); use.push(mat); };
  const quad = (a,b,c,d,mat) => { tri(a,b,c,mat); tri(a,c,d,mat); };
  const box = (x0,x1,y0,y1,z0,z1,mat, group='detail') => {
    const p=[V(x0,y0,z0),V(x1,y0,z0),V(x1,y1,z0),V(x0,y1,z0),V(x0,y0,z1),V(x1,y0,z1),V(x1,y1,z1),V(x0,y1,z1)];
    quad(p[0],p[3],p[2],p[1],mat); quad(p[4],p[5],p[6],p[7],mat); quad(p[0],p[1],p[5],p[4],mat); quad(p[1],p[2],p[6],p[5],mat); quad(p[2],p[3],p[7],p[6],mat); quad(p[3],p[0],p[4],p[7],mat);
  };
  const prism = (sections, mat) => {
    const rings = sections.map(([z,lo,hi,wlo,whi]) => [V(-wlo,lo,z),V(wlo,lo,z),V(wlo,hi,z),V(-wlo,hi,z),V(-whi,hi,z),V(whi,hi,z)]);
    for(let k=0;k<rings.length-1;k++) { const a=rings[k], b=rings[k+1]; quad(a[0],a[1],b[1],b[0],mat); quad(a[1],a[2],b[2],b[1],mat); quad(a[2],a[5],b[5],b[2],mat); quad(a[5],a[4],b[4],b[5],mat); quad(a[4],a[3],b[3],b[4],mat); quad(a[3],a[0],b[0],b[3],mat); }
    const a=rings[0], b=rings.at(-1); quad(a[0],a[3],a[4],a[5],mat); quad(a[0],a[5],a[2],a[1],mat); quad(b[0],b[1],b[2],b[5],mat); quad(b[0],b[5],b[4],b[3],mat);
  };
  const cylX = (cx,cy,cz,r,len,mat,segments=12) => {
    const l=[], rr=[]; for(let i=0;i<segments;i++){ const a=2*Math.PI*i/segments; l.push(V(cx-len/2,cy+Math.sin(a)*r,cz+Math.cos(a)*r)); rr.push(V(cx+len/2,cy+Math.sin(a)*r,cz+Math.cos(a)*r)); }
    for(let i=0;i<segments;i++){const j=(i+1)%segments;quad(l[i],l[j],rr[j],rr[i],mat);} const cl=V(cx-len/2,cy,cz), cr=V(cx+len/2,cy,cz); for(let i=0;i<segments;i++){let j=(i+1)%segments;tri(cl,l[j],l[i],mat);tri(cr,rr[i],rr[j],mat);}
  };
  const plate = (x0,x1,y,z0,z1,mat) => box(x0,x1,y,y+0.012,z0,z1,mat);
  // Outer body is deliberately generic: a modern oval-track stock car, not a branded make/model.
  prism([[-2.48,.30,.70,.78,.84],[-2.18,.27,.90,.89,.93],[-1.20,.24,1.00,.96,.96],[.72,.24,1.02,.96,.90],[1.75,.23,.90,.91,.76],[2.35,.25,.73,.80,.67],[2.55,.31,.59,.65,.55]], 'paint');
  // Raised cabin / roof shell.
  prism([[-1.03,.91,1.08,.75,.75],[-.68,.98,1.36,.73,.69],[.50,.99,1.38,.71,.68],[.91,.90,1.08,.72,.72]], 'paint');
  // Windscreen, rear screen, side windows (slightly raised panels).
  box(-.665,.665,1.085,1.095,.50,.89,'glass'); box(-.68,.68,1.09,1.10,-1.02,-.68,'glass');
  for(const s of [-1,1]) { box(s*.755,s*.768,.98,1.30,-.64,.53,'glass'); box(s*.77,s*.785,.94,1.08,.54,.89,'glass'); }
  // windshield braces / roll-cage hint.
  for(const x of [-.38,0,.38]) box(x-.018,x+.018,1.075,1.11,.48,.91,'number');
  // Front aero, grille, lamps and rear spoiler.
  box(-.59,.59,.43,.66,2.54,2.575,'grille'); box(-.99,.99,.18,.29,2.47,2.66,'grille');
  box(-.97,-.68,.59,.73,2.49,2.57,'light'); box(.68,.97,.59,.73,2.49,2.57,'light');
  box(-1.12,1.12,.16,.22,2.30,2.68,'accent');
  box(-.96,.96,1.05,1.14,-2.58,-2.48,'accent'); box(-.96,.96,.86,.91,-2.55,-2.45,'paint');
  // Side skirts and a simple accent stripe.
  for(const s of [-1,1]) { box(s*.985,s*1.025,.25,.42,-2.12,2.04,'grille'); box(s*.997,s*1.012,.48,.68,-2.10,1.80,'accent'); }
  // Bold hood stripe and roof accent.
  box(-.18,.18,.925,.945,.92,2.30,'accent'); box(-.16,.16,1.385,1.40,-.61,.49,'accent');
  // Tires, wheels and brake hubs.
  for(const z of [-1.57,1.57]) for(const x of [-1.02,1.02]) { cylX(x,.47,z,.40,.25,'tire'); cylX(x + (x<0 ? -.131:.131),.47,z,.255,.018,'wheel'); cylX(x + (x<0 ? -.142:.142),.47,z,.12,.022,'brake',10); }
  // Door number panels plus roof-number made from seven-segment strips.
  for(const s of [-1,1]) plate(s*.99,s*1.018,.72,-.61,.40,'number');
  const digits = {'0':'abcdef','1':'bc','2':'abged','3':'abgcd','4':'fgbc','5':'afgcd','6':'afgecd','7':'abc','8':'abcdefg','9':'abfgcd'};
  const seg = {a:[.04,.38,.46,.53],b:[.39,.47,.08,.44],c:[.39,.47,-.40,-.04],d:[.04,.38,-.49,-.42],e:[-.47,-.39,-.40,-.04],f:[-.47,-.39,.08,.44],g:[-.42,.42,-.04,.03]};
  function digit(ch, ox, side) { for(const k of digits[ch]) { const q=seg[k]; const z0=ox+q[0]/1.8,z1=ox+q[1]/1.8,y0=.72+q[2]/2,y1=.72+q[3]/2; box(side*1.019,side*1.035,y0,y1,z0,z1,'paint'); } }
  const chars = String(parseInt(code,10)); const offset=chars.length===1?0:-.17; for(const s of [-1,1]) [...chars].forEach((ch,i)=>digit(ch,offset+i*.34,s));
  // Roof number: same readable digit motif in contrasting inlay blocks.
  function roofDigit(ch, ox) { for(const k of digits[ch]) { const q=seg[k]; box(ox+q[0]/2,ox+q[1]/2,1.402,1.414,q[2]/1.8,q[3]/1.8,'number'); } }
  const ro=chars.length===1?-.13:-.28; [...chars].forEach((ch,i)=>roofDigit(ch,ro+i*.28));
  // Exhaust and tow points.
  box(-1.04,-.99,.38,.46,-1.04,-.35,'wheel'); box(.99,1.04,.38,.46,-1.04,-.35,'wheel');
  const lines=['# Original game asset — generated locally', `# ${name} / race number ${code}`, 'mtllib '+`stock_car_${code}.mtl`, 'o '+`StockCar_${code}`];
  for(const p of v) lines.push(`v ${p[0].toFixed(5)} ${p[1].toFixed(5)} ${p[2].toFixed(5)}`);
  let current=''; for(let i=0;i<f.length;i++) { if(use[i]!==current){current=use[i];lines.push('usemtl '+current);} lines.push('f '+f[i].join(' ')); }
  fs.writeFileSync(path.join(output,`stock_car_${code}.obj`),lines.join('\n')+'\n');
  fs.writeFileSync(path.join(output,`stock_car_${code}.mtl`),mtl(name,base,accent,number));
}

for(const [code,name,base,accent,number] of schemes) makeCar(code,name,base,accent,number);
fs.writeFileSync(path.join(output,'README.md'), `# Original Stock Car Asset Pack\n\nTen original, low-poly oval-track stock-car models in Wavefront OBJ format. They are inspired by the *category* and proportions in the supplied references, but do not recreate any real driver, team, sponsor, manufacturer body, logo, or livery.\n\n## Contents\n\n- \`stock_car_01.obj\` through \`stock_car_10.obj\` — individual game assets\n- matching \`.mtl\` files — paint, glass, wheel and trim materials\n\nEach model uses metres (approximately 5.1 m long × 2.05 m wide) and faces forward on +Z. Import each OBJ with its matching MTL in the same directory. The meshes are clean, separate assets, with baked-in low-poly visual detail; add colliders, LODs, physics, and UV texture atlases in your engine or DCC tool as appropriate.\n\nLicense: CC0-style dedication by this project author; you may use, alter, and ship these assets in games.\n`);
console.log(`Created ${schemes.length} stock-car models in ${output}`);

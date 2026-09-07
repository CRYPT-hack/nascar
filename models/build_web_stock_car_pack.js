/* Builds the complete, browser-ready pack and its engine-neutral documentation. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'web_stock_car_pack');
fs.mkdirSync(output, { recursive:true });
for (let i=1; i<=10; i++) execFileSync(process.execPath, [path.join(root, 'build_deformable_car.js'), String(i).padStart(2,'0')], {stdio:'inherit'});
const cars = Array.from({length:10}, (_,i) => ({
  id:`stock_car_${String(i+1).padStart(2,'0')}`,
  model:`web_stock_car_${String(i+1).padStart(2,'0')}.gltf`,
  damage:`web_stock_car_${String(i+1).padStart(2,'0')}.damage.json`,
  morphTargets:['FrontImpact','LeftSideImpact','RightSideImpact','RearImpact']
}));
fs.writeFileSync(path.join(output,'manifest.json'), JSON.stringify({format:'glTF 2.0', unit:'metres', cars}, null, 2));
fs.writeFileSync(path.join(output,'README.md'), `# Web Stock Car Pack\n\nThis pack contains **10 original, game-styled oval-racing cars** for self-hosted browser games. They capture the chunky, approachable arcade-racing feel shown in the reference, but contain no Roblox, Pummu Talladega, NASCAR, manufacturer, team, or sponsor assets.\n\n## Files\n\n- \`web_stock_car_01.gltf\` through \`web_stock_car_10.gltf\`: self-contained glTF 2.0 assets with embedded geometry and materials\n- matching \`.damage.json\` files: collision-zone to deformation-target mapping\n- \`manifest.json\`: all assets in a single load list\n\n## Damage\n\nEvery car has four blend shapes: \`FrontImpact\`, \`LeftSideImpact\`, \`RightSideImpact\`, and \`RearImpact\`. Set a shape's weight from 0 to 1 after a collision. The deformation targets are visual; your game should retain separate physics/collider shapes.\n\n## Web engine use\n\nglTF 2.0 is supported by Three.js, Babylon.js, PlayCanvas, Godot web exports, and many custom WebGL/WebGPU pipelines. Serve these files over HTTP(S), not by opening them directly from the filesystem. Place the asset URL in your engine's glTF loader, then set the mesh's morph target influence matching the hit direction. In Three.js, \`mesh.morphTargetDictionary.FrontImpact\` gives the target index and \`mesh.morphTargetInfluences[index] = 0.65\` applies visible front damage.\n\nLicense: original game assets created for this project; free to modify and ship as part of your self-hosted game.\n`);
console.log(`Built ${cars.length} browser-ready stock cars.`);

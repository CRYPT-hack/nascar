# Web Stock Car Pack

This pack contains **10 original, game-styled oval-racing cars** for self-hosted browser games. They capture the chunky, approachable arcade-racing feel shown in the reference, but contain no Roblox, Pummu Talladega, NASCAR, manufacturer, team, or sponsor assets.

## Files

- `web_stock_car_01.gltf` through `web_stock_car_10.gltf`: self-contained glTF 2.0 assets with embedded geometry and materials
- matching `.damage.json` files: collision-zone to deformation-target mapping
- `manifest.json`: all assets in a single load list

## Damage

Every car has four blend shapes: `FrontImpact`, `LeftSideImpact`, `RightSideImpact`, and `RearImpact`. Set a shape's weight from 0 to 1 after a collision. The deformation targets are visual; your game should retain separate physics/collider shapes.

## Web engine use

glTF 2.0 is supported by Three.js, Babylon.js, PlayCanvas, Godot web exports, and many custom WebGL/WebGPU pipelines. Serve these files over HTTP(S), not by opening them directly from the filesystem. Place the asset URL in your engine's glTF loader, then set the mesh's morph target influence matching the hit direction. In Three.js, `mesh.morphTargetDictionary.FrontImpact` gives the target index and `mesh.morphTargetInfluences[index] = 0.65` applies visible front damage.

License: original game assets created for this project; free to modify and ship as part of your self-hosted game.

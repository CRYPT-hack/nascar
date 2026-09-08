# Deformable Stock Car

`deformable_stock_car_01.gltf` is a self-contained glTF 2.0 mesh with four named morph targets (also called blend shapes):

- `FrontImpact` — crumples the front fascia and hood
- `LeftSideImpact` — dents the left door and side skirt
- `RightSideImpact` — dents the right door and side skirt
- `RearImpact` — crumples the rear fascia

Use the target index or name from `damage_zones.json` in your engine. Apply a 0–1 weight based on collision impulse. The deformation is visual; add separate colliders and physics handling in the game engine. The glTF embeds all materials and geometry, so it is one portable file.

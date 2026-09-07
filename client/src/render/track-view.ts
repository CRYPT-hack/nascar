/**
 * TrackMeshes -> three.js scene graph.
 *
 * The geometry itself comes from track/src/mesh.ts, which the server also
 * calls to build its Rapier colliders. This module only wraps those typed
 * arrays in BufferGeometry and hangs materials on them, so there is no second
 * definition of the track's shape that could drift from the one being
 * simulated (DECISION-LOG, "Track meshes are procedural, not GLB").
 */

import * as THREE from 'three';

import type { TrackData } from '../../../shared/track-schema';
import { buildTrackMeshes, type MeshData, type TrackMeshes } from '../../../track/src/mesh';
import { createSurfaceMaterials, disposeSurfaceMaterials, type SurfaceMaterials } from './materials';
import { createTrackside } from './trackside';

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

export interface TrackView {
  /** Add this to the scene. */
  root: THREE.Group;
  /** The generated meshes, so the caller can reuse the section plan. */
  meshes: TrackMeshes;
  dispose(): void;
}

export function createTrackView(track: TrackData): TrackView {
  const meshes = buildTrackMeshes(track);
  const materials: SurfaceMaterials = createSurfaceMaterials();
  const root = new THREE.Group();
  root.name = `track:${track.name}`;

  const geometries: THREE.BufferGeometry[] = [];

  const add = (data: MeshData, key: keyof SurfaceMaterials, name: string, receiveShadow: boolean): void => {
    if (data.indices.length === 0) return; // a circuit with no tight corners has no gravel
    const geo = toGeometry(data);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, materials[key]);
    mesh.name = name;
    mesh.receiveShadow = receiveShadow;
    // The track never moves; skipping the per-frame matrix update is free.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
  };

  add(meshes.visual.grass, 'grass', 'grass', true);
  add(meshes.visual.gravel, 'gravel', 'gravel', true);
  add(meshes.visual.asphalt, 'asphalt', 'asphalt', true);
  add(meshes.visual.kerb, 'kerb', 'kerb', true);
  add(meshes.visual.startLine, 'startLine', 'startLine', true);
  // Barriers cast but do not receive: they are thin walls, and self-shadowing
  // on a one-sided wall produces acne for no visual gain.
  add(meshes.visual.barrier, 'barrier', 'barrier', false);
  for (const child of root.children) {
    if (child.name === 'barrier') (child as THREE.Mesh).castShadow = true;
  }

  // Decorative only. Never collides — collision comes from meshes.collision,
  // which excludes all of this by construction (HANDOFF.md §5.3).
  root.add(createTrackside(track, meshes.section));

  return {
    root,
    meshes,
    dispose(): void {
      for (const g of geometries) g.dispose();
      disposeSurfaceMaterials(materials);
      root.clear();
    },
  };
}

/**
 * Ground plane well below the circuit, so the world does not end in skybox at
 * the horizon when the camera looks out past the barriers.
 *
 * Sized from the track's own bounding box rather than a fixed number, because
 * the oval and Interlagos differ by a factor of two in extent.
 */
export function createGroundPlane(track: TrackData): THREE.Mesh {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  for (const w of track.waypoints) {
    minX = Math.min(minX, w.p[0]);
    maxX = Math.max(maxX, w.p[0]);
    minZ = Math.min(minZ, w.p[2]);
    maxZ = Math.max(maxZ, w.p[2]);
    minY = Math.min(minY, w.p[1]);
  }
  const span = Math.max(maxX - minX, maxZ - minZ) * 4;

  const geo = new THREE.PlaneGeometry(span, span);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x36592c, roughness: 1 }));
  mesh.position.set((minX + maxX) / 2, minY - 1.2, (minZ + maxZ) / 2);
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/**
 * Grid box outlines at the spawn slots. Used by the lobby and grid phases so
 * players can see where they will start; hidden once racing begins.
 */
export function createGridMarkers(track: TrackData): THREE.Group {
  const group = new THREE.Group();
  group.name = 'gridMarkers';
  const mat = new THREE.LineBasicMaterial({ color: 0xffd60a, transparent: true, opacity: 0.85 });

  for (const slot of track.spawnGrid) {
    const half = 1.4;
    const long = 2.6;
    const pts = [
      new THREE.Vector3(-half, 0, -long),
      new THREE.Vector3(half, 0, -long),
      new THREE.Vector3(half, 0, long),
      new THREE.Vector3(-half, 0, long),
      new THREE.Vector3(-half, 0, -long),
    ];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    line.position.set(slot.p[0], slot.p[1] - 0.18, slot.p[2]);
    line.rotation.y = slot.rotY;
    group.add(line);
  }
  return group;
}

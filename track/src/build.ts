/**
 * Track build CLI.  `npm run track:build`
 *
 * Writes public/track/<name>.json for every circuit in circuits.ts, plus a
 * plan-view SVG next to it. The SVG is the review artefact: a track that reads
 * wrong on paper will read wrong at 250 km/h, and it is far cheaper to look at
 * an SVG than to boot the game.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TrackData } from '../../shared/track-schema';
import { CIRCUITS } from './circuits';
import { generateTrack, type Diagnostics } from './generate';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../public/track');

function planSvg(t: TrackData, corners: [string, number][]): string {
  const n = t.waypoints.length;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const w of t.waypoints) {
    minX = Math.min(minX, w.p[0]);
    maxX = Math.max(maxX, w.p[0]);
    minZ = Math.min(minZ, w.p[2]);
    maxZ = Math.max(maxZ, w.p[2]);
  }
  const pad = 40;
  const w = maxX - minX + pad * 2;
  const h = maxZ - minZ + pad * 2;
  const X = (x: number) => (x - minX + pad).toFixed(1);
  const Z = (z: number) => (z - minZ + pad).toFixed(1);

  // Track edges, so the SVG shows real width rather than a hairline.
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = t.waypoints[i]!;
    const b = t.waypoints[(i + 1) % n]!;
    const fx = b.p[0] - a.p[0];
    const fz = b.p[2] - a.p[2];
    const fl = Math.hypot(fx, fz) || 1;
    const rx = -fz / fl;
    const rz = fx / fl;
    const hw = a.width / 2;
    left.push(`${X(a.p[0] - rx * hw)},${Z(a.p[2] - rz * hw)}`);
    right.push(`${X(a.p[0] + rx * hw)},${Z(a.p[2] + rz * hw)}`);
  }

  const centre = t.waypoints.map((p) => `${X(p.p[0])},${Z(p.p[2])}`).join(' ');

  const cps = t.checkpoints
    .map((c) => {
      const a = t.waypoints[c.idx]!;
      const b = t.waypoints[(c.idx + 1) % n]!;
      const fx = b.p[0] - a.p[0];
      const fz = b.p[2] - a.p[2];
      const fl = Math.hypot(fx, fz) || 1;
      const rx = (-fz / fl) * (a.width / 2);
      const rz = (fx / fl) * (a.width / 2);
      const col = c.isStartFinish ? '#fff' : '#7a8';
      const sw = c.isStartFinish ? 3 : 1.2;
      return `<line x1="${X(a.p[0] - rx)}" y1="${Z(a.p[2] - rz)}" x2="${X(a.p[0] + rx)}" y2="${Z(a.p[2] + rz)}" stroke="${col}" stroke-width="${sw}"/>`;
    })
    .join('\n    ');

  const grid = t.spawnGrid
    .map((s, i) => {
      return `<circle cx="${X(s.p[0])}" cy="${Z(s.p[2])}" r="2.2" fill="#ffd60a"/><text x="${X(s.p[0] + 4)}" y="${Z(s.p[2] + 2)}" font-size="7" fill="#ffd60a">${i + 1}</text>`;
    })
    .join('\n    ');

  // Elevation shown as a colour ramp on the centreline.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of t.waypoints) {
    minY = Math.min(minY, p.p[1]);
    maxY = Math.max(maxY, p.p[1]);
  }
  const elev = t.waypoints
    .filter((_, i) => i % 4 === 0)
    .map((p) => {
      const u = (p.p[1] - minY) / Math.max(1e-6, maxY - minY);
      const r = Math.round(40 + u * 215);
      const g = Math.round(90 + u * 60);
      const bl = Math.round(200 - u * 160);
      return `<circle cx="${X(p.p[0])}" cy="${Z(p.p[2])}" r="1.6" fill="rgb(${r},${g},${bl})"/>`;
    })
    .join('');

  const labels = corners
    .map(([name, f]) => {
      const i = Math.round(f * n) % n;
      const p = t.waypoints[i]!;
      return `<circle cx="${X(p.p[0])}" cy="${Z(p.p[2])}" r="2.4" fill="#ff9f0a"/><text x="${X(p.p[0] + 12)}" y="${Z(p.p[2] + 4)}" font-size="13" fill="#cfd8dc" font-family="system-ui,sans-serif">${name}</text>`;
    })
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" width="${Math.min(1400, w).toFixed(0)}">
  <rect width="100%" height="100%" fill="#11151a"/>
  <polygon points="${left.join(' ')}" fill="#2a2f36" stroke="none"/>
  <polygon points="${right.join(' ')}" fill="#11151a" stroke="none"/>
  <polyline points="${left.join(' ')}" fill="none" stroke="#5b6672" stroke-width="1"/>
  <polyline points="${right.join(' ')}" fill="none" stroke="#5b6672" stroke-width="1"/>
  <polyline points="${centre}" fill="none" stroke="#3d4855" stroke-width="0.6" stroke-dasharray="6 6"/>
  ${elev}
    ${cps}
    ${grid}
    ${labels}
  <text x="${pad}" y="${(h - 14).toFixed(0)}" font-size="14" fill="#8fa" font-family="system-ui,sans-serif">${t.name} - ${t.lapLengthMeters} m - scale ${t.scale} - ${n} waypoints</text>
</svg>
`;
}

function report(name: string, d: Diagnostics): void {
  const gradPct = (d.maxGradient * 100).toFixed(1);
  console.log(`  ${name}`);
  console.log(`    lap length      ${d.lapLength} m`);
  console.log(`    waypoints       spacing ~3 m`);
  console.log(`    min width       ${d.minWidth} m`);
  console.log(`    min radius      ${d.minRadius} m`);
  console.log(`    max gradient    ${gradPct}%`);
  console.log(`    elevation       ${d.elevationRange[0]} .. ${d.elevationRange[1]} m`);
  console.log(`    self-crossings  ${d.selfIntersections}`);
  console.log(`    min clearance   ${d.minClearance} m`);
  console.log(`    corners         ${d.corners.map(([nm, u]) => `${nm}@${u.toFixed(2)}`).join(', ')}`);

  const problems: string[] = [];
  if (d.selfIntersections > 0) problems.push(`${d.selfIntersections} self-intersections`);
  if (d.minClearance < 30) problems.push(`clearance ${d.minClearance} m is tight for a ${d.minWidth} m track`);
  if (d.maxGradient > 0.14) problems.push(`gradient ${gradPct}% is too steep to drive`);
  if (problems.length) {
    console.log(`    PROBLEMS: ${problems.join('; ')}`);
  }
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  console.log('building tracks ->', outDir);

  let failed = false;
  for (const [key, spec] of Object.entries(CIRCUITS)) {
    const { track, diagnostics } = generateTrack(spec);
    writeFileSync(resolve(outDir, `${key}.json`), JSON.stringify(track));
    writeFileSync(resolve(outDir, `${key}.svg`), planSvg(track, diagnostics.corners));
    report(key, diagnostics);
    if (diagnostics.selfIntersections > 0) failed = true;
  }

  if (failed) {
    console.error('\nA track crosses itself. Fix the control points before shipping it.');
    process.exitCode = 1;
  }
}

main();

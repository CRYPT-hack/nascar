/**
 * Circuit definitions.
 *
 * A circuit is authored as a closed loop of 2D control points at real-world
 * scale. Elevation, width and corner names are keyed on *control point index*
 * rather than lap fraction: an index stays attached to the piece of geometry it
 * describes when the layout is edited, whereas a lap fraction silently slides
 * onto a different corner the moment a straight changes length.
 *
 * generate.ts splines the control points, resamples them at fixed spacing, and
 * converts control indices to lap fractions using the arc length of the spline.
 * Closure is guaranteed because the control polygon is closed - there is no
 * loop-closure error to solve.
 *
 * The frame here is arbitrary: X east, Z south. generate.ts rigidly transforms
 * the finished loop so the start/finish waypoint sits at the origin with its
 * forward tangent along -Z, as HANDOFF.md 5.1 requires.
 */

import type { P2 } from './spline';

/** [control point index, value] */
export type ControlKey = readonly [number, number];
export type ControlLabel = readonly [number, string];

export interface CircuitSpec {
  name: string;
  /** Fraction of the real circuit the finished track is built at. */
  scale: number;
  /** Closed control polygon, real-world metres. */
  control: P2[];
  /** Authored position of the start/finish line; the nearest waypoint wins. */
  startNear: P2;
  /** Height above datum at the given control points, metres. Scaled with the track. */
  elevation: ControlKey[];
  /** Full track width at the given control points, metres. Not scaled - cars are not. */
  width: ControlKey[];
  /** Centreline spacing of the emitted waypoints, metres. */
  spacing: number;
  /** Number of checkpoints, evenly spaced around the lap. */
  checkpointCount: number;
  /** Corner names for the HUD and for build-time diagnostics. */
  corners: ControlLabel[];
}

/**
 * Autodromo Jose Carlos Pace, Interlagos. Anticlockwise.
 *
 * Not a survey - a playable interpretation that keeps the features the circuit
 * is recognised by: the long pit straight, the downhill Senna S, Curva do Sol
 * opening onto Reta Oposta, the winding infield, Juncao at the low point, and
 * the long uphill Subida dos Boxes back to the line.
 *
 * Control point indices are called out in the comments because elevation,
 * width and corner labels below all reference them.
 */
export const INTERLAGOS: CircuitSpec = {
  name: 'interlagos',
  scale: 0.65,
  spacing: 3,
  checkpointCount: 14,
  startNear: [-14, -288],
  control: [
    // 0-3  Reta Principal: the pit straight, heading north up the east side
    [0, 0],
    [-14, -288],
    [-34, -564],
    [-58, -744],

    // 4-7  Senna S: hard left then right, steeply downhill
    [-110, -854],
    [-206, -926],
    [-319, -950],
    [-422, -917],

    // 8-10  Curva do Sol: the long left that opens onto the back straight
    [-516, -842],
    [-578, -734],
    [-612, -612],

    // 11-14  Reta Oposta: back straight, heading south down the west side
    [-636, -427],
    [-658, -235],
    [-677, -43],
    [-691, 139],

    // 15-19  Descida do Lago, then the run east across the south of the circuit
    [-696, 262],
    [-674, 362],
    [-622, 442],
    [-545, 497],
    [-456, 533],

    // 20-23  Ferradura: the long left horseshoe that turns the car north
    [-372, 566],
    [-307, 550],
    [-271, 492],
    [-259, 422],

    // 24-25  the outbound leg north, on the west side of the infield spur
    [-252, 346],
    [-242, 271],

    // 26-29  Laranja into Pinheirinho: the hairpin at the top of the spur
    [-228, 206],
    [-190, 168],
    [-137, 175],
    [-108, 228],

    // 30-31  the return leg south, on the east side of the spur
    [-101, 300],
    [-106, 374],

    // 32-34  Bico de Pato and Mergulho: left, turning east, dropping
    [-125, 439],
    [-79, 470],
    [-19, 478],

    // 35-36  Juncao: tight left at the lowest point, turning north
    [41, 461],
    [67, 413],

    // 37-39  Subida dos Boxes: the long climb, running east of the pit straight
    [74, 336],
    [79, 240],
    [74, 156],

    // 40-41  Arquibancadas: the long left that feeds the pit straight
    [53, 84],
    [24, 29],
  ],
  elevation: [
    [0, 40], // Arquibancadas exit onto the straight - high ground
    [2, 43], // crest partway up the pit straight
    [3, 41],
    [4, 34], // turn-in for the Senna S
    [6, 22], // through the S, dropping hard
    [8, 17], // Curva do Sol
    [10, 15],
    [12, 11], // Reta Oposta running downhill
    [14, 6],
    [16, 2], // Descida do Lago
    [19, 6],
    [21, 10], // Ferradura
    [24, 14],
    [27, 19], // Pinheirinho, the high point of the infield
    [30, 14],
    [32, 8], // Bico de Pato, dropping again
    [34, 2],
    [36, 0], // Juncao - lowest point on the circuit
    [38, 14], // Subida dos Boxes climbing
    [40, 30], // Arquibancadas
  ],
  width: [
    [0, 16], // pit straight - wide, the grid forms here
    [3, 16],
    [4, 15], // Senna S kept generous so overtakes there survive contact
    [7, 14],
    [10, 14], // Curva do Sol
    [12, 15], // Reta Oposta
    [15, 14],
    [20, 13], // Ferradura
    [26, 12.5],
    [27, 12.5], // Pinheirinho hairpin - narrowest point
    [31, 13],
    [35, 13.5], // Juncao
    [38, 15], // Subida dos Boxes
    [41, 16],
  ],
  corners: [
    [5, 'Senna S'],
    [9, 'Curva do Sol'],
    [16, 'Descida do Lago'],
    [21, 'Ferradura'],
    [26, 'Laranja'],
    [28, 'Pinheirinho'],
    [32, 'Bico de Pato'],
    [34, 'Mergulho'],
    [36, 'Juncao'],
    [40, 'Arquibancadas'],
  ],
};

/**
 * Placeholder oval - HANDOFF.md 6. Exists so the simulation half of the build
 * is never blocked waiting on Interlagos. Same schema, throwaway shape.
 */
export const OVAL: CircuitSpec = {
  name: 'oval',
  scale: 1,
  spacing: 3,
  checkpointCount: 12,
  startNear: [0, 260],
  control: [
    [0, 260],
    [140, 250],
    [230, 190],
    [260, 90],
    [260, -90],
    [230, -190],
    [140, -250],
    [0, -260],
    [-140, -250],
    [-230, -190],
    [-260, -90],
    [-260, 90],
    [-230, 190],
    [-140, 250],
  ],
  elevation: [
    [0, 0],
    [3, 4],
    [7, 0],
    [10, 4],
  ],
  width: [[0, 16]],
  corners: [
    [3, 'Turn 1'],
    [10, 'Turn 3'],
  ],
};

export const CIRCUITS: Record<string, CircuitSpec> = {
  interlagos: INTERLAGOS,
  oval: OVAL,
};

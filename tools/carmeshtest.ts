/**
 * Car geometry checks.  `npx tsx tools/carmeshtest.ts`
 *
 * The car mesh is built rather than authored in a modelling tool, so the things
 * that go wrong with it are arithmetic, and arithmetic is checkable. Two of the
 * bugs these cover were real:
 *
 *   - every part mirrored with `box(s * a, s * b, ...)` arrived with its extents
 *     reversed for the left-hand side, which turns a `BoxGeometry` inside out.
 *     The left lamps, sills and door panels rendered as dark slivers.
 *   - the supplied glTF pack shipped no normals at all, and a lit material with
 *     no normals renders pure black.
 *
 * Inside-out geometry is the nasty one: it is invisible in a screenshot until
 * the light happens to catch it from the wrong side. A closed mesh wound
 * outward has positive signed volume, so that is the test.
 */

import * as THREE from 'three';

import { CAR, CAR_COLORS } from '../shared/constants';
import { buildCarModel, WHEEL_REST_Y } from '../client/src/render/car-mesh';

let checks = 0;
let failures = 0;

function check(what: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}${detail ? `   ${detail}` : ''}`);
  }
}

function near(what: string, actual: number, expected: number, tol: number): void {
  check(
    what,
    Math.abs(actual - expected) <= tol,
    `${actual.toFixed(4)} vs ${expected.toFixed(4)} (±${tol})`,
  );
}

/**
 * Six times the signed volume of a triangle soup. Positive when the faces are
 * wound outward; an inside-out mesh gives the same magnitude, negated.
 */
function signedVolume6(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  let sum = 0;
  for (let i = 0; i < p.count; i += 3) {
    const ax = p.getX(i);
    const ay = p.getY(i);
    const az = p.getZ(i);
    const bx = p.getX(i + 1);
    const by = p.getY(i + 1);
    const bz = p.getZ(i + 1);
    const cx = p.getX(i + 2);
    const cy = p.getY(i + 2);
    const cz = p.getZ(i + 2);
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum;
}

function bounds(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!.clone();
}

const GROUND = WHEEL_REST_Y - CAR.wheelRadius;

console.log('the car is built to the size of the car that collides');
{
  const model = buildCarModel(0);
  const b = bounds(model.body);

  check(
    'the body is no wider than the collider',
    b.max.x <= CAR.width / 2 + 1e-3 && b.min.x >= -CAR.width / 2 - 1e-3,
    `x ${b.min.x.toFixed(3)}..${b.max.x.toFixed(3)} against ±${(CAR.width / 2).toFixed(3)}`,
  );
  // Lamps and the splitter stand a couple of centimetres proud on purpose.
  check(
    'and no longer than it, bar the bumpers',
    b.max.z <= CAR.length / 2 + 0.06 && b.min.z >= -CAR.length / 2 - 0.06,
    `z ${b.min.z.toFixed(3)}..${b.max.z.toFixed(3)}`,
  );
  check(
    'nothing dips below the ground',
    b.min.y >= GROUND - 1e-6,
    `lowest ${b.min.y.toFixed(3)} against ground ${GROUND.toFixed(3)}`,
  );
  check(
    'the roof is a believable height',
    b.max.y - GROUND > 1.1 && b.max.y - GROUND < 1.5,
    `${(b.max.y - GROUND).toFixed(3)} m tall`,
  );
}

console.log('\nevery face is wound outward');
{
  const model = buildCarModel(1);
  const v = signedVolume6(model.body) / 6;
  check('the body has positive signed volume', v > 0, `${v.toFixed(3)} m^3`);
  // A 4.5 x 1.9 x 1.3 car is a couple of cubic metres of shell; a wildly
  // different figure means faces are cancelling each other out.
  check('and a plausible one', v > 1 && v < 12, `${v.toFixed(3)} m^3`);

  const w = signedVolume6(model.wheels[0]!.geometry) / 6;
  check('so does a wheel', w > 0, `${w.toFixed(4)} m^3`);
}

console.log('\nthe wheels sit where the physics puts them');
{
  const model = buildCarModel(3);
  check('four of them', model.wheels.length === 4);
  check(
    'the front pair steers, and comes first',
    model.wheels[0]!.steered && model.wheels[1]!.steered,
  );
  check('the rear pair does not', !model.wheels[2]!.steered && !model.wheels[3]!.steered);

  for (const w of model.wheels) {
    near(`wheel x is on the ${CAR.track} m track`, Math.abs(w.position.x), CAR.track / 2, 1e-6);
    near('wheel z is on the wheelbase', Math.abs(w.position.z), CAR.wheelbase / 2, 1e-6);
  }
  near('and the hub is at the rest height', model.wheels[0]!.position.y, WHEEL_REST_Y, 1e-6);

  // The tread is an 18-sided prism inscribed in the circle, so its silhouette
  // runs between R at a vertex and R * cos(pi/18) across a flat - about 5 mm
  // shallower. Inscribed rather than circumscribed on purpose: the tyre then
  // never reads wider than the physics radius, and 5 mm of ride height at the
  // flat is not visible. Asserting an exact R here would be asserting something
  // no polygon can do.
  const flat = CAR.wheelRadius * Math.cos(Math.PI / 18);
  const wb = bounds(model.wheels[0]!.geometry);
  const r = (wb.max.y - wb.min.y) / 2;
  check(
    'the tyre carries the physics radius',
    r <= CAR.wheelRadius + 1e-4 && r >= flat - 1e-4,
    `${r.toFixed(4)} outside ${flat.toFixed(4)}..${CAR.wheelRadius.toFixed(4)}`,
  );
  const patch = model.wheels[0]!.position.y + wb.min.y;
  check(
    'and its contact patch sits on the ground',
    patch >= GROUND - 1e-4 && patch <= GROUND + (CAR.wheelRadius - flat) + 1e-4,
    `${patch.toFixed(4)} against ground ${GROUND.toFixed(4)}`,
  );
}

console.log('\nevery livery is built and coloured');
{
  // Every colour, so a livery that only breaks on car 7 cannot hide.
  for (let i = 0; i < CAR_COLORS.length; i++) {
    const model = buildCarModel(i);
    const c = model.body.getAttribute('color');
    check(`car ${i + 1} has a colour per vertex`, c?.count > 0);
    let lit = 0;
    for (let v = 0; v < c.count; v++) if (c.getX(v) + c.getY(v) + c.getZ(v) > 0.02) lit++;
    // Black bodywork is a valid choice; wholly black geometry is the no-normals
    // failure wearing a disguise, so require most of it to carry some colour.
    check('  and most of it is not black', lit > c.count * 0.5, `${lit} of ${c.count}`);
    const n = model.body.getAttribute('normal');
    check('  and normals exist', n?.count === c.count);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}

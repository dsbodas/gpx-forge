/**
 * Ride-time estimate from a physical power model.
 *
 * For each segment of the profile we solve the steady-state power balance for
 * speed:
 *
 *   P·η = v · ( Crr·m·g·cosθ  +  m·g·sinθ  +  ½·ρ·CdA·(v + headwind)² )
 *
 * There is no closed form worth writing (it is a cubic in v once the wind term
 * is expanded), so we bisect — the right-hand side rises monotonically with v,
 * which makes bisection both safe and quick.
 *
 * On descents steep enough that gravity alone exceeds the rider's power, the
 * solution becomes terminal velocity, which we then cap at a speed a human
 * would actually accept on a bend.
 */

import { clamp } from './util.js';

const G = 9.80665;

export const DEFAULTS = {
  riderMass: 75,          // kg
  bikeMass: 9,            // kg
  power: 180,             // W — sustainable output
  cda: 0.36,              // m² — road bike, hands on the hoods
  crr: 0.005,             // asphalt, decent 28 mm tyres
  drivetrain: 0.975,      // chain efficiency
  headwind: 0,            // m/s (positive = into the wind)
  maxDescentSpeed: 65,    // km/h — comfort/braking limit
  stoppedAllowance: 0,    // seconds of junctions, cafés, photos
  surfaceFactor: 1,       // <1 when the route is largely unpaved
};

/**
 * Position/bike presets. CdA values are the usual published field-test ranges;
 * they matter far more than rider mass on flat ground, so getting this roughly
 * right is what makes the estimate believable.
 */
export const BIKE_PRESETS = [
  { id: 'tt', label: 'TT / triathlon bike', cda: 0.24, crr: 0.004, bikeMass: 9.5 },
  { id: 'road-drops', label: 'Road bike — in the drops', cda: 0.30, crr: 0.004, bikeMass: 8.5 },
  { id: 'road-hoods', label: 'Road bike — on the hoods', cda: 0.36, crr: 0.005, bikeMass: 9 },
  { id: 'endurance', label: 'Endurance / audax, upright', cda: 0.42, crr: 0.006, bikeMass: 11 },
  { id: 'gravel', label: 'Gravel bike (mixed surface)', cda: 0.42, crr: 0.008, bikeMass: 11 },
  { id: 'mtb', label: 'Mountain bike', cda: 0.48, crr: 0.012, bikeMass: 13 },
  { id: 'hybrid', label: 'Hybrid / city bike, upright', cda: 0.55, crr: 0.008, bikeMass: 14 },
  { id: 'loaded', label: 'Loaded tourer / bikepacking', cda: 0.50, crr: 0.008, bikeMass: 22 },
];

/** Air density from elevation, ISA barometric approximation. */
function airDensity(elevationM) {
  const h = clamp(elevationM || 0, -500, 5000);
  return 1.225 * Math.pow(1 - 2.25577e-5 * h, 4.25588);
}

/**
 * Speed (m/s) that balances `power` on a slope of `grade` (rise/run).
 */
export function solveSpeed(power, grade, params, rho) {
  const mass = params.riderMass + params.bikeMass;
  const theta = Math.atan(grade);
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);

  // Rolling resistance rises on loose surfaces.
  const crr = params.crr / clamp(params.surfaceFactor, 0.4, 1);

  const resistiveForce = (v) => {
    const apparent = v + params.headwind;
    const drag = 0.5 * rho * params.cda * apparent * Math.abs(apparent);
    return crr * mass * G * cos + mass * G * sin + drag;
  };

  // Net power available at the wheel minus what the slope demands.
  const net = (v) => power * params.drivetrain - v * resistiveForce(v);

  let lo = 0.05;
  let hi = 40; // 144 km/h — comfortably above any real solution

  if (net(lo) < 0) {
    // Cannot even hold walking pace — a wall. Assume the rider pushes the bike.
    return 1.1;
  }
  if (net(hi) > 0) return hi;

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Estimates ride time over an analysed profile.
 * @param {Array} profile  [{dist, ele, grade}] from analysis.analyse()
 * @param {object} options  overrides for DEFAULTS
 */
export function estimate(profile, options = {}) {
  const params = { ...DEFAULTS, ...options };
  if (!profile || profile.length < 2) return null;

  const maxDescentMs = params.maxDescentSpeed / 3.6;
  const speeds = new Array(profile.length).fill(0);
  let seconds = 0;

  for (let i = 1; i < profile.length; i++) {
    const span = profile[i].dist - profile[i - 1].dist;
    if (span <= 0) continue;

    const grade = (profile[i].grade + profile[i - 1].grade) / 2;
    const rho = airDensity((profile[i].ele + profile[i - 1].ele) / 2);

    let v = solveSpeed(params.power, grade, params, rho);
    // Descending: the model happily produces 90 km/h. Riders do not.
    if (grade < 0) v = Math.min(v, maxDescentMs);
    v = clamp(v, 0.8, maxDescentMs);

    speeds[i] = v;
    seconds += span / v;
  }
  speeds[0] = speeds[1] || 0;

  const distance = profile[profile.length - 1].dist;
  return {
    movingSeconds: seconds,
    totalSeconds: seconds + params.stoppedAllowance,
    avgSpeedKmh: distance > 0 ? (distance / seconds) * 3.6 : 0,
    speeds,
    params,
  };
}

/** Per-climb time, so the climb table can show "≈ 34 min". */
export function climbTimes(profile, climbs, options = {}) {
  const params = { ...DEFAULTS, ...options };
  return climbs.map((climb) => {
    let seconds = 0;
    for (let i = climb.startIdx + 1; i <= climb.endIdx && i < profile.length; i++) {
      const span = profile[i].dist - profile[i - 1].dist;
      if (span <= 0) continue;
      const grade = (profile[i].grade + profile[i - 1].grade) / 2;
      const rho = airDensity((profile[i].ele + profile[i - 1].ele) / 2);
      seconds += span / clamp(solveSpeed(params.power, grade, params, rho), 0.8, 25);
    }
    return {
      seconds,
      speedKmh: seconds > 0 ? (climb.length / seconds) * 3.6 : 0,
      // Vertical metres per hour — the number climbers actually compare.
      vam: seconds > 0 ? (climb.gain / seconds) * 3600 : 0,
    };
  });
}

/**
 * Back-solves the power needed to hold a given speed on the flat. Lets the UI
 * offer "I ride about 25 km/h" instead of demanding the rider know their FTP.
 */
export function powerForFlatSpeed(speedKmh, options = {}) {
  const params = { ...DEFAULTS, ...options };
  const v = speedKmh / 3.6;
  const mass = params.riderMass + params.bikeMass;
  const rho = airDensity(100);
  const crr = params.crr / clamp(params.surfaceFactor, 0.4, 1);
  const apparent = v + params.headwind;
  const force = crr * mass * G + 0.5 * rho * params.cda * apparent * Math.abs(apparent);
  return Math.round((v * force) / params.drivetrain);
}

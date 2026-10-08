// The 3D world. Everything drawn is read from the simulation: land use and crops on the ground texture, roads,
// buildings (lit windows at night where people live), construction sites rising with their real progress, trucks
// carrying actual shipments along their routes, and a sample of real commuters driving between home and work.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Sim } from '../sim/core';
import { hash01 } from '../sim/rng';
import { BUILDINGS } from '../sim/tables';
import { Terrain, Zone, type Building, type BuildingKind } from '../sim/types';
import { flightsOn } from '../sim/systems/aviation';
import { findPath } from '../sim/systems/transport';
import { isRoadwork } from '../sim/systems/construction';
import { projectProgress, refAtTile, type Ref } from '../sim/inspect';
import { previewBuilding, previewDemolish, previewRoad, rectTiles, routeTiles, zoneable, type RoadTool } from '../sim/commands';
import { CameraRig, type CameraPreset } from './camera';
import { buildingLook, CAR_COLORS, GOOD_COLORS, lookFor, setRegionStyle } from './look';
import { N, outerGround, paintOverlay, paintTerrain, roadColor, TEX, ZONE_RGB, type Overlay } from './paint';

export type Tool =
  | { mode: 'inspect' }
  | { mode: 'build'; kind: BuildingKind; floors?: number; rot?: boolean }
  | { mode: 'road'; kind: RoadTool }
  | { mode: 'zone'; zone: number }
  | { mode: 'bulldoze' };

export type Selection = { ref: Ref } | { vehicle: 'truck' | 'car'; id: number };

export interface ViewEvents {
  select(sel: Selection | null): void;
  place(x: number, y: number): void;
  route(tiles: number[]): void;
  zone(tiles: number[]): void;
  /** Bulldozer: a building clicked (its first tile) or road tiles dragged across. */
  demolish(tiles: number[]): void;
}

export interface ViewOptions {
  getSim: () => Sim;
  onFrame?: (dtMs: number) => void;
}

const UP = new THREE.Vector3(0, 1, 0);
const AX_X = new THREE.Vector3(1, 0, 0);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Direction the wind blows towards today, shared by turbines and smoke; it shifts every few days. */
const windYaw = (day: number) => hash01(Math.floor(day / 3), 23) * Math.PI * 2;

/** What the bulldozer takes from a press at `from` dragged to `to`: the building pressed on, or the roads along the drag. */
function demolishTarget(sim: Sim, from: number, to: number): number[] {
  if (from < 0) return [];
  const m = sim.s.map;
  const o = m.owner[from];
  const b = o >= 0 ? sim.bld(o) : undefined;
  if (b) {
    const out: number[] = [];
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) out.push(y * N + x);
    return out;
  }
  const t = to < 0 ? from : to;
  return routeTiles(from % N, (from / N) | 0, t % N, (t / N) | 0).filter((i) => m.road[i] > 0);
}

/** A resizable instanced mesh with per-instance colour and optional float attributes. */
class Layer {
  mesh!: THREE.InstancedMesh;
  n = 0;
  private cap = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private col = new THREE.Color();

  constructor(private parent: THREE.Object3D, private geo: THREE.BufferGeometry, private mat: THREE.Material, cap: number,
    private attrs: string[] = [], private cast = false, private receive = false, private order = 0) {
    this.alloc(cap);
  }

  private alloc(cap: number): void {
    if (this.mesh) { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.dispose(); }
    const g = this.geo.clone();
    for (const a of this.attrs) g.setAttribute(a, new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    this.mesh = new THREE.InstancedMesh(g, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.cast;
    this.mesh.receiveShadow = this.receive;
    this.mesh.renderOrder = this.order;
    this.mesh.count = 0;
    this.cap = cap;
    this.parent.add(this.mesh);
  }

  begin(expected: number): void {
    if (expected > this.cap) this.alloc(Math.ceil(expected * 1.4) + 16);
    this.n = 0;
  }

  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY: number, color: number, a?: number[]): number {
    this.q.setFromAxisAngle(UP, rotY);
    return this.addQ(x, y, z, sx, sy, sz, this.q, color, a);
  }

  /** Like add, with any orientation (turbine blades). */
  addQ(x: number, y: number, z: number, sx: number, sy: number, sz: number, q: THREE.Quaternion, color: number, a?: number[]): number {
    if (this.n >= this.cap) return -1;
    this.p.set(x, y, z);
    this.sc.set(sx, sy, sz);
    this.m.compose(this.p, q, this.sc);
    this.mesh.setMatrixAt(this.n, this.m);
    this.col.setHex(color);
    this.mesh.setColorAt(this.n, this.col);
    if (a) for (let k = 0; k < a.length; k++) ((this.mesh.geometry.getAttribute(this.attrs[k]) as THREE.InstancedBufferAttribute).array as Float32Array)[this.n] = a[k];
    return this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    for (const a of this.attrs) (this.mesh.geometry.getAttribute(a) as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.mesh.boundingSphere = null;
  }

  /** Swaps the material, e.g. unlit while an info view colours the instances. */
  setMaterial(mat: THREE.Material): void {
    if (this.mat === mat) return;
    this.mat = mat;
    this.mesh.material = mat;
  }

  dispose(): void { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.dispose(); }
}

function gableGeometry(): THREE.BufferGeometry {
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5], E = [-0.5, 1, 0], F = [0.5, 1, 0];
  const tris = [D, C, F, D, F, E, B, A, E, B, E, F, A, D, E, C, B, F];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}

/** Wall material: window rows per storey; windows of lived-in buildings glow at night. */
function wallMaterial(): { mat: THREE.MeshStandardMaterial; night: { value: number } } {
  const night = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = night;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLit;\nattribute float aFloors;\nvarying vec3 vLocal;\nvarying vec3 vNrm;\nvarying float vLit;\nvarying float vFloors;\nvarying vec2 vScale;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;\nvNrm = normal;\nvLit = aLit;\nvFloors = aFloors;\nvScale = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz));');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vLocal;\nvarying vec3 vNrm;\nvarying float vLit;\nvarying float vFloors;\nvarying vec2 vScale;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float side = 1.0 - step(0.5, abs(vNrm.y));
        float fy = fract(vLocal.y * vFloors);
        float across = abs(vNrm.x) > 0.5 ? vLocal.z * vScale.y : vLocal.x * vScale.x;
        float fx = fract(across * 9.0);
        float win = side * step(0.35, fy) * step(fy, 0.78) * step(0.22, fx) * step(fx, 0.78);
        diffuseColor.rgb *= 1.0 - 0.3 * win;
        float on = step(0.4, fract(sin(dot(floor(vec2(across * 9.0, vLocal.y * vFloors)), vec2(12.9898, 78.233))) * 43758.5453));
        totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * win * vLit * uNight * on;`);
  };
  return { mat, night };
}

/** A regional turboprop with its nose along +x: fuselage, high wing, engines and T-tail. The fin is a separate layer in the airline's colour. */
function planeGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.BoxGeometry(1, 0.11, 0.11).translate(0, 0.1, 0),
    new THREE.BoxGeometry(0.12, 0.07, 0.08).translate(0.53, 0.09, 0),
    new THREE.BoxGeometry(0.2, 0.025, 1).translate(0.06, 0.16, 0),
    new THREE.BoxGeometry(0.2, 0.06, 0.07).translate(0.1, 0.13, 0.24),
    new THREE.BoxGeometry(0.2, 0.06, 0.07).translate(0.1, 0.13, -0.24),
    new THREE.BoxGeometry(0.12, 0.02, 0.36).translate(-0.45, 0.29, 0),
  ];
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

/** Soft round falloff used for pools of light on the ground. */
function glowTexture(): THREE.DataTexture {
  const n = 64, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
    const i = (y * n + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(Math.max(0, 1 - d) ** 1.8 * 255);
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

interface Frame {
  long: number; short: number; horiz: boolean;
  /** Map position of a point given along the building (u) and across it from its road side (v). */
  at(u: number, v: number): [number, number];
  /** Map extent of a box measured along and across the building. */
  size(lu: number, lv: number): [number, number];
  /** Map direction of a heading given along and across the building. */
  dir(du: number, dv: number): [number, number];
}

/** Coordinates for laying out a long building such as the airport: u runs along it, v across it from the side facing its road. */
function frameOf(b: Building): Frame {
  const horiz = b.w >= b.h;
  const long = horiz ? b.w : b.h, short = horiz ? b.h : b.w;
  let roadLow = true;
  if (b.access >= 0) {
    const ax = (b.access % N) + 0.5, az = ((b.access / N) | 0) + 0.5;
    roadLow = horiz ? az < b.y + b.h / 2 : ax < b.x + b.w / 2;
  }
  const sv = roadLow ? 1 : -1;
  return {
    long, short, horiz,
    at: (u, v) => { const vv = roadLow ? v : short - v; return horiz ? [b.x + u, b.y + vv] : [b.x + vv, b.y + u]; },
    size: (lu, lv) => (horiz ? [lu, lv] : [lv, lu]),
    dir: (du, dv) => (horiz ? [du, dv * sv] : [dv * sv, du]),
  };
}

/** Quarter turn that points a building's front (local +z) at the road it is reached from. */
function frontRot(b: Building): number {
  if (b.access < 0) return 0;
  const dx = (b.access % N) + 0.5 - (b.x + b.w / 2), dz = ((b.access / N) | 0) + 0.5 - (b.y + b.h / 2);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? Math.PI / 2 : -Math.PI / 2;
  return dz > 0 ? 0 : Math.PI;
}

// airport layout across the site, from the road: terminal, apron (stands), taxiway, runway centreline
const AP_STAND = 1.42, AP_TWY = 2.05, AP_RWY = 3.0;

interface Pose { x: number; y: number; z: number; rot: number }

/** Where an aircraft is at minute-of-day `t` on a turnaround that lands at `tA` and takes off again at `tD`. */
function planePose(F: Frame, t: number, tA: number, tD: number, stand: number): Pose | null {
  const su = 9.5 + stand * 1.6;
  const pose = (u: number, v: number, alt: number, du: number, dv: number): Pose => {
    const [x, z] = F.at(u, v), [dx, dz] = F.dir(du, dv);
    return { x, y: 0.02 + alt, z, rot: Math.atan2(-dz, dx) };
  };
  // taxiing at an even speed along a route; `nose` overrides the heading on the first leg (pushback)
  const taxi = (pts: [number, number][], f: number, nose?: [number, number]): Pose => {
    const legs: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); legs.push(d); total += d; }
    let rest = Math.max(0, Math.min(1, f)) * total;
    for (let i = 0; i < legs.length; i++) {
      if (rest <= legs[i] || i === legs.length - 1) {
        const k = legs[i] > 0 ? Math.min(1, rest / legs[i]) : 1;
        const a = pts[i], b = pts[i + 1], du = b[0] - a[0], dv = b[1] - a[1];
        const n = i === 0 && nose ? nose : [du, dv];
        return pose(a[0] + du * k, a[1] + dv * k, 0, n[0], n[1]);
      }
      rest -= legs[i];
    }
    return pose(pts[0][0], pts[0][1], 0, 1, 0);
  };
  if (t >= tA - 10 && t < tA) { const f = (t - tA + 10) / 10; return pose(-40 + 42.5 * f, AP_RWY, 7 * (1 - f), 1, 0); }
  if (t >= tA && t < tA + 2) { const f = (t - tA) / 2; return pose(2.5 + 9.5 * (1 - (1 - f) * (1 - f)), AP_RWY, 0, 1, 0); }
  if (t >= tA + 2 && t < tA + 5) return taxi([[12, AP_RWY], [12, AP_TWY], [su, AP_TWY], [su, AP_STAND]], (t - tA - 2) / 3);
  if (t >= tA + 5 && t < tD - 4) return pose(su, AP_STAND, 0, 0, -1);
  if (t >= tD - 4 && t < tD) return taxi([[su, AP_STAND], [su, AP_TWY], [2.5, AP_TWY], [2.5, AP_RWY]], (t - tD + 4) / 4, [0, -1]);
  if (t >= tD && t < tD + 1.2) { const f = (t - tD) / 1.2; return pose(2.5 + 10.5 * f * f, AP_RWY, 0, 1, 0); }
  if (t >= tD + 1.2 && t < tD + 7.2) { const f = (t - tD - 1.2) / 6; return pose(13 + 50 * f, AP_RWY, 7 * f * (0.6 + 0.4 * f), 1, 0); }
  return null;
}

const WEATHERED = new THREE.Color(0x77736a);
const SIGN_COLORS = [0xff4d3d, 0x3dc8ff, 0xffd23d, 0xf2f2f2];
const TEAM_COLORS = [0x2f6fb0, 0xc0392b, 0x2e8b57, 0xe0a020, 0x6c3fb0];
const LIVERY = [0xd8432f, 0x2f6fd8, 0x2fae6a, 0xe0a020, 0x7a3fc0, 0x1f9fb0];
/** Upper bound on extra parts drawn for each decorated building type. */
const PARTS: Partial<Record<BuildingKind, number>> = {
  airport: 150, stadium: 40, heritage: 30, museum: 12, hotel: 4, cinema: 6, solarfarm: 32, windfarm: 12, substation: 14, waterworks: 8, firestation: 8, gasplant: 4,
};
/** Sites laid out across their whole footprint, outlined by it (height of the outline box). */
const WHOLE: Partial<Record<BuildingKind, number>> = { airport: 0.45, stadium: 1.08, heritage: 0.9, solarfarm: 0.3, windfarm: 1.75, substation: 0.5, waterworks: 0.9 };
const URBAN = new Set<number>([Zone.Residential, Zone.Commercial, Zone.Industrial]);
/**
 * Each region's trees: their colours in woods and in gardens, and their shape (height and spread): flat-topped
 * acacias on the savanna, tall dark firs in a temperate valley, dense deep-green woods in the tropics.
 */
interface TreeLook { forest: number[]; park: number[]; h: number; r: number }
const DEFAULT_TREES: TreeLook = { forest: [0x2f5a2a, 0x3b6b30, 0x2c4f28, 0x47753a], park: [0x4f8a3a, 0x5d9a44, 0x3f7a34], h: 1, r: 1 };
const TREES_BY_REGION: Record<string, TreeLook> = {
  'in-deccan': { forest: [0x4a5e2c, 0x56682f, 0x3f5528], park: [0x5f7d36, 0x6b8a3c, 0x55722f], h: 0.85, r: 1.15 },
  'in-punjab': { forest: [0x355f2c, 0x416b32, 0x2f5528], park: [0x538a3c, 0x60973f, 0x497c35], h: 1.05, r: 1 },
  'ke-rift': { forest: [0x5a6a30, 0x667635, 0x4e5f2b], park: [0x6a7d3a, 0x76893f, 0x5d7033], h: 0.55, r: 1.6 },
  'vn-mekong': { forest: [0x245a2a, 0x2c6a30, 0x1f4f26], park: [0x3f8a3a, 0x4a9a42, 0x377a34], h: 1.15, r: 1.05 },
  fictional: { forest: [0x1f3f26, 0x27492c, 0x1b3822], park: [0x3d7036, 0x477c3c, 0x36652f], h: 1.45, r: 0.78 },
  'bd-delta': { forest: [0x275e2b, 0x306c32, 0x225326], park: [0x428c3c, 0x4c9a44, 0x3a7c35], h: 1.2, r: 1.05 },
  'id-java': { forest: [0x1f5228, 0x26602e, 0x1a4823], park: [0x3c8838, 0x469640, 0x347832], h: 1.3, r: 1.1 },
  'ng-savanna': { forest: [0x6a7034, 0x767c3a, 0x5d6430], park: [0x748a3c, 0x7f9542, 0x687d36], h: 0.5, r: 1.7 },
  'et-highlands': { forest: [0x4b6650, 0x557258, 0x425c48], park: [0x5b7e48, 0x66894f, 0x527240], h: 1.35, r: 0.85 },
};
const hashStr = (t: string) => { let h = 7; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return Math.abs(h); };

interface Commuter { id: number; path: number[]; depart: number; ret: number; dur: number; mode: number; color: number }

export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  overlay: Overlay = 'none';
  tool: Tool = { mode: 'inspect' };
  selection: Selection | null = null;
  /** Real commuters represented by each car drawn. */
  carScale = 1;

  private canvas: HTMLCanvasElement;
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a6b45, 0.7);
  private fog = new THREE.Fog(0x9fc4e8, 200, 700);
  private terrainData = new Uint8Array(TEX * TEX * 4);
  private terrainTex: THREE.DataTexture;
  private overlayData = new Uint8Array(N * N * 4);
  private overlayTex: THREE.DataTexture;
  private overlayMesh: THREE.Mesh;
  private night: { value: number };
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private roads: Layer; private walls: Layer; private gables: Layer; private flats: Layer; private extras: Layer; private trees: Layer;
  /** Roads are lit like the rest of the world, except under info views that colour them (readable by night too). */
  private roadMat: THREE.Material; private roadFlat: THREE.Material;
  private siteSolid: Layer; private siteMark: Layer; private cranes: Layer; private trucks: Layer; private cars: Layer; private marks: Layer; private preview: Layer;
  // landmarks, street lighting and aircraft
  private spires: Layer; private signs: Layer; private bldPools: Layer; private posts: Layer; private lampHeads: Layer; private lampPools: Layer;
  private planeBody: Layer; private planeTail: Layer;
  // wind turbine rotors, fires
  private blades: Layer; private flames: Layer; private smoke: Layer;
  private turbines: { x: number; y: number; z: number; yaw: number; phase: number; on: boolean }[] = [];
  private burning: { x: number; z: number; w: number; h: number; seed: number }[] = [];
  private spin = 0; private spinMinute = -1;
  private flameMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  private smokeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false });
  private qa = new THREE.Quaternion(); private qb = new THREE.Quaternion();
  /** Unlit material for lamps, signs and runway lights: dull by day, bright at night. */
  private glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private poolTex = glowTexture();
  /** Pools of light on the ground at night under street lamps, floodlit monuments and the stadium. */
  private poolMat = new THREE.MeshBasicMaterial({ map: this.poolTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  private tmpColor = new THREE.Color();
  /** Stadium event counters seen so far, to tell when a match was played today (floodlights on in the evening). */
  private venueSeen = new Map<number, { month: number; events: number; day: number }>();
  private ghost: THREE.Mesh;
  private ghostMat = new THREE.MeshBasicMaterial({ color: 0x55cc77, transparent: true, opacity: 0.45, depthWrite: false });
  private edges: THREE.LineSegments;
  private hoverLine: THREE.LineLoop;
  private buildingIds: number[] = [];
  private truckIds: number[] = []; private truckXZ: number[] = [];
  private carIds: number[] = []; private carXZ: number[] = [];
  private seen: Record<string, number> = {};
  private paintedDay = -1; private overlayDay = -1; private overlayKind: Overlay = 'none'; private siteMinute = -1e9; private builtDay = -1; private commuterDay = -1;
  private farmTiles: number[] = [];
  private commuters: Commuter[] = [];
  private commuterQueue: number[] = [];
  private hover = -1;
  private dragFrom = -1;
  private dragging = false;
  private downAt = { x: 0, y: 0 };
  private pendingTiles: number[] | null = null;
  private pendingColor = 0x55cc77;
  private pendingBuild: { x: number; y: number; ok: boolean } | null = null;
  private hoverKey = '';
  private hoverOk = false;
  private hlKey = '';
  private frameNo = 0;
  private raf = 0;
  private last = performance.now();
  private ro: ResizeObserver;
  private disposed = false;
  private leftHand: boolean;
  private v3 = new THREE.Vector3();

  constructor(private container: HTMLElement, private opts: ViewOptions, private events: ViewEvents) {
    const sim = opts.getSim();
    this.leftHand = !!sim.preset.driveLeft;
    setRegionStyle(sim.s.meta.preset);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'world-canvas';
    this.canvas.setAttribute('aria-label', 'Interactive 3D view of the region. Drag to pan, right-drag to rotate, scroll to zoom.');
    container.appendChild(this.canvas);
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.rig = new CameraRig(this.canvas, w / h);
    const th = sim.s.buildings.find((b) => b.kind === 'townhall');
    if (th) { const [x, y] = sim.center(th); this.rig.target.set(x, 0, y); }
    else {
      // no town yet: look at the road closest to the middle of the region
      let best = -1, bd = Infinity;
      for (let t = 0; t < N * N; t++) {
        if (!sim.s.map.road[t]) continue;
        const d = Math.hypot((t % N) - N / 2, ((t / N) | 0) - N / 2);
        if (d < bd) { bd = d; best = t; }
      }
      if (best >= 0) this.rig.target.set((best % N) + 0.5, 0, ((best / N) | 0) + 0.5);
    }
    this.rig.preset('city');
    this.rig.snap();
    this.scene.fog = this.fog;

    // lights
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    // ground
    this.terrainTex = new THREE.DataTexture(this.terrainData, TEX, TEX, THREE.RGBAFormat);
    this.terrainTex.colorSpace = THREE.SRGBColorSpace;
    this.terrainTex.magFilter = THREE.NearestFilter;
    this.terrainTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.terrainTex.generateMipmaps = true;
    this.terrainTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const groundGeo = this.keepGeo(new THREE.PlaneGeometry(N, N));
    const ground = new THREE.Mesh(groundGeo, this.keepMat(new THREE.MeshLambertMaterial({ map: this.terrainTex })));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(N / 2, 0, N / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);
    const outer = new THREE.Mesh(this.keepGeo(new THREE.PlaneGeometry(4000, 4000)), this.keepMat(new THREE.MeshLambertMaterial({ color: outerGround(sim) })));
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(N / 2, -0.04, N / 2);
    this.scene.add(outer);

    this.overlayTex = new THREE.DataTexture(this.overlayData, N, N, THREE.RGBAFormat);
    this.overlayTex.colorSpace = THREE.SRGBColorSpace;
    this.overlayTex.magFilter = THREE.LinearFilter;
    this.overlayTex.minFilter = THREE.LinearFilter;
    this.overlayMesh = new THREE.Mesh(groundGeo, this.keepMat(new THREE.MeshBasicMaterial({ map: this.overlayTex, transparent: true, depthWrite: false })));
    this.overlayMesh.rotation.x = -Math.PI / 2;
    this.overlayMesh.position.set(N / 2, 0.02, N / 2);
    this.overlayMesh.renderOrder = 2;
    this.overlayMesh.visible = false;
    this.scene.add(this.overlayMesh);

    // geometry and layers
    const box = this.keepGeo(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    const cyl = this.keepGeo(new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0));
    const cone = this.keepGeo(new THREE.ConeGeometry(0.5, 1, 7).translate(0, 0.5, 0));
    const gable = this.keepGeo(gableGeometry());
    const lambert = () => this.keepMat(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const wm = wallMaterial();
    this.night = wm.night;
    this.keepMat(wm.mat);
    const glass = (opacity: number) => this.keepMat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false }));
    this.roadMat = lambert();
    this.roadFlat = this.keepMat(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.roads = new Layer(this.scene, box, this.roadMat, 8000, [], false, true);
    this.walls = new Layer(this.scene, box, wm.mat, 2000, ['aLit', 'aFloors'], true, true);
    this.gables = new Layer(this.scene, gable, lambert(), 1500, [], true, true);
    this.flats = new Layer(this.scene, box, lambert(), 1500, [], true, true);
    this.extras = new Layer(this.scene, cyl, lambert(), 400, [], true, true);
    this.trees = new Layer(this.scene, cone, lambert(), 6000, [], true, false);
    this.siteSolid = new Layer(this.scene, box, lambert(), 100, [], true, true);
    this.siteMark = new Layer(this.scene, box, glass(0.5), 600, [], false, false, 3);
    this.cranes = new Layer(this.scene, box, lambert(), 100, [], true, false);
    this.trucks = new Layer(this.scene, box, lambert(), 600, [], true, false);
    this.cars = new Layer(this.scene, box, lambert(), 400, [], false, false);
    this.marks = new Layer(this.scene, box, glass(0.38), 400, [], false, false, 4);
    this.preview = new Layer(this.scene, box, glass(0.55), 800, [], false, false, 5);
    const spire = this.keepGeo(new THREE.ConeGeometry(0.5, 1, 8).translate(0, 0.5, 0));
    const flat = this.keepGeo(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.spires = new Layer(this.scene, spire, lambert(), 60, [], true, true);
    this.signs = new Layer(this.scene, box, this.glowMat, 200);
    this.bldPools = new Layer(this.scene, flat, this.poolMat, 60, [], false, false, 2);
    this.posts = new Layer(this.scene, box, lambert(), 1500);
    this.lampHeads = new Layer(this.scene, box, this.glowMat, 1500);
    this.lampPools = new Layer(this.scene, flat, this.poolMat, 1500, [], false, false, 2);
    this.planeBody = new Layer(this.scene, this.keepGeo(planeGeometry()), lambert(), 24, [], true, false);
    this.planeTail = new Layer(this.scene, this.keepGeo(new THREE.BoxGeometry(0.16, 0.16, 0.02).translate(-0.43, 0.21, 0)), lambert(), 24, [], true, false);
    this.blades = new Layer(this.scene, box, lambert(), 60, [], true, false);
    this.flames = new Layer(this.scene, cone, this.flameMat, 40, [], false, false, 3);
    this.smoke = new Layer(this.scene, this.keepGeo(new THREE.IcosahedronGeometry(0.5, 1)), this.smokeMat, 60, [], false, false, 3);
    this.ghost = new THREE.Mesh(box, this.ghostMat);
    this.ghost.visible = false;
    this.ghost.renderOrder = 6;
    this.scene.add(this.ghost);
    const eg = this.keepGeo(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)));
    this.edges = new THREE.LineSegments(eg, this.keepMat(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false })));
    this.edges.visible = false;
    this.edges.renderOrder = 7;
    this.scene.add(this.edges);
    const sq = this.keepGeo(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 1), new THREE.Vector3(0, 0, 1)]));
    this.hoverLine = new THREE.LineLoop(sq, this.keepMat(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })));
    this.hoverLine.visible = false;
    this.scene.add(this.hoverLine);

    // input
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.raf = requestAnimationFrame(this.loop);
  }

  private keepGeo<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g; }
  private keepMat<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }

  // ------------------------------------------------------------------------------------------ public API

  setTool(tool: Tool): void {
    this.tool = tool;
    this.rig.toolDrag = tool.mode === 'road' || tool.mode === 'zone' || tool.mode === 'bulldoze';
    this.clearPending();
    this.hoverKey = '';
    this.canvas.style.cursor = tool.mode === 'inspect' ? 'default' : 'crosshair';
  }

  /** Turns the building being placed by a quarter, keeping a spot that has already been clicked. */
  turn(rot: boolean): void {
    if (this.tool.mode !== 'build') return;
    this.tool = { ...this.tool, rot };
    this.hoverKey = '';
  }

  setOverlay(o: Overlay): void { this.overlay = o; }

  select(sel: Selection | null, focus?: [number, number]): void {
    this.selection = sel;
    this.hlKey = '';
    this.rig.follow = null;
    if (sel && 'vehicle' in sel) this.follow(sel);
    else if (focus) this.rig.flyTo(focus[0], focus[1], Math.min(this.rig.dist, 40));
  }

  follow(sel: Selection): void {
    if (!('vehicle' in sel)) return;
    let last: THREE.Vector3 | null = null;
    this.rig.dist = Math.min(this.rig.dist, 14);
    this.rig.follow = () => {
      const ids = sel.vehicle === 'truck' ? this.truckIds : this.carIds, xz = sel.vehicle === 'truck' ? this.truckXZ : this.carXZ;
      const i = ids.indexOf(sel.id);
      if (i >= 0) last = new THREE.Vector3(xz[i * 2], 0, xz[i * 2 + 1]);
      return last;
    };
  }

  isFollowing(): boolean { return this.rig.follow !== null; }

  /** Whether a vehicle is currently on the map (trip still under way). */
  vehicleVisible(sel: Selection): boolean {
    if (!('vehicle' in sel)) return false;
    return (sel.vehicle === 'truck' ? this.truckIds : this.carIds).includes(sel.id);
  }

  focus(x: number, z: number, dist?: number): void { this.rig.flyTo(x, z, dist); }

  preset(p: CameraPreset): void { this.rig.preset(p); }

  clearPending(): void {
    this.pendingTiles = null;
    this.pendingBuild = null;
    this.dragging = false;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.rig.dispose();
    for (const l of [this.roads, this.walls, this.gables, this.flats, this.extras, this.trees, this.siteSolid, this.siteMark, this.cranes, this.trucks, this.cars, this.marks, this.preview,
      this.spires, this.signs, this.bldPools, this.posts, this.lampHeads, this.lampPools, this.planeBody, this.planeTail, this.blades, this.flames, this.smoke]) l.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.ghostMat.dispose();
    this.flameMat.dispose();
    this.smokeMat.dispose();
    this.glowMat.dispose();
    this.poolMat.dispose();
    this.poolTex.dispose();
    this.terrainTex.dispose();
    this.overlayTex.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ------------------------------------------------------------------------------------------ loop

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(1000, now - this.last);
    this.last = now;
    this.opts.onFrame?.(dt);
    const sim = this.opts.getSim();
    this.frameNo++;
    this.sync(sim);
    this.rig.update(dt);
    this.lighting(sim);
    this.vehicles(sim);
    this.planes(sim);
    this.animate(sim, dt);
    this.tools(sim);
    this.renderer.render(this.scene, this.rig.camera);
  };

  private changed(sim: Sim, ...keys: (keyof Sim['ix']['ver'])[]): boolean {
    return keys.some((k) => sim.ix.ver[k] !== this.seen[k]);
  }

  private sync(sim: Sim): void {
    const day = sim.day;
    if (this.changed(sim, 'terrain', 'farms', 'zones', 'buildings', 'roads', 'projects')) {
      paintTerrain(sim, this.terrainData);
      const m = sim.s.map;
      this.farmTiles = [];
      for (let t = 0; t < N * N; t++) if (m.farm[t] >= 0) this.farmTiles.push(t);
      this.terrainTex.needsUpdate = true;
      this.paintedDay = day;
    } else if (day !== this.paintedDay) {
      paintTerrain(sim, this.terrainData, this.farmTiles);
      this.terrainTex.needsUpdate = true;
      this.paintedDay = day;
    }
    const roadOverlay = this.overlay === 'traffic' || this.overlay === 'roads' || this.overlay === 'power' || this.overlay === 'water';
    if (this.changed(sim, 'roads') || this.overlay !== this.overlayKind || (roadOverlay && day !== this.overlayDay)) this.buildRoads(sim);
    if (this.changed(sim, 'buildings') || day !== this.builtDay) { this.buildBuildings(sim); this.builtDay = day; }
    if (this.changed(sim, 'terrain', 'zones', 'buildings')) this.buildTrees(sim);
    if (this.changed(sim, 'roads', 'zones', 'buildings')) this.buildLamps(sim);
    if (this.changed(sim, 'projects') || Math.abs(sim.s.minute - this.siteMinute) >= 60) { this.buildSites(sim); this.siteMinute = sim.s.minute; }
    if (this.overlay !== this.overlayKind || day !== this.overlayDay) {
      paintOverlay(sim, this.overlay, this.overlayData);
      this.overlayTex.magFilter = this.overlay === 'zoning' ? THREE.NearestFilter : THREE.LinearFilter;
      this.overlayTex.needsUpdate = true;
      this.overlayMesh.visible = this.overlay !== 'none';
      this.overlayKind = this.overlay;
      this.overlayDay = day;
    }
    if (day !== this.commuterDay || this.changed(sim, 'roads', 'buildings')) this.sampleCommuters(sim);
    this.routeCommuters(sim);
    const key = `${JSON.stringify(this.selection)}|${sim.ix.ver.buildings}|${sim.ix.ver.projects}|${sim.ix.ver.farms}`;
    if (key !== this.hlKey || this.frameNo % 30 === 0) { this.highlight(sim); this.hlKey = key; }
    for (const k of Object.keys(sim.ix.ver) as (keyof Sim['ix']['ver'])[]) this.seen[k] = sim.ix.ver[k];
  }

  // ------------------------------------------------------------------------------------------ static layers

  private buildRoads(sim: Sim): void {
    const m = sim.s.map;
    const coloured = this.overlay === 'traffic' || this.overlay === 'roads' || this.overlay === 'power' || this.overlay === 'water';
    this.roads.setMaterial(coloured ? this.roadFlat : this.roadMat);
    let count = 0;
    for (let t = 0; t < N * N; t++) if (m.road[t]) count++;
    this.roads.begin(count * 5);
    const WIDTH = [0, 0.34, 0.52, 0.66];
    for (let t = 0; t < N * N; t++) {
      const cls = m.road[t];
      if (!cls) continue;
      const x = (t % N) + 0.5, z = ((t / N) | 0) + 0.5;
      const bridge = m.terrain[t] === Terrain.Water;
      const y = bridge ? 0.05 : 0, h = bridge ? 0.06 : 0.035;
      const w = WIDTH[cls];
      const c = roadColor(sim, t, this.overlay);
      this.roads.add(x, y, z, w, h, w, 0, c);
      const tx = t % N, ty = (t / N) | 0;
      if (tx < N - 1 && m.road[t + 1]) this.roads.add(x + 0.25, y, z, 0.5, h, w, 0, c);
      if (tx > 0 && m.road[t - 1]) this.roads.add(x - 0.25, y, z, 0.5, h, w, 0, c);
      if (ty < N - 1 && m.road[t + N]) this.roads.add(x, y, z + 0.25, w, h, 0.5, 0, c);
      if (ty > 0 && m.road[t - N]) this.roads.add(x, y, z - 0.25, w, h, 0.5, 0, c);
    }
    this.roads.end();
  }

  /** How brightly a building's windows glow at night: lived in or open for business, and with electricity. */
  private lit(sim: Sim, b: Building): number {
    const on = b.pw ?? 1;
    if (b.units > 0) return b.occupants.length > 0 ? on : 0;
    const biz = b.biz >= 0 ? sim.biz(b.biz) : undefined;
    if (!biz || biz.status !== 'operating') return 0;
    const cat = BUILDINGS[b.kind].category;
    return (cat === 'industrial' ? 0.45 : 0.8) * on;
  }

  private buildBuildings(sim: Sim): void {
    const bs = sim.s.buildings;
    // buildings on fire, and smouldering ruins where a fire destroyed one in the last two days
    this.burning.length = 0;
    for (const b of bs) {
      if (!b.fire || b.fire <= 0 || b.kind === 'park') continue;
      const L = buildingLook(b);
      this.burning.push({ x: b.x + b.w / 2, z: b.y + b.h / 2, w: Math.max(0.4, Math.min(L.w, L.d)), h: Math.min(1.2, L.h + L.roofH * 0.5), seed: b.id });
    }
    const ev = sim.s.events;
    for (let k = ev.length - 1; k >= 0 && sim.day - ev[k].day <= 2; k--) {
      const e = ev[k];
      if (e.type === 'fire.destroyed' && e.ref?.k === 'tile') this.burning.push({ x: (e.ref.id % N) + 0.5, z: ((e.ref.id / N) | 0) + 0.5, w: 0.6, h: 0.06, seed: e.id });
    }
    let parts = 4 + this.burning.length;
    for (const b of bs) parts += PARTS[b.kind] ?? 0;
    this.walls.begin(bs.length + parts);
    this.gables.begin(bs.length + parts);
    this.flats.begin(bs.length + parts);
    this.extras.begin(bs.length + parts);
    this.spires.begin(parts);
    this.signs.begin(parts);
    this.bldPools.begin(parts);
    this.buildingIds.length = 0;
    this.turbines.length = 0;
    for (const f of this.burning) this.bldPools.add(f.x, 0.05, f.z, 2.2, 1, 2.2, 0, 0xff8a3a);
    const heritage = sim.preset.tourism.heritageStyle;
    for (const b of bs) {
      if (b.kind === 'park') continue;
      if (b.kind === 'airport') { this.airport(sim, b); continue; }
      if (b.kind === 'stadium') { this.stadium(sim, b); continue; }
      if (b.kind === 'heritage') { this.heritage(b, heritage); continue; }
      if (b.kind === 'solarfarm') { this.solarFarm(sim, b); continue; }
      if (b.kind === 'windfarm') { this.windFarm(sim, b); continue; }
      if (b.kind === 'substation') { this.substation(sim, b); continue; }
      if (b.kind === 'waterworks') { this.waterworks(sim, b); continue; }
      if (b.kind === 'firestation') { this.firestation(sim, b); continue; }
      const L = buildingLook(b);
      const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
      const small = b.kind === 'house' || b.kind === 'farmhouse' || b.kind === 'luxury';
      // hotels, cinemas and museums face the road they are reached from; small houses vary their orientation
      const faced = L.extra === 'sign' || L.extra === 'marquee' || L.extra === 'columns';
      const rot = faced ? frontRot(b) : small && hash01(b.style, 3) < 0.5 ? Math.PI / 2 : 0;
      const c = Math.cos(rot), s = Math.sin(rot);
      const at = (lx: number, lz: number): [number, number] => [cx + lx * c + lz * s, cz - lx * s + lz * c];
      const i = this.walls.add(cx, 0, cz, L.w, L.h, L.d, rot, L.wall, [this.lit(sim, b), L.floors]);
      if (i >= 0) this.buildingIds[i] = b.id;
      if (L.roof === 'gable') {
        // a museum shows its pediment to the street: the ridge runs front to back and the roof covers the portico
        if (L.extra === 'columns') { const [gx, gz] = at(0, 0.1); this.gables.add(gx, L.h, gz, L.d + 0.42, L.roofH, L.w + 0.08, rot + Math.PI / 2, L.roofColor); }
        else if (L.turned) this.gables.add(cx, L.h, cz, L.d + 0.06, L.roofH, L.w + 0.06, rot + Math.PI / 2, L.roofColor);
        else this.gables.add(cx, L.h, cz, L.w + 0.06, L.roofH, L.d + 0.06, rot, L.roofColor);
      } else this.flats.add(cx, L.h, cz, L.w + 0.02, L.roofH, L.d + 0.02, rot, L.roofColor);
      switch (L.extra) {
        case 'chimney': this.extras.add(cx + L.w * 0.32, 0, cz - L.d * 0.28, 0.12, L.h + 0.75, 0.12, 0, 0x8b8b8b); break;
        case 'silos': for (let k = 0; k < 3; k++) this.extras.add(b.x + 0.35 + k * 0.32, 0, b.y + b.h - 0.22, 0.26, 0.8, 0.26, 0, 0xd8d6cf); break;
        case 'tower': this.extras.add(cx, L.h, cz, 0.34, 0.36, 0.34, 0, 0xcdb88f); break;
        case 'stacks': { // gas plant: exhaust stacks beside the turbine hall, a fuel tank at the other end
          const long = b.w >= b.h;
          for (const k of [-1, 1]) {
            const [x, z] = long ? [b.x + b.w - 0.24, cz + k * 0.4] : [cx + k * 0.4, b.y + b.h - 0.24];
            this.extras.add(x, 0, z, 0.17, 1.2, 0.17, 0, 0xb9bdc1);
          }
          const [tx, tz] = long ? [b.x + 0.24, cz] : [cx, b.y + 0.24];
          this.extras.add(tx, 0, tz, 0.32, 0.34, 0.32, 0, 0xe2ded2);
          break;
        }
        case 'sign': { // hotel: an illuminated name board on the roof and a canopy over the entrance
          const [sx, sz] = at(0, L.d / 2 - 0.05);
          this.signs.add(sx, L.h + L.roofH + 0.01, sz, Math.min(0.5, L.w * 0.7), 0.11, 0.035, rot, SIGN_COLORS[Math.floor(hash01(b.style, 4) * SIGN_COLORS.length)]);
          const [ex, ez] = at(0, L.d / 2 + 0.06);
          this.flats.add(ex, 0.12, ez, 0.3, 0.025, 0.12, rot, 0x3a3a40);
          break;
        }
        case 'marquee': { // cinema: a canopy edged with bulbs and a vertical blade sign
          const [mx, mz] = at(0, L.d / 2 + 0.07);
          this.flats.add(mx, 0.15, mz, L.w * 0.84, 0.045, 0.15, rot, 0x2a2228);
          const [lx, lz] = at(0, L.d / 2 + 0.145);
          this.signs.add(lx, 0.15, lz, L.w * 0.84, 0.045, 0.012, rot, 0xffd060);
          const [bx, bz] = at(L.w / 2 - 0.1, L.d / 2 + 0.03);
          this.signs.add(bx, 0.21, bz, 0.035, 0.3, 0.12, rot, 0xff4f6a);
          this.bldPools.add(mx, 0.05, mz, 0.9, 1, 0.7, 0, 0xffd27a);
          break;
        }
        case 'columns': { // museum: a portico of columns on a flight of steps, under the pediment
          const front = L.d / 2;
          const [stx, stz] = at(0, front + 0.15);
          this.flats.add(stx, 0, stz, L.w * 0.94, 0.04, 0.3, rot, 0xd8d2c4);
          for (let k = 0; k < 6; k++) {
            const [px, pz] = at(-L.w * 0.4 + (k * L.w * 0.8) / 5, front + 0.18);
            this.extras.add(px, 0.04, pz, 0.1, L.h - 0.04, 0.1, 0, 0xf2ede2);
          }
          break;
        }
      }
    }
    this.walls.end(); this.gables.end(); this.flats.end(); this.extras.end(); this.spires.end(); this.signs.end(); this.bldPools.end();
  }

  /** A low perimeter fence around a plot. */
  private fence(b: Building, inset = 0.06, h = 0.06): void {
    const x0 = b.x + inset, x1 = b.x + b.w - inset, z0 = b.y + inset, z1 = b.y + b.h - inset, c = 0x8e9296;
    this.flats.add((x0 + x1) / 2, 0, z0, x1 - x0, h, 0.015, 0, c);
    this.flats.add((x0 + x1) / 2, 0, z1, x1 - x0, h, 0.015, 0, c);
    this.flats.add(x0, 0, (z0 + z1) / 2, 0.015, h, z1 - z0, 0, c);
    this.flats.add(x1, 0, (z0 + z1) / 2, 0.015, h, z1 - z0, 0, c);
  }

  /** The small control or inverter house that a click on a utility site hits, on the side facing its road. */
  private controlHouse(sim: Sim, b: Building, F: Frame, u: number, v: number): [number, number] {
    const L = buildingLook(b);
    const [x, z] = F.at(u, v), [sx, sz] = F.size(L.w, L.d);
    const i = this.walls.add(x, 0, z, sx, L.h, sz, 0, L.wall, [this.lit(sim, b), 1]);
    if (i >= 0) this.buildingIds[i] = b.id;
    this.flats.add(x, L.h, z, sx + 0.02, L.roofH, sz + 0.02, 0, L.roofColor);
    return [x, z];
  }

  /** Rows of panels tilted to the sun, an inverter house by the road and a fence. */
  private solarFarm(sim: Sim, b: Building): void {
    const F = frameOf(b);
    const [hx, hz] = this.controlHouse(sim, b, F, 0.42, 0.3);
    const tilt = this.qb.setFromAxisAngle(AX_X, 0.42);
    const rows = Math.max(2, Math.round((b.h - 0.3) / 0.46));
    const x0 = b.x + 0.16, x1 = b.x + b.w - 0.16;
    for (let k = 0; k < rows; k++) {
      const z = b.y + 0.3 + (k + 0.5) * ((b.h - 0.45) / rows);
      // rows stop short of the inverter house
      const segs: [number, number][] = Math.abs(z - hz) < 0.38 ? [[Math.min(x1, hx + 0.32), x1], [x0, Math.max(x0, hx - 0.32)]] : [[x0, x1]];
      for (const [a, c] of segs) {
        if (c - a < 0.2) continue;
        this.flats.addQ((a + c) / 2, 0.07, z, c - a, 0.018, 0.3, tilt, 0x29406a);
        this.flats.add((a + c) / 2, 0, z, c - a - 0.1, 0.07, 0.03, 0, 0x8a8f94);
      }
    }
    this.fence(b);
  }

  /** Three turbines on tall towers; their rotors are drawn every frame (see animate). */
  private windFarm(sim: Sim, b: Building): void {
    const F = frameOf(b);
    this.controlHouse(sim, b, F, 0.35, 0.28);
    const biz = b.biz >= 0 ? sim.biz(b.biz) : undefined;
    const on = !!biz && biz.status === 'operating' && biz.downDays <= 0 && biz.jobs.some((j) => j.worker >= 0);
    const yaw = windYaw(sim.day);
    const spots: [number, number][] = [[0.3, 0.72], [0.75, 0.36], [0.62, 0.84]];
    spots.forEach(([fu, fv], k) => {
      const x = b.x + fu * b.w, z = b.y + fv * b.h;
      const top = 1.55;
      this.extras.add(x, 0, z, 0.075, top, 0.075, 0, 0xeef1f3);
      this.flats.add(x, 0, z, 0.22, 0.03, 0.22, 0, 0xb4b8bc);
      this.flats.add(x, top - 0.02, z, 0.2, 0.075, 0.08, yaw, 0xe4e7ea);
      this.turbines.push({ x: x + Math.cos(yaw) * 0.12, y: top + 0.016, z: z - Math.sin(yaw) * 0.12, yaw, phase: hash01(b.id, k) * Math.PI * 2, on });
    });
  }

  /** Transformers and a gantry inside a fenced gravel yard, with a control room by the road. */
  private substation(sim: Sim, b: Building): void {
    const F = frameOf(b);
    this.controlHouse(sim, b, F, 0.3, 0.22);
    for (const [u, v] of [[0.35, 0.68], [0.7, 0.68]]) {
      const [x, z] = F.at(u, v);
      this.flats.add(x, 0, z, 0.16, 0.13, 0.13, 0, 0x6c7a68);
      this.extras.add(x, 0.13, z, 0.04, 0.08, 0.04, 0, 0xc9b98a);
    }
    for (const u of [0.16, 0.84]) { const [x, z] = F.at(u, 0.5); this.flats.add(x, 0, z, 0.025, 0.42, 0.025, 0, 0x9aa0a6); }
    const [gx, gz] = F.at(0.5, 0.5), [gw, gd] = F.size(0.72, 0.025);
    this.flats.add(gx, 0.4, gz, gw, 0.025, gd, 0, 0x9aa0a6);
    this.fence(b, 0.04, 0.08);
  }

  /** Treatment hall by the road, settling tanks and an elevated storage tank. */
  private waterworks(sim: Sim, b: Building): void {
    const F = frameOf(b);
    const L = buildingLook(b);
    const [x, z] = F.at(F.long / 2, 0.42), [sx, sz] = F.size(Math.min(1.25, F.long - 0.5), 0.5);
    const i = this.walls.add(x, 0, z, sx, L.h, sz, 0, L.wall, [this.lit(sim, b), 1]);
    if (i >= 0) this.buildingIds[i] = b.id;
    this.flats.add(x, L.h, z, sx + 0.02, L.roofH, sz + 0.02, 0, L.roofColor);
    for (const u of [F.long * 0.27, F.long * 0.73]) {
      const [tx, tz] = F.at(u, F.short - 0.5);
      this.extras.add(tx, 0, tz, 0.72, 0.09, 0.72, 0, 0xb9b6ad);
      this.extras.add(tx, 0.005, tz, 0.62, 0.09, 0.62, 0, 0x4f8fb3);
    }
    const [wx, wz] = F.at(F.long - 0.2, 0.3);
    this.extras.add(wx, 0, wz, 0.05, 0.62, 0.05, 0, 0x9aa0a6);
    this.extras.add(wx, 0.62, wz, 0.3, 0.2, 0.3, 0, 0xd6dde0);
  }

  /** A red station with its engine-bay doors facing the road and a drill tower at one end. */
  private firestation(sim: Sim, b: Building): void {
    const L = buildingLook(b);
    const rot = frontRot(b);
    const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
    const c = Math.cos(rot), s = Math.sin(rot);
    const at = (lx: number, lz: number): [number, number] => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    const i = this.walls.add(cx, 0, cz, L.w, L.h, L.d, rot, L.wall, [this.lit(sim, b), L.floors]);
    if (i >= 0) this.buildingIds[i] = b.id;
    this.flats.add(cx, L.h, cz, L.w + 0.02, L.roofH, L.d + 0.02, rot, L.roofColor);
    const bays = 3, span = L.w * 0.62;
    for (let k = 0; k < bays; k++) {
      const [dx, dz] = at(-L.w / 2 + 0.16 + (k + 0.5) * (span / bays), L.d / 2 + 0.006);
      this.flats.add(dx, 0, dz, span / bays - 0.05, 0.17, 0.015, rot, 0xe9e6df);
    }
    const [tx, tz] = at(L.w / 2 - 0.14, -L.d / 2 + 0.14);
    this.flats.add(tx, 0, tz, 0.2, 0.62, 0.2, rot, 0xb03a30);
    this.flats.add(tx, 0.62, tz, 0.23, 0.03, 0.23, rot, 0x6e2620);
    const [px, pz] = at(-0.1, L.d / 2 + 0.25);
    this.flats.add(px, 0, pz, L.w * 0.7, 0.012, 0.36, rot, 0x9c9a94);
  }

  /** Turbine rotors turn while the game runs, faster in a strong wind; fires flicker and smoke drifts downwind. */
  private animate(sim: Sim, dt: number): void {
    const running = sim.s.minute !== this.spinMinute;
    this.spinMinute = sim.s.minute;
    const wind = clamp((sim.s.util?.wind ?? 0.28) / 0.28, 0.25, 2.2);
    if (running) this.spin += dt * 0.0024 * wind;
    this.blades.begin(this.turbines.length * 3);
    for (const t of this.turbines) {
      this.qb.setFromAxisAngle(UP, t.yaw);
      const a = (t.on ? this.spin : 0) + t.phase;
      for (let k = 0; k < 3; k++) {
        this.qa.setFromAxisAngle(AX_X, a + (k * 2 * Math.PI) / 3).premultiply(this.qb);
        this.blades.addQ(t.x, t.y, t.z, 0.045, 0.5, 0.012, this.qa, 0xf4f6f7);
      }
    }
    this.blades.end();
    const now = performance.now() / 1000;
    const yaw = windYaw(sim.day), dx = Math.cos(yaw), dz = -Math.sin(yaw);
    this.flames.begin(this.burning.length * 3);
    this.smoke.begin(this.burning.length * 5);
    for (const f of this.burning) {
      const ruin = f.h < 0.1;
      if (!ruin) for (let k = 0; k < 3; k++) {
        const fl = 0.72 + 0.28 * Math.sin(now * (7 + k * 2.3) + f.seed + k * 1.7);
        const ox = (hash01(f.seed, k) - 0.5) * f.w * 0.6, oz = (hash01(f.seed, k + 7) - 0.5) * f.w * 0.6;
        this.flames.add(f.x + ox, f.h * 0.4, f.z + oz, 0.24 * fl, (0.32 + 0.14 * k) * fl, 0.24 * fl, now + k, k === 1 ? 0xffc040 : 0xff6a1a);
      }
      for (let k = 0; k < 5; k++) {
        const ph = (now * 0.16 + k / 5 + hash01(f.seed, 3)) % 1;
        const r = (ruin ? 0.08 : 0.14) + ph * (ruin ? 0.25 : 0.45);
        this.smoke.add(f.x + dx * ph * 0.9, f.h + 0.15 + ph * (ruin ? 0.8 : 1.5), f.z + dz * ph * 0.9, r, r, r, 0, ruin ? 0x77736c : 0x56524c);
      }
    }
    this.flames.end();
    this.smoke.end();
  }

  /** Runway with markings and edge lights, taxiway, apron, terminal, control tower and hangar. */
  private airport(sim: Sim, b: Building): void {
    const F = frameOf(b), L = F.long;
    const box = (layer: Layer, u: number, v: number, lu: number, lv: number, y: number, h: number, color: number, a?: number[]) => {
      const [x, z] = F.at(u, v), [sx, sz] = F.size(lu, lv);
      return layer.add(x, y, z, sx, h, sz, 0, color, a);
    };
    const asphalt = 0x3b3e43, taxiway = 0x50545a, paint = 0xe9e9e2;
    box(this.flats, L / 2, AP_RWY, L - 0.8, 0.9, 0, 0.03, asphalt);
    for (let u = 2.4; u <= L - 2.4; u += 0.9) box(this.flats, u, AP_RWY, 0.42, 0.045, 0, 0.034, paint);
    for (const u of [0.95, L - 0.95]) for (const dv of [-0.3, -0.18, 0.18, 0.3]) box(this.flats, u, AP_RWY + dv, 0.5, 0.07, 0, 0.034, paint);
    box(this.flats, L / 2, AP_TWY, L - 4.4, 0.3, 0, 0.026, taxiway);
    for (const u of [2.5, L / 2, L - 2.5]) box(this.flats, u, (AP_TWY + AP_RWY) / 2, 0.3, AP_RWY - AP_TWY, 0, 0.026, taxiway);
    box(this.flats, L / 2, 1.38, 8.4, 1.05, 0, 0.022, 0x9c9e9a);
    // the terminal is what a click on the airport hits
    const i = box(this.walls, L / 2, 0.5, 4.2, 0.72, 0, 0.32, 0xdfe6ea, [this.lit(sim, b), 2]);
    if (i >= 0) this.buildingIds[i] = b.id;
    box(this.flats, L / 2, 0.5, 4.32, 0.82, 0.32, 0.035, 0x9aa6ae);
    box(this.flats, L / 2 - 4.2, 0.4, 3, 0.6, 0, 0.012, 0x5d6066); // car park
    // control tower with a glazed cab
    box(this.extras, L / 2 + 4.6, 0.55, 0.3, 0.3, 0, 0.95, 0xd8dde0);
    box(this.signs, L / 2 + 4.6, 0.55, 0.44, 0.44, 0.95, 0.17, 0x6fb6d8);
    box(this.flats, L / 2 + 4.6, 0.55, 0.5, 0.5, 1.12, 0.03, 0x8a949a);
    // hangar
    box(this.flats, 5.4, 1.25, 2, 1.1, 0, 0.28, 0xb9c0c6);
    const [hx, hz] = F.at(5.4, 1.25);
    this.gables.add(hx, 0.28, hz, 2.04, 0.14, 1.14, F.horiz ? 0 : Math.PI / 2, 0x9aa3aa);
    // runway edge lights; green at the landing threshold, red at the far end
    for (let u = 1.2; u <= L - 1.2; u += 1.8) for (const dv of [-0.43, 0.43]) box(this.signs, u, AP_RWY + dv, 0.05, 0.05, 0, 0.04, 0xfff0c8);
    for (const dv of [-0.36, -0.18, 0, 0.18, 0.36]) {
      box(this.signs, 0.45, AP_RWY + dv, 0.06, 0.06, 0, 0.04, 0x5dff8a);
      box(this.signs, L - 0.45, AP_RWY + dv, 0.06, 0.06, 0, 0.04, 0xff5a4a);
    }
    const [px, pz] = F.at(L / 2, 1.38), [psx, psz] = F.size(9, 2.2);
    this.bldPools.add(px, 0.05, pz, psx, 1, psz, 0, 0xb8ad96);
  }

  /** Pitch, a covered main stand facing the road, open terraces and floodlight masts. */
  private stadium(sim: Sim, b: Building): void {
    const F = frameOf(b), L = F.long, S = F.short;
    const box = (layer: Layer, u: number, v: number, lu: number, lv: number, y: number, h: number, color: number, a?: number[]) => {
      const [x, z] = F.at(u, v), [sx, sz] = F.size(lu, lv);
      return layer.add(x, y, z, sx, h, sz, 0, color, a);
    };
    const seat = TEAM_COLORS[Math.floor(hash01(b.style, 5) * TEAM_COLORS.length)];
    const concrete = 0xc9c4ba, line = 0xeef2ea;
    const pu = L - 1.5, pv = S - 1.6, cu = L / 2, cv = S / 2;
    for (let k = 0; k < 6; k++) box(this.flats, cu - pu / 2 + (k + 0.5) * (pu / 6), cv, pu / 6, pv, 0, 0.02, k % 2 ? 0x57a84f : 0x4b9a45);
    box(this.flats, cu, cv - pv / 2 + 0.04, pu - 0.08, 0.02, 0, 0.023, line);
    box(this.flats, cu, cv + pv / 2 - 0.04, pu - 0.08, 0.02, 0, 0.023, line);
    box(this.flats, cu - pu / 2 + 0.04, cv, 0.02, pv - 0.08, 0, 0.023, line);
    box(this.flats, cu + pu / 2 - 0.04, cv, 0.02, pv - 0.08, 0, 0.023, line);
    box(this.flats, cu, cv, 0.02, pv - 0.08, 0, 0.023, line);
    // the main stand is what a click on the stadium hits
    const i = box(this.walls, cu, 0.42, L - 0.6, 0.62, 0, 0.34, 0xcfc9bd, [this.lit(sim, b), 2]);
    if (i >= 0) this.buildingIds[i] = b.id;
    box(this.flats, cu, 0.46, L - 0.5, 0.74, 0.34, 0.03, 0xe6e6e2);
    box(this.flats, cu, S - 0.42, L - 0.6, 0.62, 0, 0.14, concrete);
    box(this.flats, cu, S - 0.27, L - 0.6, 0.32, 0.14, 0.14, 0xc2bdb2);
    box(this.flats, cu, S - 0.58, L - 0.64, 0.28, 0.14, 0.012, seat);
    box(this.flats, cu, S - 0.27, L - 0.64, 0.3, 0.28, 0.012, seat);
    for (const u of [0.36, L - 0.36]) {
      box(this.flats, u, cv, 0.5, S - 1.5, 0, 0.18, concrete);
      box(this.flats, u, cv, 0.46, S - 1.56, 0.18, 0.012, seat);
    }
    const on = this.matchDay(sim, b);
    for (const [u, v] of [[0.12, 0.1], [L - 0.12, 0.1], [0.12, S - 0.1], [L - 0.12, S - 0.1]]) {
      box(this.extras, u, v, 0.07, 0.07, 0, 1, 0x9a9da2);
      box(on ? this.signs : this.flats, u, v, 0.2, 0.2, 1, 0.07, on ? 0xffffff : 0x8a8d92);
    }
    if (on) { const [x, z] = F.at(cu, cv), [sx, sz] = F.size(L + 0.6, S + 0.4); this.bldPools.add(x, 0.05, z, sx, 1, sz, 0, 0xfff4dc); }
  }

  /** Whether the stadium held an event today, read from its event counter, so the floodlights go on that evening. */
  private matchDay(sim: Sim, b: Building): boolean {
    const v = b.biz >= 0 ? sim.biz(b.biz)?.venue : undefined;
    if (!v) return false;
    const month = sim.date.month, seen = this.venueSeen.get(b.id);
    let day = seen?.day ?? -1;
    if (seen && (month !== seen.month ? v.events > 0 : v.events > seen.events)) day = sim.day;
    this.venueSeen.set(b.id, { month, events: v.events, day });
    return day === sim.day;
  }

  /** Heritage sites in the region's own style, weathering as their condition falls, and floodlit at night. */
  private heritage(b: Building, style: string): void {
    const rot = frontRot(b);
    const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
    const c = Math.cos(rot), s = Math.sin(rot);
    const age = clamp(1 - b.condition, 0, 1);
    const tint = (hex: number) => this.tmpColor.setHex(hex).lerp(WEATHERED, age * 0.5).getHex();
    const put = (layer: Layer, lx: number, lz: number, y: number, sx: number, h: number, sz: number, color: number, a?: number[]) =>
      layer.add(cx + lx * c + lz * s, y, cz - lx * s + lz * c, sx, h, sz, rot, tint(color), a);
    const pick = (i: number) => { if (i >= 0) this.buildingIds[i] = b.id; };
    switch (style) {
      case 'temple':
        put(this.flats, 0, 0, 0, 1.6, 0.06, 1.6, 0xc8b28a);
        put(this.flats, 0, -0.1, 0.06, 1.24, 0.06, 1.24, 0xbfa77c);
        pick(put(this.walls, 0, -0.2, 0.12, 0.62, 0.34, 0.62, 0xc9a777, [0, 0]));
        put(this.spires, 0, -0.2, 0.46, 0.68, 0.74, 0.68, 0xc29f6c);
        put(this.extras, 0, -0.2, 1.18, 0.07, 0.09, 0.07, 0xe0b040);
        put(this.flats, 0, 0.36, 0.12, 0.56, 0.2, 0.42, 0xcdb084);
        put(this.flats, 0, 0.36, 0.32, 0.64, 0.035, 0.5, 0xb89c70);
        for (const lx of [-0.24, 0.24]) put(this.extras, lx, 0.6, 0.12, 0.05, 0.2, 0.05, 0xd8c098);
        break;
      case 'pagoda': {
        put(this.flats, 0, 0, 0, 1.5, 0.06, 1.5, 0xb8ab90);
        let y = 0.06;
        // tiers narrow towards the top; eaves overhang little enough that each red storey shows beneath the next
        for (let k = 0; k < 4; k++) {
          const body = 0.66 - k * 0.12, eave = body + 0.18, hh = k === 0 ? 0.3 : 0.2;
          const i = put(k === 0 ? this.walls : this.flats, 0, 0, y, body, hh, body, 0xa8352a, k === 0 ? [0, 0] : undefined);
          if (k === 0) pick(i);
          y += hh;
          put(this.flats, 0, 0, y, eave, 0.035, eave, 0x46564a);
          y += 0.035;
        }
        put(this.spires, 0, 0, y, 0.14, 0.34, 0.14, 0xc9a040);
        break;
      }
      case 'castle': {
        const stone = 0x9c968a;
        pick(put(this.walls, 0, -0.12, 0, 0.66, 0.56, 0.6, stone, [0, 1]));
        put(this.flats, 0, -0.12, 0.56, 0.7, 0.04, 0.64, 0x8a8478);
        for (const [lx, lz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
          put(this.extras, lx, lz, 0, 0.3, 0.46, 0.3, stone);
          put(this.spires, lx, lz, 0.46, 0.36, 0.3, 0.36, 0x4a5160);
        }
        for (const [lx, lz, sx, sz] of [[0, -0.7, 1.3, 0.09], [0, 0.7, 1.3, 0.09], [-0.7, 0, 0.09, 1.3], [0.7, 0, 0.09, 1.3]]) put(this.flats, lx, lz, 0, sx, 0.26, sz, stone);
        put(this.flats, 0, 0.7, 0, 0.34, 0.34, 0.18, 0x8f897c);
        break;
      }
      case 'colonial': {
        const roof = 0x8c3b2e;
        pick(put(this.walls, 0, -0.1, 0, 1.4, 0.3, 0.72, 0xe8dcc0, [0, 2]));
        put(this.gables, 0, -0.1, 0.3, 1.46, 0.16, 0.78, roof);
        put(this.flats, 0, 0.42, 0.19, 1.36, 0.025, 0.26, roof);
        for (let k = 0; k < 5; k++) put(this.extras, -0.6 + k * 0.3, 0.52, 0, 0.035, 0.19, 0.035, 0xf0e8d8);
        put(this.flats, 0, 0.05, 0.3, 0.28, 0.36, 0.28, 0xe2d4b4);
        put(this.spires, 0, 0.05, 0.66, 0.36, 0.24, 0.36, roof);
        put(this.signs, 0, 0.192, 0.5, 0.13, 0.13, 0.01, 0xfff4d8);
        break;
      }
      default: { // hill fort: curtain walls with corner bastions, a gatehouse and a palace inside
        const stone = 0xb8a07a;
        for (const [lx, lz, sx, sz] of [[0, -0.72, 1.44, 0.11], [0, 0.72, 1.44, 0.11], [-0.72, 0, 0.11, 1.44], [0.72, 0, 0.11, 1.44]]) put(this.flats, lx, lz, 0, sx, 0.26, sz, stone);
        for (const [lx, lz] of [[-0.72, -0.72], [0.72, -0.72], [-0.72, 0.72], [0.72, 0.72]]) put(this.extras, lx, lz, 0, 0.32, 0.36, 0.32, 0xb09872);
        put(this.flats, 0, 0.72, 0, 0.38, 0.33, 0.2, 0xa89068);
        pick(put(this.walls, 0.1, -0.18, 0, 0.62, 0.4, 0.54, 0xc2ab86, [0, 1]));
        put(this.flats, 0.1, -0.18, 0.4, 0.66, 0.04, 0.58, 0xa89068);
      }
    }
    this.bldPools.add(cx, 0.05, cz, 2.4, 1, 2.4, 0, 0xffd9a0);
  }

  /** Street lamps along roads through built-up or zoned land, every other tile, alternating sides. */
  private buildLamps(sim: Sim): void {
    const m = sim.s.map;
    let roads = 0;
    for (let t = 0; t < N * N; t++) if (m.road[t]) roads++;
    this.posts.begin(roads);
    this.lampHeads.begin(roads);
    this.lampPools.begin(roads);
    const HALF = [0, 0.17, 0.26, 0.33];
    const road = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && m.road[y * N + x] > 0;
    const urbanAt = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= N || y >= N) return false;
      const t = y * N + x;
      if (URBAN.has(m.zone[t])) return true;
      const o = m.owner[t];
      const b = o >= 0 ? sim.bld(o) : undefined;
      return !!b && BUILDINGS[b.kind].category !== 'agricultural';
    };
    for (let t = 0; t < N * N; t++) {
      const cls = m.road[t];
      if (!cls || m.terrain[t] === Terrain.Water) continue;
      const tx = t % N, ty = (t / N) | 0;
      if ((tx + ty) % 2) continue;
      const ew = road(tx - 1, ty) || road(tx + 1, ty), ns = road(tx, ty - 1) || road(tx, ty + 1);
      if (ew && ns) continue; // junctions stay clear
      if (!urbanAt(tx, ty) && !urbanAt(tx - 1, ty) && !urbanAt(tx + 1, ty) && !urbanAt(tx, ty - 1) && !urbanAt(tx, ty + 1)) continue;
      const side = ((tx >> 1) + (ty >> 1)) % 2 ? 1 : -1;
      const off = (HALF[cls] + 0.07) * side;
      const x = tx + 0.5 + (ew ? 0 : off), z = ty + 0.5 + (ew ? off : 0);
      const h = cls === 3 ? 0.42 : 0.34;
      this.posts.add(x, 0, z, 0.03, h, 0.03, 0, 0x5c6066);
      this.lampHeads.add(x, h, z, 0.08, 0.025, 0.08, 0, 0xffe2a8);
      this.lampPools.add(x, 0.045, z, 1, 1, 1, 0, 0xffc47a);
    }
    this.posts.end(); this.lampHeads.end(); this.lampPools.end();
  }

  /** Aircraft on today's flights: approach, landing, taxiing, turnaround at the stands and take-off. */
  private planes(sim: Sim): void {
    const s = sim.s;
    this.planeBody.begin(24);
    this.planeTail.begin(24);
    const ap = s.air.routes.length ? s.buildings.find((b) => b.kind === 'airport') : undefined;
    if (ap) {
      const F = frameOf(ap);
      const tod = s.minute % 1440, day = sim.day;
      let k = 0;
      s.air.routes.forEach((r, ri) => {
        const n = flightsOn(r, day);
        const livery = LIVERY[hashStr(r.airline) % LIVERY.length];
        const scale = r.intl ? 0.8 : 0.66;
        for (let j = 0; j < n; j++) {
          const tA = 360 + ((j + 0.5) / n) * 840 + ri * 23 + (hash01(r.id * 31 + day, j) - 0.5) * 40;
          const p = planePose(F, tod, tA, tA + 55, k++ % 4);
          if (!p) continue;
          this.planeBody.add(p.x, p.y, p.z, scale, scale, scale, p.rot, 0xf2f4f6);
          this.planeTail.add(p.x, p.y, p.z, scale, scale, scale, p.rot, livery);
        }
      });
    }
    this.planeBody.end();
    this.planeTail.end();
  }

  private buildTrees(sim: Sim): void {
    const m = sim.s.map;
    this.trees.begin(9000);
    const look = TREES_BY_REGION[sim.s.meta.preset] ?? DEFAULT_TREES;
    const FOREST = look.forest, PARK = look.park;
    for (let t = 0; t < N * N; t++) {
      const tx = t % N, ty = (t / N) | 0;
      const o = m.owner[t];
      const bld = o >= 0 ? sim.bld(o) : undefined;
      let n = 0, palette = FOREST, big = 1;
      if (m.terrain[t] === Terrain.Forest && !m.road[t] && o < 0 && m.project[t] < 0) n = 2 + (hash01(t, 19) < 0.4 ? 1 : 0);
      else if ((m.zone[t] === Zone.Park || bld?.kind === 'park') && !m.road[t]) { n = 2; palette = PARK; big = 1.15; }
      else if (bld && (bld.kind === 'house' || bld.kind === 'luxury' || bld.kind === 'farmhouse') && hash01(t, 17) < 0.55) { n = 1; palette = PARK; big = 0.85; }
      for (let k = 0; k < n; k++) {
        let x = tx + 0.15 + hash01(t, 20 + k) * 0.7, z = ty + 0.15 + hash01(t, 30 + k) * 0.7;
        if (bld && bld.kind !== 'park') { x = tx + (hash01(t, 21) < 0.5 ? 0.12 : 0.88); z = ty + (hash01(t, 31) < 0.5 ? 0.12 : 0.88); }
        const h = (0.42 + 0.35 * hash01(t, 40 + k)) * big * look.h, r = (0.24 + 0.12 * hash01(t, 50 + k)) * big * look.r;
        this.trees.add(x, 0, z, r, h, r, 0, palette[Math.floor(hash01(t, 60 + k) * palette.length)]);
      }
    }
    this.trees.end();
  }

  private buildSites(sim: Sim): void {
    const ps = sim.s.projects.filter((p) => p.phase !== 'done' && p.phase !== 'cancelled' && p.phase !== 'staffing');
    let tiles = 0;
    for (const p of ps) tiles += p.tiles.length + 2;
    this.siteMark.begin(tiles);
    this.siteSolid.begin(ps.length);
    this.cranes.begin(ps.length * 2);
    for (const p of ps) {
      const prog = projectProgress(p);
      const building = p.phase === 'construction';
      if (p.kind === 'demolish') {
        p.tiles.forEach((t, k) => {
          const done = building && k / p.tiles.length < prog;
          this.siteMark.add((t % N) + 0.5, 0.005, ((t / N) | 0) + 0.5, 0.92, 0.05, 0.92, 0, done ? 0x9a8f80 : building ? 0xd8503a : 0xe8907a);
        });
        if (building && p.tiles.length) { // an excavator at work, its arm swinging
          const t = p.tiles[Math.floor(hash01(p.id, 3) * p.tiles.length)];
          const x = (t % N) + 0.5, z = ((t / N) | 0) + 0.5;
          const th = hash01(p.id, 5) * Math.PI * 2 + Math.sin(sim.s.minute * 0.01) * 0.8;
          this.cranes.add(x, 0, z, 0.22, 0.1, 0.14, th, 0xe6c229);
          this.cranes.add(x + 0.17 * Math.cos(th), 0.08, z - 0.17 * Math.sin(th), 0.3, 0.035, 0.035, th, 0x3a3a3a);
        }
        continue;
      }
      if (isRoadwork(p.kind)) {
        p.tiles.forEach((t, k) => {
          const done = building && k / p.tiles.length < prog;
          const x = (t % N) + 0.5, z = ((t / N) | 0) + 0.5;
          const color = p.kind === 'canal' ? (done ? 0x4a86a8 : 0x6fb0c8) : done ? 0x777a80 : building ? 0xe8912f : 0xf0b04a;
          this.siteMark.add(x, 0.005, z, 0.9, 0.05, 0.9, 0, color);
        });
        continue;
      }
      const L = lookFor(p.kind as BuildingKind, p.w, p.h, p.floors || 1, p.id);
      const cx = p.x + p.w / 2, cz = p.y + p.h / 2;
      if (!building) { this.siteMark.add(cx, 0.005, cz, p.w - 0.08, 0.04, p.h - 0.08, 0, 0xf0b04a); continue; }
      const hh = Math.max(0.04, L.h * prog);
      if (WHOLE[p.kind as BuildingKind]) this.siteMark.add(cx, 0.005, cz, p.w - 0.08, 0.04, p.h - 0.08, 0, 0xf0a030);
      this.siteSolid.add(cx, 0, cz, L.w, hh, L.d, 0, 0xb9b4aa);
      this.siteMark.add(cx, 0, cz, L.w + 0.07, L.h + 0.05, L.d + 0.07, 0, 0xf0a030);
      if (L.h > 0.45 || p.w >= 2) {
        const mx = p.x + 0.18, mz = p.y + 0.18, top = L.h + 0.5;
        const th = hash01(p.id, 7) * Math.PI * 2 + sim.s.minute * 0.0005;
        this.cranes.add(mx, 0, mz, 0.05, top, 0.05, 0, 0xe6c229);
        this.cranes.add(mx + 0.32 * Math.cos(th), top, mz - 0.32 * Math.sin(th), 0.95, 0.04, 0.04, th, 0xe6c229);
      }
    }
    this.siteMark.end(); this.siteSolid.end(); this.cranes.end();
  }

  // ------------------------------------------------------------------------------------------ vehicles

  private along(path: number[], f: number, lane: number): { x: number; z: number; rot: number } {
    const n = path.length;
    if (n === 1) return { x: (path[0] % N) + 0.5, z: ((path[0] / N) | 0) + 0.5, rot: 0 };
    const p = clamp(f, 0, 1) * (n - 1);
    const i = Math.min(n - 2, Math.floor(p)), t = p - i;
    const a = path[i], b = path[i + 1];
    const ax = (a % N) + 0.5, az = ((a / N) | 0) + 0.5, bx = (b % N) + 0.5, bz = ((b / N) | 0) + 0.5;
    const dx = bx - ax, dz = bz - az;
    const side = this.leftHand ? -1 : 1;
    return { x: ax + dx * t - dz * lane * side, z: az + dz * t + dx * lane * side, rot: Math.atan2(-dz, dx) };
  }

  private vehicles(sim: Sim): void {
    const s = sim.s, now = s.minute;
    this.trucks.begin(Math.min(1200, s.shipments.length * 3 + 8));
    this.truckIds.length = 0;
    this.truckXZ.length = 0;
    const addTruck = (path: number[], f: number, color: number, id: number) => {
      const p = this.along(path, f, 0.1);
      const bridge = s.map.terrain[path[Math.min(path.length - 1, Math.round(f * (path.length - 1)))]] === Terrain.Water ? 0.11 : 0;
      if (this.trucks.add(p.x, 0.035 + bridge, p.z, 0.2, 0.1, 0.1, p.rot, color) >= 0) { this.truckIds.push(id); this.truckXZ.push(p.x, p.z); }
    };
    for (const sh of s.shipments) {
      if (now < sh.depart || !sh.path.length || !sh.leg) continue;
      const el = now - sh.depart;
      const color = GOOD_COLORS[sh.good] ?? 0xcccccc;
      if (sh.carrier >= 0) {
        if (now > sh.arrive) continue;
        const w = el % (2 * sh.leg);
        addTruck(sh.path, w < sh.leg ? w / sh.leg : 1 - (w - sh.leg) / sh.leg, color, sh.id);
      } else {
        for (let j = 0; j < Math.min(3, sh.trucks); j++) {
          const f = (el - j * 4) / sh.leg;
          if (f >= 0 && f <= 1) addTruck(sh.path, f, color, sh.id);
        }
      }
    }
    this.trucks.end();
    const tod = now % 1440;
    const workday = sim.date.dow !== 0;
    this.cars.begin(this.commuters.length);
    this.carIds.length = 0;
    this.carXZ.length = 0;
    if (workday) {
      for (const c of this.commuters) {
        let f = -1;
        if (tod >= c.depart && tod <= c.depart + c.dur) f = (tod - c.depart) / c.dur;
        else if (tod >= c.ret && tod <= c.ret + c.dur) f = 1 - (tod - c.ret) / c.dur;
        if (f < 0) continue;
        const p = this.along(c.path, f, 0.1);
        const car = c.mode === 3;
        if (this.cars.add(p.x, 0.035, p.z, car ? 0.12 : 0.07, car ? 0.06 : 0.05, car ? 0.07 : 0.03, p.rot, c.color) >= 0) { this.carIds.push(c.id); this.carXZ.push(p.x, p.z); }
      }
    }
    this.cars.end();
  }

  /** Picks a representative sample of real motorised commuters to animate. */
  private sampleCommuters(sim: Sim): void {
    this.commuterDay = sim.day;
    const motor: number[] = [];
    for (const c of sim.s.citizens) if ((c.status === 'working' || c.status === 'owner') && (c.mode === 2 || c.mode === 3) && c.commute > 0) motor.push(c.id);
    const share = Math.min(1, 260 / Math.max(1, motor.length));
    this.carScale = 1 / share;
    this.commuterQueue = motor.filter((id) => hash01(id, 3) < share);
    this.commuters = [];
  }

  private routeCommuters(sim: Sim): void {
    let budget = 30;
    while (budget-- > 0 && this.commuterQueue.length) {
      const id = this.commuterQueue.pop()!;
      const c = sim.cit(id);
      if (!c) continue;
      const home = sim.homeOf(c), work = sim.workplaceOf(c);
      if (!home || !work || home.id === work.id || home.access < 0 || work.access < 0) continue;
      const path = findPath(sim, home.access, work.access);
      if (path.length < 2) continue;
      this.commuters.push({
        id, path, mode: c.mode, dur: Math.max(6, c.commute), color: CAR_COLORS[Math.floor(hash01(id, 5) * CAR_COLORS.length)],
        depart: 420 + hash01(id, 7) * 150, ret: 1020 + hash01(id, 9) * 150,
      });
    }
  }

  // ------------------------------------------------------------------------------------------ lighting

  private lighting(sim: Sim): void {
    const tod = (sim.s.minute % 1440) / 60;
    const day = tod >= 6 && tod <= 19;
    const e = day ? Math.sin((Math.PI * (tod - 6)) / 13) : -0.25;
    const az = Math.PI * clamp((tod - 6) / 13, 0, 1);
    const el = Math.max(0.05, e) * 1.2;
    const t = this.rig.target;
    const dir = this.v3.set(Math.cos(az) * Math.cos(el), Math.sin(el), 0.35 + Math.sin(az) * 0.2).normalize();
    this.sun.position.set(t.x + dir.x * 150, dir.y * 150, t.z + dir.z * 150);
    this.sun.target.position.set(t.x, 0, t.z);
    const sunUp = Math.max(0, e);
    // by night a cool moonlight keeps the town readable while lit windows show where people live
    const moon = sunUp <= 0.02;
    this.sun.intensity = moon ? 0.45 : Math.pow(sunUp, 0.6) * 2.6;
    if (moon) this.sun.color.setHex(0x8fa8d8);
    else this.sun.color.setHex(0xffb070).lerp(new THREE.Color(0xfff4e0), Math.min(1, sunUp * 2.5));
    this.hemi.intensity = 0.42 + 0.4 * Math.min(1, sunUp * 2);
    this.hemi.color.setHex(moon ? 0x9fb4e0 : 0xcfe3ff);
    const rain = Math.min(1, sim.s.weather.rain / 20);
    const dayCol = new THREE.Color(0x9fc4e8).lerp(new THREE.Color(0x8d949c), rain * 0.7);
    const dusk = new THREE.Color(0xe8a070);
    const nightCol = new THREE.Color(0x0b1224);
    let sky: THREE.Color;
    if (e <= 0) sky = nightCol.clone().lerp(new THREE.Color(0x1d2c4a), 0.5);
    else if (e < 0.25) sky = nightCol.clone().lerp(dusk, e / 0.25).lerp(dayCol, Math.max(0, (e - 0.1) / 0.15));
    else sky = dayCol;
    this.scene.background = sky;
    this.fog.color.copy(sky);
    const d = this.rig.distance;
    this.fog.near = d * 2.2 + 40;
    this.fog.far = d * 7 + 260 - rain * 120;
    this.night.value = clamp((0.15 - e) / 0.3, 0, 1);
    this.renderer.toneMappingExposure = 1.05 - rain * 0.15;
    // lamps, signs and runway lights come on at dusk and throw pools of light on the ground
    const n = this.night.value;
    this.glowMat.color.setScalar(0.7 + 1.3 * n);
    this.poolMat.opacity = 0.45 * n;
    this.lampPools.mesh.visible = this.bldPools.mesh.visible = n > 0.02;
  }

  // ------------------------------------------------------------------------------------------ selection & tools

  private highlight(sim: Sim): void {
    const sel = this.selection;
    this.marks.begin(400);
    this.edges.visible = false;
    const outline = (b: Building | undefined) => {
      if (!b) return;
      if (b.kind === 'park') { for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) this.marks.add(x + 0.5, 0.01, y + 0.5, 0.96, 0.04, 0.96, 0, 0xffffff); return; }
      // sites laid out across their whole footprint are outlined by it
      const hh = WHOLE[b.kind];
      if (hh !== undefined) {
        this.edges.position.set(b.x + b.w / 2, 0, b.y + b.h / 2);
        this.edges.scale.set(b.w - 0.08, hh, b.h - 0.08);
        this.edges.visible = true;
        return;
      }
      const L = buildingLook(b);
      this.edges.position.set(b.x + b.w / 2, 0, b.y + b.h / 2);
      this.edges.scale.set(L.w + 0.1, L.h + L.roofH + 0.06, L.d + 0.1);
      this.edges.visible = true;
    };
    const tileMark = (t: number, color = 0xffffff) => this.marks.add((t % N) + 0.5, 0.01, ((t / N) | 0) + 0.5, 0.96, 0.05, 0.96, 0, color);
    if (sel && 'ref' in sel) {
      const r = sel.ref;
      switch (r.k) {
        case 'building': outline(sim.bld(r.id)); break;
        case 'business': {
          const b = sim.biz(r.id);
          if (b?.farm) for (const t of b.farm.fields.slice(0, 380)) tileMark(t, 0xfff2a0);
          outline(b ? sim.bld(b.building) : undefined);
          break;
        }
        case 'project': { const p = sim.ix.proj.get(r.id); if (p) for (const t of p.tiles.slice(0, 380)) tileMark(t, 0xffc060); break; }
        case 'tile': tileMark(r.id); break;
        case 'citizen': {
          const c = sim.cit(r.id);
          if (c) {
            outline(sim.homeOf(c));
            const w = sim.workplaceOf(c);
            if (w) for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) tileMark(y * N + x, 0x9fd0ff);
          }
          break;
        }
        case 'household': { const h = sim.hh(r.id); if (h && h.home >= 0) outline(sim.bld(h.home)); break; }
      }
    }
    this.marks.end();
  }

  private tileAt(e: PointerEvent): number {
    const g = this.rig.groundAt(e.clientX, e.clientY);
    if (!g) return -1;
    const x = Math.floor(g.x), y = Math.floor(g.z);
    return x >= 0 && y >= 0 && x < N && y < N ? y * N + x : -1;
  }

  private onDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || e.ctrlKey || e.altKey) return;
    if (this.tool.mode === 'road' || this.tool.mode === 'zone' || this.tool.mode === 'bulldoze') {
      const t = this.tileAt(e);
      if (t < 0) return;
      this.pendingTiles = null;
      this.dragFrom = t;
      this.dragging = true;
      this.canvas.setPointerCapture?.(e.pointerId);
    }
  };

  private onMove = (e: PointerEvent) => { this.hover = this.tileAt(e); };

  private onLeave = () => { if (!this.dragging) this.hover = -1; };

  private onUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const sim = this.opts.getSim();
    if (this.dragging) {
      this.dragging = false;
      const tiles = this.dragTiles(sim);
      if (!tiles.length) return;
      this.pendingTiles = tiles;
      if (this.tool.mode === 'road') this.events.route(tiles);
      else if (this.tool.mode === 'zone') this.events.zone(tiles);
      else if (this.tool.mode === 'bulldoze') this.events.demolish(tiles);
      return;
    }
    if (e.target !== this.canvas) return;
    const click = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 6 && !this.rig.moved;
    if (!click) return;
    if (this.tool.mode === 'build') {
      const t = this.tileAt(e);
      if (t < 0) return;
      this.pendingBuild = { x: t % N, y: (t / N) | 0, ok: this.hoverOk };
      this.events.place(t % N, (t / N) | 0);
    } else if (this.tool.mode === 'inspect') {
      const sel = this.pick(e.clientX, e.clientY, sim);
      this.selection = sel;
      this.hlKey = '';
      this.rig.follow = null;
      if (sel && 'vehicle' in sel) this.follow(sel);
      this.events.select(sel);
    }
  };

  private dragTiles(sim: Sim): number[] {
    if (this.dragFrom < 0 || this.hover < 0) return [];
    const ax = this.dragFrom % N, ay = (this.dragFrom / N) | 0, bx = this.hover % N, by = (this.hover / N) | 0;
    if (this.tool.mode === 'road') return routeTiles(ax, ay, bx, by);
    if (this.tool.mode === 'zone') return rectTiles(ax, ay, bx, by).filter((t) => zoneable(sim, t));
    if (this.tool.mode === 'bulldoze') return demolishTarget(sim, this.dragFrom, this.hover);
    return [];
  }

  /** Vehicles first (screen distance), then buildings (ray), then the ground tile. */
  pick(clientX: number, clientY: number, sim: Sim): Selection | null {
    const r = this.canvas.getBoundingClientRect();
    let best: Selection | null = null, bd = 13 * 13;
    const test = (ids: number[], xz: number[], kind: 'truck' | 'car') => {
      for (let i = 0; i < ids.length; i++) {
        this.v3.set(xz[i * 2], 0.08, xz[i * 2 + 1]).project(this.rig.camera);
        if (this.v3.z > 1) continue;
        const sx = ((this.v3.x + 1) / 2) * r.width + r.left, sy = ((1 - this.v3.y) / 2) * r.height + r.top;
        const d = (sx - clientX) ** 2 + (sy - clientY) ** 2;
        if (d < bd) { bd = d; best = { vehicle: kind, id: ids[i] }; }
      }
    };
    test(this.truckIds, this.truckXZ, 'truck');
    test(this.carIds, this.carXZ, 'car');
    if (best) return best;
    const ray = this.rig.rayAt(clientX, clientY);
    const hits = ray.intersectObject(this.walls.mesh, false);
    if (hits.length && hits[0].instanceId !== undefined) {
      const id = this.buildingIds[hits[0].instanceId];
      if (id !== undefined && sim.bld(id)) {
        const b = sim.bld(id)!;
        return b.biz >= 0 && sim.biz(b.biz) ? { ref: { k: 'business', id: b.biz } } : { ref: { k: 'building', id } };
      }
    }
    const g = this.rig.groundAt(clientX, clientY);
    if (!g) return null;
    const x = Math.floor(g.x), y = Math.floor(g.z);
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    return { ref: refAtTile(sim, y * N + x) };
  }

  private tools(sim: Sim): void {
    const tool = this.tool;
    // hovered tile outline
    if (this.hover >= 0 && tool.mode !== 'build') {
      this.hoverLine.position.set(this.hover % N, 0.04, (this.hover / N) | 0);
      this.hoverLine.visible = true;
    } else this.hoverLine.visible = false;
    // building ghost
    this.ghost.visible = false;
    if (tool.mode === 'build') {
      const spec = BUILDINGS[tool.kind];
      const w = tool.rot ? spec.h : spec.w, h = tool.rot ? spec.w : spec.h;
      const at = this.pendingBuild ?? (this.hover >= 0 ? { x: this.hover % N, y: (this.hover / N) | 0, ok: false } : null);
      if (at) {
        const key = `${tool.kind}:${tool.rot ? 1 : 0}:${at.x}:${at.y}:${sim.ix.ver.buildings}:${sim.ix.ver.projects}`;
        if (key !== this.hoverKey) { this.hoverKey = key; this.hoverOk = previewBuilding(sim, tool.kind, at.x, at.y, tool.floors, !!tool.rot).ok; }
        const L = lookFor(tool.kind, w, h, tool.floors ?? spec.floors[0], 1);
        this.ghost.position.set(at.x + w / 2, 0, at.y + h / 2);
        this.ghost.scale.set(w - 0.08, Math.max(0.1, L.h + L.roofH), h - 0.08);
        this.ghostMat.color.setHex(this.hoverOk ? 0x55cc77 : 0xe05050);
        this.ghost.visible = true;
      }
    }
    // route / zone preview
    let tiles: number[] | null = null, ok = true, color = 0x55cc77;
    if (this.dragging && (tool.mode === 'road' || tool.mode === 'zone' || tool.mode === 'bulldoze')) {
      tiles = this.dragTiles(sim);
      if (tool.mode === 'road') {
        const key = `r:${this.dragFrom}:${this.hover}:${tool.kind}`;
        if (key !== this.hoverKey) { this.hoverKey = key; this.hoverOk = previewRoad(sim, tool.kind, tiles).ok; }
        ok = this.hoverOk;
      }
    } else if (this.pendingTiles) tiles = this.pendingTiles;
    else if (tool.mode === 'bulldoze' && this.hover >= 0) tiles = demolishTarget(sim, this.hover, this.hover);
    if (tool.mode === 'bulldoze' && tiles && tiles.length) {
      // red where the bulldozer may go, grey where it may not (heritage, the highway, a building's only road)
      const key = `d:${tiles[0]}:${tiles[tiles.length - 1]}:${tiles.length}:${sim.ix.ver.buildings}:${sim.ix.ver.projects}:${sim.ix.ver.roads}`;
      if (key !== this.hoverKey) { this.hoverKey = key; this.hoverOk = previewDemolish(sim, tiles).ok; }
      ok = this.hoverOk;
      const o = sim.s.map.owner[tiles[0]];
      const b = o >= 0 ? sim.bld(o) : undefined;
      if (b) {
        const L = buildingLook(b);
        const hgt = WHOLE[b.kind] ?? (b.kind === 'park' ? 0.1 : Math.max(0.12, L.h + L.roofH + 0.04));
        this.ghost.position.set(b.x + b.w / 2, 0, b.y + b.h / 2);
        this.ghost.scale.set(b.w - 0.04, hgt, b.h - 0.04);
        this.ghostMat.color.setHex(ok ? 0xe0503c : 0x8a8f96);
        this.ghost.visible = true;
      }
    }
    if (tool.mode === 'zone') {
      const c = ZONE_RGB[tool.zone];
      if (c) color = (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
    } else if (tool.mode === 'bulldoze') color = ok ? 0xe0503c : 0x8a8f96;
    else if (!ok) color = 0xe05050;
    else color = this.pendingTiles && !this.dragging ? this.pendingColor : 0x55cc77;
    this.preview.begin(tiles ? tiles.length : 0);
    if (tiles) for (const t of tiles) this.preview.add((t % N) + 0.5, 0.02, ((t / N) | 0) + 0.5, 0.94, 0.06, 0.94, 0, color);
    this.preview.end();
  }
}

export type { Overlay, CameraPreset };

// Camera rig: an orbiting camera around a target on the ground. Left-drag pans (unless a tool uses the drag),
// right-drag (or Ctrl/Alt + left) rotates, wheel/pinch zooms, WASD/arrows pan, Q/E rotate, R/F tilt.

import * as THREE from 'three';

export type CameraPreset = 'strategic' | 'city' | 'street';

const PRESETS: Record<CameraPreset, { dist: number; pitch: number }> = {
  strategic: { dist: 150, pitch: 1.25 },
  city: { dist: 55, pitch: 0.85 },
  street: { dist: 6, pitch: 0.22 },
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(64, 0, 64);
  dist = 70;
  yaw = 0.6;
  pitch = 0.9;
  // smoothed values actually applied to the camera
  private cur = { x: 64, z: 64, dist: 70, yaw: 0.6, pitch: 0.9 };
  follow: (() => THREE.Vector3 | null) | null = null;
  /** When true the left mouse button is used by a tool and does not pan. */
  toolDrag = false;
  private keys = new Set<string>();
  private drag: { mode: 'pan' | 'orbit'; x: number; y: number; ground: THREE.Vector3 | null } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  moved = false; // true if the current pointer gesture moved the camera (suppresses clicks)

  constructor(private el: HTMLElement, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 3000);
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    this.apply(true);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  preset(p: CameraPreset): void {
    this.dist = PRESETS[p].dist;
    this.pitch = PRESETS[p].pitch;
  }

  flyTo(x: number, z: number, dist?: number): void {
    this.follow = null;
    this.target.set(x, 0, z);
    if (dist !== undefined) this.dist = dist;
  }

  /** Jumps straight to the current target without easing. */
  snap(): void { this.apply(true); }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Ground point under a client position. */
  groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.plane, p) ? p : null;
  }

  rayAt(clientX: number, clientY: number): THREE.Raycaster {
    const r = this.el.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.ray;
  }

  private onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = false;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      this.drag = null;
      return;
    }
    const orbit = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.altKey));
    if (e.button === 0 && !orbit && this.toolDrag) return;
    if (e.button !== 0 && e.button !== 2) return;
    this.drag = { mode: orbit ? 'orbit' : 'pan', x: e.clientX, y: e.clientY, ground: orbit ? null : this.groundAt(e.clientX, e.clientY) };
  };

  private onMove = (e: PointerEvent) => {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.pinch > 0) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.dist = clamp(this.dist * (this.pinch / Math.max(1, d)), 3, 260);
      this.pinch = d;
      this.moved = true;
      return;
    }
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true;
    if (this.drag.mode === 'orbit') {
      this.yaw -= dx * 0.006;
      this.pitch = clamp(this.pitch + dy * 0.005, 0.1, 1.48);
      this.drag.x = e.clientX; this.drag.y = e.clientY;
    } else if (this.drag.ground) {
      // keep the grabbed ground point under the cursor
      this.apply(true);
      const g = this.groundAt(e.clientX, e.clientY);
      if (g) {
        this.target.x += this.drag.ground.x - g.x;
        this.target.z += this.drag.ground.z - g.z;
        this.clampTarget();
        this.follow = null;
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
    this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const f = Math.pow(1.0015, e.deltaY);
    // zoom towards the point under the cursor
    const before = this.groundAt(e.clientX, e.clientY);
    this.dist = clamp(this.dist * f, 3, 260);
    if (before && !this.follow) {
      const k = 1 - f;
      this.target.x += (before.x - this.target.x) * k * 0.6;
      this.target.z += (before.z - this.target.z) * k * 0.6;
      this.clampTarget();
    }
  };

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    this.keys.add(e.key.toLowerCase());
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };

  private clampTarget(): void {
    this.target.x = clamp(this.target.x, -8, 136);
    this.target.z = clamp(this.target.z, -8, 136);
  }

  update(dtMs: number): void {
    const k = this.keys;
    const dt = Math.min(dtMs, 100) / 1000;
    const speed = Math.max(4, this.dist) * 0.9 * dt;
    let fx = 0, fz = 0;
    if (k.has('w') || k.has('arrowup')) fz -= 1;
    if (k.has('s') || k.has('arrowdown')) fz += 1;
    if (k.has('a') || k.has('arrowleft')) fx -= 1;
    if (k.has('d') || k.has('arrowright')) fx += 1;
    if (fx || fz) {
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      this.target.x += (fx * c + fz * s) * speed;
      this.target.z += (-fx * s + fz * c) * speed;
      this.clampTarget();
      this.follow = null;
    }
    if (k.has('q')) this.yaw += 1.4 * dt;
    if (k.has('e')) this.yaw -= 1.4 * dt;
    if (k.has('r')) this.pitch = clamp(this.pitch + 0.9 * dt, 0.1, 1.48);
    if (k.has('f')) this.pitch = clamp(this.pitch - 0.9 * dt, 0.1, 1.48);
    if (k.has('=') || k.has('+')) this.dist = clamp(this.dist * (1 - 1.2 * dt), 3, 260);
    if (k.has('-')) this.dist = clamp(this.dist * (1 + 1.2 * dt), 3, 260);
    if (this.follow) {
      const p = this.follow();
      if (p) this.target.set(p.x, 0, p.z);
    }
    this.apply(false, dt);
  }

  private apply(snap: boolean, dt = 0.016): void {
    const c = this.cur;
    const a = snap ? 1 : 1 - Math.exp(-dt * (this.follow ? 10 : 12));
    c.x += (this.target.x - c.x) * a;
    c.z += (this.target.z - c.z) * a;
    c.dist += (this.dist - c.dist) * a;
    c.yaw += (this.yaw - c.yaw) * a;
    c.pitch += (this.pitch - c.pitch) * a;
    const cp = Math.cos(c.pitch);
    this.camera.position.set(c.x + Math.sin(c.yaw) * cp * c.dist, Math.max(0.35, Math.sin(c.pitch) * c.dist), c.z + Math.cos(c.yaw) * cp * c.dist);
    this.camera.lookAt(c.x, 0, c.z);
  }

  get distance(): number { return this.cur.dist; }
}

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// The 3D Stem Player. Plain three.js held outside React's render cycle, the same
// way useAudioMixer holds the audio graph: React pushes state in, the scene calls
// back out, and nothing here re-renders the tree. It also only draws while
// something is moving, so an idle device costs no frames during playback.
//
// POINTER MODEL — deliberate, don't split it up:
// The canvas is one surface, so there is exactly one `gesture` at a time, and
// where it starts decides what it is. Starting on a groove, a drag sets that
// stem's level. Starting anywhere else, including on an edge button, a drag
// turns the device, which then stays exactly where it was released. That makes
// "turned the device while changing a volume" impossible.

export const ARM_STEM = { N: "vocals", E: "drums", S: "instrumental", W: "bass" };
const ARMS = Object.keys(ARM_STEM);
const BUTTONS = ["Btn_Center", "Btn_Dots", "Btn_Volume", "Btn_Load"];
const LEDS_PER_ARM = 4;

const FOV = 26;
// Half the frame height, in metres, kept clear around the 70 mm body.
const FRAME_RADIUS = 0.048;

const TAP_SLOP_PX = 5;
const HOLD_MS = 450;
// How far along a groove counts as its outer end, where a hold solos the stem.
const SOLO_ZONE_START = 0.6;
const TURN_RAD_PER_PX = 0.009;
const PRESS_DEPTH = 0.0008;
const PRESS_RATE = 26;
const LED_RATE = 18;

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Top face to the camera, then lean so the SE edge buttons come into view. */
function homePose() {
  const faceCamera = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2
  );
  const lean = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(-1, -1, 0).normalize(),
    0.52
  );
  return lean.multiply(faceCamera);
}

// A hot core fading through the stem colour, the way these LEDs read through the
// silicone skin.
function ledTexture(hex) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.2, hex);
  grad.addColorStop(0.46, `${hex}4d`);
  grad.addColorStop(0.8, `${hex}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function parseModel(buffer) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", resolve, reject);
  });
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ArrayBuffer} modelBytes  the .glb
 * @param {Record<string, string>} stemColors  stem name -> #rrggbb
 * @param {object} actions  onTap(partName, side?) · onGrooveTap(stem) ·
 *   onGrooveHold(stem) · getStemVolume(stem) · onGrooveDrag(stem, volume) ·
 *   onHover(partName | stem | null)
 */
export async function createDeviceScene(canvas, modelBytes, stemColors, actions) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 2);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;
  pmrem.dispose();

  const key = new THREE.DirectionalLight(0xfff1e2, 1.25);
  key.position.set(-0.5, 0.9, 1);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe8ff, 0.35);
  rim.position.set(0.9, -0.5, 0.2);
  scene.add(rim);

  const gltf = await parseModel(modelBytes);
  const root = new THREE.Group();
  root.add(gltf.scene);
  scene.add(root);

  root.quaternion.copy(homePose());

  // --- parts ---------------------------------------------------------------
  const textures = [];
  const leds = [];
  const arms = {}; // arm -> { stem, axis, travel, hit, sideTop }
  for (const arm of ARMS) {
    const stem = ARM_STEM[arm];
    const map = ledTexture(stemColors[stem]);
    textures.push(map);

    const meshes = [];
    for (let i = 1; i <= LEDS_PER_ARM; i++) {
      const mesh = gltf.scene.getObjectByName(`LED_${arm}_${i}`);
      mesh.material = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      mesh.renderOrder = 1;
      const led = { mesh, target: 0 };
      leds.push(led);
      meshes.push(led);
    }

    const inner = meshes[0].mesh.position;
    const outer = meshes[LEDS_PER_ARM - 1].mesh.position;
    const span = new THREE.Vector3().subVectors(outer, inner);
    span.y = 0;
    const pitch = span.length() / (LEDS_PER_ARM - 1);
    const hit = gltf.scene.getObjectByName(`Hit_${arm}`);
    // Raycast-only. Facing is decided by faces(), not by the strip's winding.
    hit.material = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
    hit.userData.part = { kind: "groove", stem };
    arms[stem] = {
      mesh: hit,
      axis: span.normalize(),
      innerAlong: inner.dot(span),
      travel: pitch * LEDS_PER_ARM,
      leds: meshes,
      surfaceY: (inner.y + outer.y) / 2,
    };
  }

  const buttons = BUTTONS.map((name) => {
    const mesh = gltf.scene.getObjectByName(name);
    const rest = mesh.position.clone();
    const outward =
      name === "Btn_Center"
        ? Y_AXIS.clone()
        : new THREE.Vector3().fromArray(mesh.userData.press_dir).negate();
    mesh.userData.part = { kind: "button", name, outward };
    return { mesh, name, rest, outward, depth: 0, target: 0 };
  });
  const pickable = [...Object.values(arms).map((a) => a.mesh), ...buttons.map((b) => b.mesh)];

  // --- render loop ---------------------------------------------------------
  let raf = 0;
  let lastFrame = 0;

  const invalidate = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  function stepLeds(dt) {
    let busy = false;
    const ease = 1 - Math.exp(-dt * LED_RATE);
    for (const led of leds) {
      const m = led.mesh.material;
      const delta = led.target - m.opacity;
      if (Math.abs(delta) < 0.004) {
        m.opacity = led.target;
        continue;
      }
      m.opacity += delta * ease;
      busy = true;
    }
    return busy;
  }

  function stepButtons(dt) {
    let busy = false;
    const ease = 1 - Math.exp(-dt * PRESS_RATE);
    for (const b of buttons) {
      const delta = b.target - b.depth;
      if (Math.abs(delta) < 0.002) {
        if (b.depth !== b.target) b.depth = b.target;
      } else {
        b.depth += delta * ease;
        busy = true;
      }
      b.mesh.position.copy(b.rest).addScaledVector(b.outward, -b.depth * PRESS_DEPTH);
    }
    return busy;
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : 0.016);
    lastFrame = now;
    const a = stepLeds(dt);
    const b = stepButtons(dt);
    renderer.render(scene, camera);
    if (a || b) invalidate();
    else lastFrame = 0;
  }

  function rotate(dx, dy) {
    const angle = Math.hypot(dx, dy);
    if (!angle) return;
    const axis = new THREE.Vector3(dy, dx, 0).normalize();
    root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  }

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas.parentElement;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const fitWidth = Math.min(1, camera.aspect);
    camera.position.set(0, 0, FRAME_RADIUS / (halfHeight * fitWidth));
    camera.updateProjectionMatrix();
    invalidate();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.parentElement);

  // --- picking -------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function setRay(e) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    root.updateMatrixWorld(true);
    raycaster.setFromCamera(ndc, camera);
  }

  // Which way a part faces the camera; a part on the far side of the body is
  // never a valid hit, even though the ray passes straight through to it.
  function faces(part) {
    const normal = part.kind === "button" ? part.outward : Y_AXIS;
    const world = normal.clone().applyQuaternion(root.quaternion);
    return world.z > 0.12;
  }

  function pick(e) {
    setRay(e);
    for (const hit of raycaster.intersectObjects(pickable, false)) {
      const part = hit.object.userData.part;
      if (faces(part)) return { part, point: hit.point };
    }
    return null;
  }

  function surfacePoint(e, arm) {
    setRay(e);
    const plane = new THREE.Plane(Y_AXIS.clone(), -arm.surfaceY);
    plane.applyMatrix4(root.matrixWorld);
    const out = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return out ? root.worldToLocal(out) : null;
  }

  // Which end of an edge pill a hit landed on, as seen from outside the device.
  function pillSide(part, worldPoint) {
    const local = root.worldToLocal(worldPoint.clone());
    const rest = buttons.find((b) => b.name === part.name).rest;
    const right = part.outward.clone().negate().cross(Y_AXIS);
    return local.sub(rest).dot(right) > 0 ? "right" : "left";
  }

  // --- gesture -------------------------------------------------------------
  let gesture = null;

  function endGesture() {
    clearTimeout(gesture.holdTimer);
    if (gesture.button) gesture.button.target = 0;
    try {
      canvas.releasePointerCapture(gesture.id);
    } catch {
      /* noop */
    }
    gesture = null;
    invalidate();
  }

  function onDown(e) {
    if (gesture || e.button !== 0) return;
    const hit = pick(e);
    gesture = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startT: e.timeStamp,
      moved: false,
      held: false,
      hit,
      button: null,
      holdTimer: 0,
    };
    canvas.setPointerCapture(e.pointerId);

    const part = hit && hit.part;
    if (part && part.kind === "button") {
      gesture.button = buttons.find((b) => b.name === part.name);
      gesture.button.target = 1;
      invalidate();
    }
    if (part && part.kind === "groove") {
      gesture.arm = arms[part.stem];
      gesture.startVolume = actions.getStemVolume(part.stem);
      const start = surfacePoint(e, gesture.arm);
      gesture.startAlong = start ? start.dot(gesture.arm.axis) : 0;
      const alongArm = (gesture.startAlong - gesture.arm.innerAlong) / gesture.arm.travel;
      if (alongArm >= SOLO_ZONE_START) {
        gesture.holdTimer = setTimeout(() => {
          if (!gesture || gesture.moved) return;
          gesture.held = true;
          actions.onGrooveHold(part.stem);
        }, HOLD_MS);
      }
    }
  }

  function onMove(e) {
    if (!gesture) {
      const hit = pick(e);
      const part = hit && hit.part;
      actions.onHover(part ? part.name || part.stem : null);
      canvas.dataset.part = part ? "control" : "";
      return;
    }
    if (e.pointerId !== gesture.id) return;

    if (!gesture.moved) {
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < TAP_SLOP_PX) return;
      gesture.moved = true;
      clearTimeout(gesture.holdTimer);
      if (gesture.button) {
        gesture.button.target = 0;
        invalidate();
      }
    }

    if (!gesture.arm) {
      rotate(
        (e.clientX - gesture.lastX) * TURN_RAD_PER_PX,
        (e.clientY - gesture.lastY) * TURN_RAD_PER_PX
      );
      invalidate();
    } else if (!gesture.held) {
      const point = surfacePoint(e, gesture.arm);
      if (point) {
        const along = point.dot(gesture.arm.axis) - gesture.startAlong;
        actions.onGrooveDrag(
          gesture.hit.part.stem,
          gesture.startVolume + along / gesture.arm.travel
        );
      }
    }
    gesture.lastX = e.clientX;
    gesture.lastY = e.clientY;
  }

  function onUp(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const { moved, held, hit, startT } = gesture;
    endGesture();
    if (moved || held || !hit) return;
    if (hit.part.kind === "button") {
      actions.onTap(hit.part.name, pillSide(hit.part, hit.point));
    } else if (e.timeStamp - startT < HOLD_MS) {
      // A long press away from the solo zone is nothing, not a late tap.
      actions.onGrooveTap(hit.part.stem);
    }
  }

  function onCancel(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    endGesture();
  }

  function onLeave() {
    if (!gesture) actions.onHover(null);
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);

  resize();

  return {
    /** levels: stem -> { volume: 0..1, glow: 0..1 } */
    setLevels(levels) {
      for (const [stem, { volume, glow }] of Object.entries(levels)) {
        arms[stem].leds.forEach((led, i) => {
          const fill = Math.min(1, Math.max(0, volume * LEDS_PER_ARM - i));
          led.target = fill * glow;
        });
      }
      invalidate();
    },

    /** Animate a press from the keyboard, where no gesture drives it. */
    pulse(name) {
      const b = buttons.find((x) => x.name === name);
      if (!b) return;
      b.target = 1;
      invalidate();
      setTimeout(() => {
        b.target = 0;
        invalidate();
      }, 110);
    },

    dispose() {
      cancelAnimationFrame(raf);
      if (gesture) clearTimeout(gesture.holdTimer);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      });
      for (const t of textures) t.dispose();
      scene.environment.dispose();
      renderer.dispose();
    },
  };
}

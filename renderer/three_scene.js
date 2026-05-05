import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { loadPlyForCollision } from './ply_parser.js';

const canvas = document.getElementById('three-canvas');

// ============================================================
// Scene, Camera, Renderer
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  1000
);

// Renderer — opaque, no alpha
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x111111);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let frameCount = 0;

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(5, 10, 7);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.1;
dirLight.shadow.camera.far = 50;
dirLight.shadow.bias = -0.001;
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
fillLight.position.set(-5, 2, -5);
scene.add(fillLight);

// ============================================================
// 3DGS Room — DropInViewer
// ============================================================
const dropInViewer = new GaussianSplats3D.DropInViewer({
  sharedMemoryForWorkers: false,
  gpuAcceleratedSort: false,
  integerBasedSort: true,
  antialiased: false,
  logLevel: GaussianSplats3D.LogLevel.None,
});
scene.add(dropInViewer);

const loadingBarFill = document.getElementById('loading-bar-fill');
const loadingPercent = document.getElementById('loading-percent');
const loadingContainer = document.getElementById('loading-bar-container');

const roomLoadPromise = dropInViewer.addSplatScene('app://data/room.ply', {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  showLoadingUI: false,
  onProgress: (percent, label) => {
    const pct = Number.isFinite(percent) ? Math.round(percent) : 0;
    if (loadingBarFill) loadingBarFill.style.width = pct + '%';
    if (loadingPercent) {
      if (pct === 0 && label === '0%') {
        loadingPercent.textContent = 'Processing...';
      } else {
        loadingPercent.textContent = pct + '%';
      }
    }
  },
}).then(() => {
  console.log('[3DGS] Room loaded successfully');
  if (loadingContainer) loadingContainer.classList.add('hidden');
  const sm = dropInViewer.splatMesh || dropInViewer.viewer.splatMesh;
  if (sm) {
    sm.visible = true;
    console.log('[3DGS] Splat mesh set to visible');
    console.log('[3DGS] Splat count:', sm.getSplatCount ? sm.getSplatCount() : 'N/A');
    console.log('[3DGS] SplatMesh world position:', sm.getWorldPosition(new THREE.Vector3()));
    console.log('[3DGS] SplatMesh bounding box:', sm.boundingBox);


  } else {
    console.warn('[3DGS] splatMesh is null after loading!');
  }
}).catch((err) => {
  console.error('[3DGS] Failed to load room:', err);
  if (loadingPercent) loadingPercent.textContent = 'Load failed';
  if (loadingBarFill) loadingBarFill.style.background = '#e74c3c';
});

// ============================================================
// Default Camera Parameters (hand-tuned per scene)
// ============================================================
// Format mirrors the reference viewer:
//   target: [x, y, z]        — look-at point
//   camera: [theta, phi, r]  — spherical angles (reference convention)
// To tune: navigate to a nice view, press P, copy the console output here.
/*
const defaultCameraParameters = {
  room: {
    up: [0, 0.886994, 0.461779],
    target: [-0.4283, 1.2004, 0.8185],
    camera: [4.9508, 1.7308, 2.5],
  },
};
*/
const defaultCameraParameters = {
  room: {
    up: [0, -1, 0],           // 1. 标准头顶朝上（必须）
    target: [-0.4283, 1.5, 0.8185], // 2. 抬高目标点（人眼高度）
    camera: [4.9508, 1.7308, 2.5],  // 3. phi=水平视角, r=拉远一点更自然
  },
};


function applyCameraParameters(params) {
  const target = new THREE.Vector3(...params.target);
  const up = new THREE.Vector3(...params.up).normalize();
  const [theta, phi] = params.camera;

  // 1. Compute spherical offset in the CAPTURED coordinate system
  //    (where the captured 'up' is the local Y axis)
  const offsetCaptured = new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  );

  // 2. Rotate offset from captured coordinates to world coordinates
  const worldUp = new THREE.Vector3(0, 1, 0);
  const rotationQuat = new THREE.Quaternion().setFromUnitVectors(up, worldUp);
  const offsetWorld = offsetCaptured.clone().applyQuaternion(rotationQuat);

  // 3. Eye position in world space
  const eye = target.clone().add(offsetWorld);

  // 4. Orient camera the same way the reference does:
  //    look from eye toward target, using the captured up vector
  camera.up.copy(up);
  camera.position.copy(eye);
  camera.lookAt(target);

  // 5. Sync FPS yaw/pitch from the resulting quaternion
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  yaw = euler.y;
  pitch = euler.x;
}

// ============================================================
// Collision Data from PLY
// ============================================================
let collisionData = null;
let collisionEnabled = true;
let splatBoxHelper = null;

function computeBestViewpoint(data) {
  const { sceneMin, sceneMax } = data;

  // 1. Bounding box center
  const cx = (sceneMin[0] + sceneMax[0]) / 2;
  const cy = (sceneMin[1] + sceneMax[1]) / 2;
  const cz = (sceneMin[2] + sceneMax[2]) / 2;

  // 2. Room dimensions
  const dimX = sceneMax[0] - sceneMin[0];
  const dimY = sceneMax[1] - sceneMin[1];
  const dimZ = sceneMax[2] - sceneMin[2];

  // 3. Eye height
  const eyeY = Math.min(1.7, sceneMin[1] + dimY * 0.55);

  // 4. Stand INSIDE the room near one end, not outside
  // Offset = 35% of longest dimension from center toward edge
  const offset = Math.max(dimX, dimZ) * 0.35;

  // 5. Look down the longest axis from near one end toward center
  let camX, camZ;
  if (dimX >= dimZ) {
    // Room is longer in X → stand near -Z end, look toward +Z
    camX = cx;
    camZ = cz - offset;
  } else {
    // Room is longer in Z → stand near -X end, look toward +X
    camX = cx - offset;
    camZ = cz;
  }

  // 6. Look horizontally at center (same eye level)
  const target = new THREE.Vector3(cx, eyeY, cz);

  console.log(`[Viewpoint] Inside room near wall. Camera: ${camX.toFixed(2)}, ${eyeY.toFixed(2)}, ${camZ.toFixed(2)} | Target: ${cx.toFixed(2)}, ${eyeY.toFixed(2)}, ${cz.toFixed(2)} | Offset: ${offset.toFixed(2)}m`);

  return {
    position: new THREE.Vector3(camX, eyeY, camZ),
    target,
  };
}

loadPlyForCollision('app://data/room.ply').then((data) => {
  collisionData = data;
  console.log('[Collision] PLY parsed:', data.gaussianCount, 'gaussians');
  console.log('[Collision] Bounds:', data.sceneMin, 'to', data.sceneMax);

  // Use hand-tuned camera parameters if available, otherwise fall back to auto
  const sceneKey = 'room';
  if (defaultCameraParameters[sceneKey]) {
    applyCameraParameters(defaultCameraParameters[sceneKey]);
    console.log(`[Viewpoint] Applied hardcoded parameters for "${sceneKey}"`);
  } else {
    const vp = computeBestViewpoint(data);
    camera.position.copy(vp.position);
    camera.lookAt(vp.target);
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    yaw = euler.y;
    pitch = euler.x;
  }

  // Drone is now a HUD element parented to the camera; no world placement needed
}).catch((err) => {
  console.error('[Collision] Failed to parse PLY:', err);
});

// ============================================================
// FPS Camera Controls
// ============================================================
let yaw = 0;
let pitch = 0;
const keys = { w: false, a: false, s: false, d: false, shift: false, space: false };

// Pointer lock
const controlsHelp = document.getElementById('controls-help');

canvas.addEventListener('click', () => {
  canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    controlsHelp.style.opacity = '0.3';
  } else {
    controlsHelp.style.opacity = '1';
  }
});

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * 0.002;
  pitch -= e.movementY * 0.002;
  pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = true;
  if (e.code === 'ShiftLeft') keys.shift = true;
  if (e.code === 'Space') keys.space = true;

  // Toggle collision with C
  if (k === 'c') {
    collisionEnabled = !collisionEnabled;
    console.log('Collision detection:', collisionEnabled ? 'ON' : 'OFF');
    if (controlsHelp) {
      controlsHelp.innerHTML = `<span class='ctrl-key'>WASD</span>: Walk &nbsp;|&nbsp; <span class='ctrl-key'>Mouse</span>: Look &nbsp;|&nbsp; <span class='ctrl-key'>Click</span>: Lock mouse &nbsp;|&nbsp; <span class='ctrl-key'>C</span>: Collision ${collisionEnabled ? 'ON' : 'OFF'}`;
    }
  }

  // Print current camera parameters with P
  if (k === 'p') {
    const pos = camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    console.log('=== CAMERA PARAMS ===');
    console.log(`  target: [${pos.x.toFixed(6)}, ${pos.y.toFixed(6)}, ${pos.z.toFixed(6)}],`);
    console.log(`  forward: [${forward.x.toFixed(6)}, ${forward.y.toFixed(6)}, ${forward.z.toFixed(6)}],`);
    console.log(`  yaw: ${yaw.toFixed(6)}, pitch: ${pitch.toFixed(6)}`);
    console.log('=====================');
  }
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = false;
  if (e.code === 'ShiftLeft') keys.shift = false;
  if (e.code === 'Space') keys.space = false;
});

// ============================================================
// Collision Detection (ported from camera.js)
// ============================================================
const COLLISION_RADIUS = 0.3;
const BOUNDARY_PADDING = 0.2;
const COLLISION_SAMPLE_STEP = 50;

function checkCollision(newPos) {
  if (!collisionEnabled) return false;
  if (!collisionData) return false;

  const { sceneMin, sceneMax, positions, opacities } = collisionData;

  // 1. Boundary box check
  const minBound = [
    sceneMin[0] + BOUNDARY_PADDING,
    sceneMin[1] + BOUNDARY_PADDING,
    sceneMin[2] + BOUNDARY_PADDING,
  ];
  const maxBound = [
    sceneMax[0] - BOUNDARY_PADDING,
    sceneMax[1] - BOUNDARY_PADDING,
    sceneMax[2] - BOUNDARY_PADDING,
  ];

  if (
    newPos.x < minBound[0] || newPos.x > maxBound[0] ||
    newPos.y < minBound[1] || newPos.y > maxBound[1] ||
    newPos.z < minBound[2] || newPos.z > maxBound[2]
  ) {
    return true;
  }

  // 2. Sparse gaussian proximity check
  const checkRadiusSq = COLLISION_RADIUS * COLLISION_RADIUS;
  const count = opacities.length;

  for (let i = 0; i < count; i += COLLISION_SAMPLE_STEP) {
    if (opacities[i] < 0.5) continue;

    const gx = positions[i * 3];
    const gy = positions[i * 3 + 1];
    const gz = positions[i * 3 + 2];

    const dx = newPos.x - gx;
    const dy = newPos.y - gy;
    const dz = newPos.z - gz;

    if (dx * dx + dy * dy + dz * dz < checkRadiusSq) {
      return true;
    }
  }

  return false;
}

function updateFPSCamera(dt) {
  const speed = (keys.shift ? 4.0 : 2.0) * dt;

  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);

  const move = new THREE.Vector3();
  if (keys.w) move.addScaledVector(forward, speed);
  if (keys.s) move.addScaledVector(forward, -speed);
  if (keys.a) move.addScaledVector(right, -speed);
  if (keys.d) move.addScaledVector(right, speed);
  if (keys.space) move.y += speed;
  if (keys.shift && !keys.w && !keys.s && !keys.a && !keys.d) {
    // Only shift without WASD -> move down
    move.y -= speed;
  }

  if (move.lengthSq() === 0) return;

  const newPos = camera.position.clone().add(move);

  if (!checkCollision(newPos)) {
    camera.position.copy(newPos);
  } else {
    // Wall-slide: try individual axes
    const tryX = camera.position.clone();
    tryX.x = newPos.x;
    if (!checkCollision(tryX)) camera.position.x = newPos.x;

    const tryY = camera.position.clone();
    tryY.y = newPos.y;
    if (!checkCollision(tryY)) camera.position.y = newPos.y;

    const tryZ = camera.position.clone();
    tryZ.z = newPos.z;
    if (!checkCollision(tryZ)) camera.position.z = newPos.z;

    // Trigger HUD drone bounce-back when hitting a wall
    droneBounce = 1.0;
  }
}

// ============================================================
// Drone Model
// ============================================================
let drone = null;
let droneMaterials = [];
let propellers = [];
let droneBounce = 0; // collision recoil timer
const clock = new THREE.Clock();

const loader = new GLTFLoader();
loader.load(
  '../asset/crazyflie_2.x.glb',
  (gltf) => {
    drone = gltf.scene;

    // Center geometry
    const box = new THREE.Box3().setFromObject(drone);
    const center = new THREE.Vector3();
    box.getCenter(center);
    drone.position.sub(center);

    const size = new THREE.Vector3();
    box.getSize(size);

    // Scale to real-world size: Crazyflie ~9.2cm motor-to-motor, ~15cm prop span
    const realWidth = 0.15; // meters
    const realWorldScale = realWidth / size.x;
    drone.scale.setScalar(realWorldScale);

    // Collect materials for effects
    drone.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material = child.material.clone();
        droneMaterials.push(child.material);
      }
    });

    // Parent to camera for HUD positioning (upper center, 1/4 screen width)
    camera.add(drone);
    scene.add(camera); // camera must be in scene graph for its children to render
    drone.position.set(0, 0.35, -1.2);
    drone.rotation.y = Math.PI; // face toward camera

    // Strong local fill + scene directional lights for dramatic shading
    const droneLight = new THREE.PointLight(0xffffff, 2.5, 6);
    droneLight.position.set(0, 0.3, -0.3);
    camera.add(droneLight);

    // Enable shadow casting on drone meshes
    drone.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Prominent contact shadow beneath the HUD drone
    const shadowGeo = new THREE.PlaneGeometry(0.14, 0.14);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const contactShadow = new THREE.Mesh(shadowGeo, shadowMat);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, -0.06, -1.2);
    camera.add(contactShadow);

    // Find propeller meshes for animation
    findPropellers(drone);

    // Set initial HUD scale and update on resize
    updateDroneScale();
    window.addEventListener('resize', updateDroneScale);

    console.log('[Three.js] Crazyflie loaded as HUD element');
  },
  undefined,
  (error) => {
    console.error('[Three.js] Failed to load GLB:', error);
  }
);

function findPropellers(droneScene) {
  const nameHints = ['propeller', 'prop', 'rotor', 'blade'];
  const candidates = [];
  droneScene.traverse((child) => {
    if (child.isMesh) {
      const name = child.name.toLowerCase();
      if (nameHints.some((h) => name.includes(h))) {
        candidates.push(child);
      }
    }
  });
  console.log('[Drone] Name-matched candidates:', candidates.map((p) => p.name || '(unnamed)'));

  // Fallback: use drone-relative position to find corner meshes
  if (candidates.length < 4) {
    const meshes = [];
    droneScene.traverse((child) => {
      if (child.isMesh && !candidates.includes(child)) meshes.push(child);
    });

    const dronePos = new THREE.Vector3();
    droneScene.getWorldPosition(dronePos);
    const worldPos = new THREE.Vector3();

    meshes.forEach((m) => {
      m.getWorldPosition(worldPos);
      const relX = worldPos.x - dronePos.x;
      const relY = worldPos.y - dronePos.y;
      const relZ = worldPos.z - dronePos.z;
      m.userData.propDist = Math.sqrt(relX * relX + relZ * relZ);
      m.userData.relY = relY;
    });

    // Propellers are at corners (far in XZ) and roughly level with the body center
    const cornerMeshes = meshes
      .filter((m) => m.userData.propDist > 0.015)
      .filter((m) => Math.abs(m.userData.relY) < 0.025)
      .sort((a, b) => b.userData.propDist - a.userData.propDist);

    candidates.push(...cornerMeshes.slice(0, Math.max(0, 4 - candidates.length)));
  }

  propellers = candidates.slice(0, 4);

  // Sort back-to-front then left-to-right for consistent motor order
  const dronePos = new THREE.Vector3();
  droneScene.getWorldPosition(dronePos);
  const sortPos = new THREE.Vector3();
  propellers.sort((a, b) => {
    a.getWorldPosition(sortPos);
    sortPos.sub(dronePos);
    const ax = sortPos.x, az = sortPos.z;
    b.getWorldPosition(sortPos);
    sortPos.sub(dronePos);
    const bx = sortPos.x, bz = sortPos.z;
    if (Math.abs(az - bz) > 0.001) return bz - az; // larger Z (back) first
    return ax - bx; // left to right
  });

  console.log(
    '[Drone] Final propellers:',
    propellers.map((p, i) => `${i}: ${p.name || '(unnamed)'}`)
  );
}

function updateDroneScale() {
  if (!drone) return;
  const distance = Math.abs(drone.position.z);
  const fovRad = (camera.fov * Math.PI) / 180;
  const visibleHeight = 2 * distance * Math.tan(fovRad / 2);
  const visibleWidth = visibleHeight * camera.aspect;
  const targetWidth = visibleWidth / 8;
  const baseWidth = 0.15;
  const hudScale = targetWidth / baseWidth;
  drone.scale.setScalar(hudScale);
}

// ============================================================
// Drone Controls (from control pads)
// ============================================================
const droneCommands = {
  up: false,
  down: false,
  turn_left: false,
  turn_right: false,
  forward: false,
  backward: false,
  slide_left: false,
  slide_right: false,
};

document.addEventListener('droneCommand', (e) => {
  const { command, active } = e.detail;
  if (command in droneCommands) {
    droneCommands[command] = active;
  }
});

function updateDrone(dt) {
  if (!drone) return;

  const tiltSpeed = 4.0;
  const yawSpeed = 3.0;
  const returnSpeed = 6.0 * dt;
  const basePos = new THREE.Vector3(0, 0.35, -1.2);

  // Target tilt angles based on pad commands (visual feedback)
  let targetPitch = 0;
  let targetRoll = 0;
  let targetYaw = drone.rotation.y;

  if (droneCommands.forward) targetPitch = 0.35;
  if (droneCommands.backward) targetPitch = -0.35;
  if (droneCommands.slide_right) targetRoll = -0.35;
  if (droneCommands.slide_left) targetRoll = 0.35;
  if (droneCommands.turn_left) targetYaw += yawSpeed * dt;
  if (droneCommands.turn_right) targetYaw -= yawSpeed * dt;

  // Smoothly interpolate tilt back to neutral
  drone.rotation.x += (targetPitch - drone.rotation.x) * returnSpeed;
  drone.rotation.z += (targetRoll - drone.rotation.z) * returnSpeed;
  drone.rotation.y += (targetYaw - drone.rotation.y) * returnSpeed;

  // Vertical offset from up/down commands
  let targetY = basePos.y;
  if (droneCommands.up) targetY += 0.15;
  if (droneCommands.down) targetY -= 0.15;
  drone.position.y += (targetY - drone.position.y) * returnSpeed;

  // Clamp HUD position so it never drifts too far from center
  drone.position.x = THREE.MathUtils.clamp(drone.position.x, -0.4, 0.4);
  drone.position.z = THREE.MathUtils.clamp(drone.position.z, basePos.z - 0.4, basePos.z + 0.1);

  // Gentle hover bobbing
  drone.position.y += Math.sin(clock.getElapsedTime() * 4) * 0.0008;

  // Collision bounce-back: fly toward camera then recover
  if (droneBounce > 0) {
    const bounceDepth = 0.2 * droneBounce; // push closer to camera
    drone.position.z += bounceDepth * dt * 10;
    droneBounce -= dt * 5;
    if (droneBounce < 0) droneBounce = 0;
  }

  // Spin propellers: CCW, CW, CCW, CW
  const spinSpeed = 50;
  propellers.forEach((prop, i) => {
    const dir = i % 2 === 0 ? 1 : -1;
    prop.rotation.y += dir * spinSpeed * dt;
  });
}

// ============================================================
// Animation Loop
// ============================================================
function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05); // clamp delta to avoid jumps

  updateFPSCamera(dt);
  updateDrone(dt);

  // Periodic diagnostics
  if (frameCount % 120 === 0) {
    const sm = dropInViewer.splatMesh || dropInViewer.viewer.splatMesh;
    if (sm) {
      const box = sm.boundingBox;
      const camPos = camera.position;
      console.log(`[Diag] Cam: ${camPos.x.toFixed(2)},${camPos.y.toFixed(2)},${camPos.z.toFixed(2)} | Box: ${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)} ${box.min.y.toFixed(1)}..${box.max.y.toFixed(1)} ${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)} | visible=${sm.visible} | frustumCulled=${sm.frustumCulled} | inScene=${sm.parent !== null}`);
    }
  }
  frameCount++;

  renderer.render(scene, camera);
}

animate();

// ============================================================
// Resize Handler
// ============================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateDroneScale();
});

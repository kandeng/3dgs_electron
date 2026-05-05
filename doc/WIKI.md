# War Room Electron — Architecture & Functionality

## Overview

War Room Electron is a real-time 3D immersive command center for piloting a Bitcraze Crazyflie 2.x drone equipped with an ESP32-S3-AI-Deck camera module. The application combines:

- **3D Gaussian Splatting (3DGS)** room reconstruction for immersive first-person navigation
- **Live MJPEG video streaming** from the drone's onboard camera
- **3D Crazyflie GLB model** rendered as a camera-parented HUD overlay with animated propellers
- **Touch/mouse control pads** for issuing flight commands
- **Collision-aware FPS camera** that prevents walking through walls

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Electron Main Process                             │
│                              (main.js)                                      │
│  • Creates BrowserWindow (2/3 screen size)                                  │
│  • Registers custom 'app://' protocol for secure local file serving         │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Chromium Renderer Process                           │
│                         (renderer/index.html)                               │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Three.js     │  │ renderer.js  │  │ styles.css   │  │ GaussianSplats │  │
│  │ three_scene  │  │ Control pads │  │ UI layout    │  │ 3DGS viewer    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘  │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌─────────────────┐
│ crazyflie_2.x │         │  video_stream_  │         │  motion_control_│
│    .glb       │         │    proxy.py     │         │    relay.py     │
│ (Drone model) │         │  MJPEG proxy    │         │  WebSocket relay│
└───────────────┘         └────────┬────────┘         └────────┬────────┘
                                   │                           │
                                   ▼                           ▼
                         ┌─────────────────┐         ┌─────────────────┐
                         │  ESP32-S3-AI-   │         │   Crazyflie 2.x │
                         │     Deck        │         │  (radio dongle) │
                         │ 192.168.0.109   │         │                 │
                         └─────────────────┘         └─────────────────┘
```

## File Structure

```
.
├── main.js                          # Electron entry point
├── package.json                     # Node.js dependencies & scripts
│
├── renderer/
│   ├── index.html                   # Main UI layout (canvas, pads, feed, HUD)
│   ├── renderer.js                  # Control pad input → CustomEvent bridge
│   ├── three_scene.js               # Main 3D engine (Three.js + GaussianSplats3D)
│   ├── ply_parser.js                # Parse 3DGS PLY for collision data
│   └── styles.css                   # Control pads, loading bar, PiP layout
│
├── crazyflie_bridge/
│   ├── video_stream_proxy.py        # MJPEG multi-client proxy (ESP32 → localhost:8082)
│   ├── motion_control_relay.py      # WebSocket ↔ Crazyflie radio bridge
│   └── requirements.txt             # Python dependencies (cflib, websockets, etc.)
│
├── tools/
│   └── generate_depth_video.py      # MiDaS depth map generator (optional utility)
│
├── data/
│   └── room.ply                     # 3D Gaussian Splatting room scan
│
├── asset/
│   ├── crazyflie_2.x.glb            # Crazyflie 3D model (drone HUD)
│   └── counter_strike.mp4           # Test video asset
│
└── doc/
    ├── design/
    │   └── war_room_electron.png    # UI mockup / design reference
    └── asset/
        └── crazyflie_2.x.glb        # Copy of drone model for documentation
```

## Core Components

### 1. Electron Main Process (`main.js`)

- Registers `app://` as a privileged custom scheme so the renderer can securely `fetch()` local PLY files via `app://data/room.ply`
- Creates a framed `BrowserWindow` at 2/3 of the primary display size
- Disables `nodeIntegration` and enables `contextIsolation` for security

### 2. Three.js Scene (`renderer/three_scene.js`)

The heart of the application. Key subsystems:

#### 2.1 3DGS Room Viewer

Uses `GaussianSplats3D.DropInViewer` to load and render `data/room.ply`. The viewer is added directly to the Three.js scene graph.

```javascript
const dropInViewer = new GaussianSplats3D.DropInViewer({
  sharedMemoryForWorkers: false,
  gpuAcceleratedSort: false,
  integerBasedSort: true,
  antialiased: false,
});
scene.add(dropInViewer);
```

A horizontal progress bar tracks `onProgress` callbacks during PLY loading and hides when complete.

#### 2.2 FPS Camera with Collision Detection

- **Pointer-lock mouse look**: click the canvas to capture the cursor; mouse movement updates `yaw` and `pitch`
- **WASD + Space/Shift movement**: walk, fly up/down, sprint
- **Gaussian collision**: before every camera move, `checkCollision()` tests against parsed PLY data
  - Boundary box check with 0.2 m padding
  - Sparse gaussian proximity check (every 50th gaussian, radius 0.3 m)
- **Wall-slide**: when a diagonal move is blocked, tries X/Y/Z axes individually to slide along walls
- **Camera init**: hand-tuned `defaultCameraParameters` with `up`, `target`, and spherical `camera` coordinates; falls back to auto-computed room-center viewpoint if parameters are absent

#### 2.3 Crazyflie HUD Overlay

The drone is loaded from `asset/crazyflie_2.x.glb` and parented to the **camera** (not the scene), so it stays fixed in the upper-center of the viewport regardless of where the player walks.

**Critical rendering note**: the camera itself must be added to the scene (`scene.add(camera)`) or the drone and its children will not be rendered by Three.js.

- **Scale**: dynamically computed so the drone width equals `visibleWidth / 8` at its fixed depth (`z = -1.2`)
- **Propellers**: 4 meshes detected by name (`propeller`, `prop`, `rotor`, `blade`) with position-based fallback; sorted back-to-front/left-to-right; spun at 50 rad/s alternating CCW/CW/CCW/CW
- **Tilt feedback**: the HUD drone tilts/rotates based on control-pad commands (forward/back = pitch, slide = roll, turn = yaw)
- **Hover bobbing**: gentle sine-wave vertical drift for liveliness
- **Collision bounce-back**: when the FPS camera hits a wall, the HUD drone recoils toward the camera (`z +=`) over ~0.2 s
- **Lighting**: combination of ambient light, two directional lights (main + fill), a local point light on the drone, and shadow mapping enabled
- **Contact shadow**: a small translucent black plane beneath the drone for grounded appearance

#### 2.4 PLY Collision Parser (`renderer/ply_parser.js`)

Reads the raw PLY binary and extracts:
- Gaussian positions (3 floats per gaussian)
- Opacities (sigmoid-transformed)
- Scene bounding box (min/max)

Data is returned as `Float32Array`s for fast JS iteration in the collision loop.

### 3. Control Pads (`renderer/renderer.js` + `styles.css`)

Two circular touch pads:

| Pad | Position | Commands |
|-----|----------|----------|
| Left | Left side | Up, Down, Turn Left, Turn Right |
| Right | Right side | Forward, Backward, Slide Left, Slide Right |

Each quadrant is a `div.quadrant` with inline SVG icons. On `mousedown`/`touchstart`, it fires a custom `droneCommand` event consumed by `three_scene.js`. The `.active` class highlights pressed quadrants.

### 4. Video Stream Proxy (`crazyflie_bridge/video_stream_proxy.py`)

A threaded HTTP proxy that:
1. Connects to the ESP32 MJPEG stream (`http://192.168.0.109/stream`)
2. Parses JPEG frames by scanning `FF D8` / `FF D9` markers
3. Serves them via `multipart/x-mixed-replace` on `http://localhost:8082/stream`
4. Also exposes a `/snapshot` endpoint for single-frame capture

The ESP32 only supports one concurrent client; the proxy decouples this so Electron, browsers, and other tools can view simultaneously.

### 5. Motion Control Relay (`crazyflie_bridge/motion_control_relay.py`)

Bridges the OpenClaw gateway WebSocket to the Crazyflie radio:
- **Commands**: `takeoff`, `land`, `stop`, `move` (linear velocity), `up`/`down`/`forward`/`back`/`left`/`right` (discrete distances)
- **Telemetry**: publishes position (`stateEstimate.x/y/z`), attitude (`stabilizer.roll/pitch/yaw`), and battery (`pm.vbat`) back to the gateway at 10 Hz
- **Threading model**: Crazyflie I/O runs in a dedicated thread; WebSocket I/O runs in `asyncio`

## Key Parameters & Tuning Guide

### Drone HUD Size

In `three_scene.js`, `updateDroneScale()`:

```javascript
const targetWidth = visibleWidth / 8;  // increase divisor for smaller drone
```

### Lighting Intensity

| Parameter | File | Line | Description |
|-----------|------|------|-------------|
| `dirLight.intensity` | `three_scene.js` | ~38 | Main sun brightness (affects shadow darkness) |
| `droneLight.intensity` | `three_scene.js` | ~446 | Local point light on the drone |
| `shadowMat.opacity` | `three_scene.js` | ~463 | Contact shadow darkness (0–1) |
| `shadow.mapSize` | `three_scene.js` | ~41 | Shadow texture resolution (1024, 2048, 4096) |

### Collision Detection

| Parameter | File | Default | Description |
|-----------|------|---------|-------------|
| `COLLISION_RADIUS` | `three_scene.js` | 0.3 m | Distance from gaussian to trigger collision |
| `COLLISION_SAMPLE_STEP` | `three_scene.js` | 50 | Skip every N gaussians for performance |
| `BOUNDARY_PADDING` | `three_scene.js` | 0.2 m | Keep-away margin from scene bounding box |

Press `C` to toggle collision on/off at runtime.

### Camera Initialization

Edit `defaultCameraParameters.room` in `three_scene.js`:

```javascript
const defaultCameraParameters = {
  room: {
    up: [0, -1, 0],           // Camera up vector
    target: [-0.4283, 1.5, 0.8185],  // Look-at point
    camera: [4.9508, 1.7308, 2.5],   // [theta, phi, radius] spherical coords
  },
};
```

Navigate to a nice view in the app and press `P` to print current parameters to the DevTools console.

### Control Pad Sizing & Icons

| Parameter | File | Default | Description |
|-----------|------|---------|-------------|
| `.pad-circle` width/height | `styles.css` | 320 px | Overall pad diameter |
| `.center-dot` width/height | `styles.css` | 37.5% | Inner circle relative size |
| `.label svg` width/height | `styles.css` | 22.5% | Icon size relative to quadrant |
| `.quadrant.top .label` margin-top | `styles.css` | 18.75% | Push top icon toward edge |
| `.quadrant.left .label` margin-left | `styles.css` | -37.5% | Push left icon toward edge |

Icons are inline SVGs inside `index.html`. Edit the `<svg>` elements directly to change shapes.

## Data Flow

### Drone Command Flow

```
User clicks control pad quadrant
         │
         ▼
renderer.js fires CustomEvent('droneCommand', { command, active })
         │
         ▼
three_scene.js receives event → updates droneCommands state
         │
         ▼
updateDrone(dt) reads droneCommands → applies tilt/yaw/vertical offsets
         │
         ▼
Drone GLB meshes rotate/translate in camera-local space (HUD feedback)
```

### Video Stream Flow

```
ESP32-S3-AI-Deck (192.168.0.109)
         │
         ▼ MJPEG stream
video_stream_proxy.py (localhost:8082)
         │
         ├───────► Electron renderer (index.html <img src="http://localhost:8082/stream">)
         │
         └───────► Browser / other clients
```

### Collision Flow

```
User presses WASD → updateFPSCamera(dt)
         │
         ▼
Proposed newPos computed
         │
         ▼
checkCollision(newPos)
   ├─► Boundary box check (fast reject)
   └─► Gaussian proximity check (sparse sampling)
         │
    true ├────► Block movement + trigger wall-slide + droneBounce = 1.0
    false└────► Accept newPos
```

## Dependencies

### Node.js / Electron

| Package | Version | Purpose |
|---------|---------|---------|
| electron | ^41.5.0 | Desktop shell |
| three | ^0.184.0 | 3D engine |
| @mkkellogg/gaussian-splats-3d | ^0.4.7 | 3DGS rendering |

### Python

| Package | Purpose |
|---------|---------|
| cflib | Crazyflie radio communication |
| websockets | Gateway relay client |
| opencv-python | Video processing (proxy & tools) |
| torch/torchvision/timm | MiDaS depth estimation (optional) |

## Future Extensions

- **Live telemetry-driven HUD**: replace synthetic tilt with real `stabilizer.roll/pitch/yaw` from the Crazyflie
- **Motion command wiring**: connect control pad events to the WebSocket gateway so pad presses drive the real drone
- **Depth-video collision**: integrate `generate_depth_video.py` output for obstacle-aware drone positioning
- **Responsive UI**: optional `clamp()`/`vmin` scaling for control pads on different screen sizes

# War Room Electron — Quick Start

A real-time 3D immersive command center for piloting a Crazyflie drone. Walk through a Gaussian Splatting (3DGS) reconstructed room, watch the live drone camera feed, and control the drone via on-screen pads while a 3D Crazyflie HUD reacts to your commands and environmental collisions.

<p align="center">
  <a href="https://www.youtube.com/watch?v=EpH-ANjWAw8">
    <img src="https://img.youtube.com/vi/EpH-ANjWAw8/maxresdefault.jpg" alt="War Room Electron Demo" style="width:80%;">
  </a>
</p>

## Prerequisites

- The Crazyflie drone with ESP32-S3-AI-Deck must be powered on and connected to Wi-Fi.
- The ESP32 video stream must be accessible (default: `http://192.168.0.109/stream`).

### 1. Create the `crazyflie` Conda Environment and Install Python Packages

```bash
# Create the environment with Python 3.11
conda create -n crazyflie python=3.11 -y

# Activate it
conda activate crazyflie

# Install the required packages
cd /home/robot/war_room_electron
pip install -r crazyflie_bridge/requirements.txt
```

### 2. Install Node.js, npm, and Dependencies

Check if Node.js and npm are already installed:

```bash
node --version
npm --version
```

If they are missing, install Node.js (which includes npm). On Ubuntu:

```bash
# Using NodeSource (recommended for latest LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version
npm --version
```

Then install all Node dependencies (Electron, Three.js, GaussianSplats3D):

```bash
cd /home/robot/war_room_electron
npm install
```

## Terminal 1 — Start the Video Stream Proxy

The ESP32 can only serve **one** video client at a time. The Python proxy bridges that single stream so multiple viewers (Electron, Chrome, etc.) can watch simultaneously.

```bash
cd /home/robot/war_room_electron
conda activate crazyflie
python3 crazyflie_bridge/video_stream_proxy.py
```

You should see:
```
[Proxy] MJPEG multi-client proxy running on http://localhost:8082/stream
[Proxy] Upstream ESP32: http://192.168.0.109/stream
```

Keep this terminal running.

## Terminal 2 — Start the Electron App

```bash
cd /home/robot/war_room_electron
npm start
```

The War Room window opens at **2/3 of your screen size** with:
- **3DGS Room** — an immersive Gaussian Splatting reconstruction you can walk through
- **3D Crazyflie drone HUD** — rendered in real-time with Three.js, floating in the upper-center area at **1/8 of the window width**, with spinning propellers and tilt feedback
- **Live drone camera feed** — picture-in-picture window at the bottom-center
- **Control pads** — semi-transparent circular pads on the left (altitude/yaw) and right (translation)
- **FPS collision-aware navigation** — WASD to walk, mouse to look, collision detection with walls

### Controls

| Input | Action |
|-------|--------|
| `WASD` | Walk through the room |
| `Mouse` | Look around (click to lock pointer) |
| `Shift` | Sprint |
| `Space` | Move up |
| `Shift` (alone) | Move down |
| `C` | Toggle collision detection |
| `P` | Print current camera parameters to console |
| Left pad | Take off / Land / Turn left / Turn right |
| Right pad | Forward / Backward / Slide left / Slide right |

## View the Stream in a Browser

Once the proxy is running, you can open the stream in Chrome or any browser:

```
http://localhost:8082/stream
```

This works at the same time as the Electron app because both connect through the proxy.

> **Do not** open `http://192.168.0.109/stream` directly in the browser while the proxy is running, or the ESP32 will reject the proxy connection.

## Shut Down

1. Close the Electron window (or press `Ctrl+C` in Terminal 2).
2. Press `Ctrl+C` in Terminal 1 to stop the proxy.

## Architecture

For a detailed description of the system architecture, components, and tuning parameters, see [`doc/WIKI.md`](doc/WIKI.md).

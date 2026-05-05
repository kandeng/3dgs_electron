#!/usr/bin/env python3
"""
Crazyflie Relay for OpenClaw Gateway

Bridges WebSocket commands from the OpenClaw gateway to a Crazyflie drone,
and publishes drone telemetry back to the gateway.

Usage:
    python3 crazyflie_relay.py
    python3 crazyflie_relay.py --gateway ws://localhost:18789 --uri radio://0/80/2M/E7E7E7E7E7
"""

import argparse
import asyncio
import json
import logging
import queue
import sys
import threading
import time

import cflib.crtp
from cflib.crazyflie import Crazyflie
from cflib.crazyflie.log import LogConfig
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
from cflib.positioning.motion_commander import MotionCommander
from cflib.utils import uri_helper

try:
    import websockets
except ImportError:
    print("Error: 'websockets' library not installed. Run: pip install websockets")
    sys.exit(1)


class CrazyflieRelay:
    """
    Manages the full relay pipeline:
      - WebSocket client <-> OpenClaw gateway (asyncio)
      - Crazyflie connection + MotionCommander (dedicated thread)
      - Telemetry logging (callbacks -> asyncio queue)
      - Command dispatch (asyncio -> thread queue)
    """

    def __init__(self, gateway_uri, cf_uri, telemetry_hz=10, token=None):
        self.gateway_uri = gateway_uri
        self.cf_uri = cf_uri
        self.telemetry_period_ms = int(1000 / telemetry_hz)
        self.token = token or "YOUR_TOKEN_HERE"

        # Cross-thread communication
        self._command_queue = queue.Queue()          # WS -> CF (thread-safe)
        self._telemetry_queue = asyncio.Queue(maxsize=100)  # CF -> WS (asyncio)

        self._loop = None
        self._running = True
        self._cf_thread = None
        self._motion_commander = None
        self._scf = None

    # ------------------------------------------------------------------ #
    #  Public API
    # ------------------------------------------------------------------ #

    def start(self):
        """Initialize CRTP drivers and spin up the Crazyflie worker thread."""
        cflib.crtp.init_drivers()
        self._loop = asyncio.get_event_loop()
        self._cf_thread = threading.Thread(target=self._cf_worker, daemon=True)
        self._cf_thread.start()

    async def run(self):
        """Block and run the WebSocket client with auto-reconnect."""
        # Give the CF thread a moment to connect
        await asyncio.sleep(3)
        await self._ws_client()

    def stop(self):
        """Signal all loops to exit."""
        self._running = False

    # ------------------------------------------------------------------ #
    #  Crazyflie Worker Thread
    # ------------------------------------------------------------------ #

    def _cf_worker(self):
        """Background thread: owns the Crazyflie connection and MotionCommander."""
        while self._running:
            try:
                with SyncCrazyflie(self.cf_uri, cf=Crazyflie(rw_cache='./cache')) as scf:
                    self._scf = scf
                    print(f"[Relay] Crazyflie connected: {self.cf_uri}")

                    self._setup_logging(scf.cf)
                    scf.cf.platform.send_arming_request(True)
                    time.sleep(1.0)

                    # default_height=None  =>  do NOT auto-takeoff on enter
                    with MotionCommander(scf, default_height=None) as mc:
                        self._motion_commander = mc
                        print("[Relay] MotionCommander ready. Waiting for commands...")

                        while self._running:
                            try:
                                cmd = self._command_queue.get_nowait()
                                self._dispatch_command(cmd)
                            except queue.Empty:
                                pass
                            time.sleep(0.01)

            except Exception as e:
                print(f"[Relay] Crazyflie error: {e}")
                self._motion_commander = None
                self._scf = None
                if self._running:
                    time.sleep(2)

    def _setup_logging(self, cf):
        """Register log blocks for position, attitude, and battery."""
        # Position estimate
        log_pos = LogConfig(name='Position', period_in_ms=self.telemetry_period_ms)
        log_pos.add_variable('stateEstimate.x', 'float')
        log_pos.add_variable('stateEstimate.y', 'float')
        log_pos.add_variable('stateEstimate.z', 'float')
        cf.log.add_config(log_pos)
        log_pos.data_received_cb.add_callback(self._on_position)
        log_pos.start()

        # Attitude (stabilizer)
        log_stab = LogConfig(name='Stabilizer', period_in_ms=self.telemetry_period_ms)
        log_stab.add_variable('stabilizer.roll', 'float')
        log_stab.add_variable('stabilizer.pitch', 'float')
        log_stab.add_variable('stabilizer.yaw', 'float')
        cf.log.add_config(log_stab)
        log_stab.data_received_cb.add_callback(self._on_attitude)
        log_stab.start()

        # Battery voltage
        log_batt = LogConfig(name='Battery', period_in_ms=1000)
        log_batt.add_variable('pm.vbat', 'FP16')
        cf.log.add_config(log_batt)
        log_batt.data_received_cb.add_callback(self._on_battery)
        log_batt.start()

    # ------------------------------------------------------------------ #
    #  Telemetry callbacks (run on Crazyflie thread -> enqueue to asyncio)
    # ------------------------------------------------------------------ #

    def _on_position(self, timestamp, data, logconf):
        self._enqueue_telemetry("position", timestamp, {
            "x": data.get('stateEstimate.x', 0),
            "y": data.get('stateEstimate.y', 0),
            "z": data.get('stateEstimate.z', 0)
        })

    def _on_attitude(self, timestamp, data, logconf):
        self._enqueue_telemetry("attitude", timestamp, {
            "roll": data.get('stabilizer.roll', 0),
            "pitch": data.get('stabilizer.pitch', 0),
            "yaw": data.get('stabilizer.yaw', 0)
        })

    def _on_battery(self, timestamp, data, logconf):
        self._enqueue_telemetry("battery", timestamp, {
            "voltage": data.get('pm.vbat', 0)
        })

    def _enqueue_telemetry(self, category, timestamp, payload):
        """Marshal telemetry from Crazyflie callbacks into the asyncio queue."""
        if self._loop is None or not self._loop.is_running():
            return

        telem = {
            "type": "telemetry",
            "category": category,
            "timestamp": timestamp,
            "data": payload
        }

        async def _put():
            try:
                self._telemetry_queue.put_nowait(telem)
            except asyncio.QueueFull:
                pass  # Drop oldest if WS is back-pressured

        asyncio.run_coroutine_threadsafe(_put(), self._loop)

    # ------------------------------------------------------------------ #
    #  Command dispatch (run on Crazyflie thread)
    # ------------------------------------------------------------------ #

    def _dispatch_command(self, cmd):
        """Execute a high-level motion command on the drone."""
        if self._motion_commander is None:
            print("[Relay] Command dropped: MotionCommander not ready")
            return

        action = cmd.get("action")
        print(f"[Relay] CMD >> {action}  {cmd}")

        try:
            if action == "takeoff":
                self._motion_commander.take_off(height=cmd.get("height", 0.5))
            elif action == "land":
                self._motion_commander.land()
            elif action == "stop":
                self._motion_commander.stop()
            elif action == "move":
                self._motion_commander.start_linear_motion(
                    cmd.get("vx", 0),
                    cmd.get("vy", 0),
                    cmd.get("vz", 0),
                    cmd.get("yawrate", 0)
                )
            elif action == "up":
                self._motion_commander.up(cmd.get("distance", 0.2))
            elif action == "down":
                self._motion_commander.down(cmd.get("distance", 0.2))
            elif action == "forward":
                self._motion_commander.forward(cmd.get("distance", 0.2))
            elif action == "back":
                self._motion_commander.back(cmd.get("distance", 0.2))
            elif action == "left":
                self._motion_commander.left(cmd.get("distance", 0.2))
            elif action == "right":
                self._motion_commander.right(cmd.get("distance", 0.2))
            else:
                print(f"[Relay] Unknown action: {action}")
        except Exception as e:
            print(f"[Relay] Command failed: {e}")

    # ------------------------------------------------------------------ #
    #  WebSocket Client (asyncio)
    # ------------------------------------------------------------------ #

    async def _ws_client(self):
        """Connect to OpenClaw gateway, authenticate, and handle traffic."""
        while self._running:
            try:
                async with websockets.connect(self.gateway_uri) as ws:
                    print(f"[Relay] WS connected: {self.gateway_uri}")

                    # Handshake
                    await ws.send(json.dumps({
                        "type": "req",
                        "id": "auth-1",
                        "method": "connect",
                        "params": {
                            "role": "node",
                            "auth": {"token": self.token}
                        }
                    }))

                    while self._running:
                        # ---- RX: commands from gateway ----
                        try:
                            msg = await asyncio.wait_for(ws.recv(), timeout=0.05)
                            data = json.loads(msg)
                            if data.get("type") == "command":
                                self._command_queue.put_nowait(data)
                        except asyncio.TimeoutError:
                            pass
                        except websockets.exceptions.ConnectionClosed:
                            break

                        # ---- TX: telemetry to gateway ----
                        try:
                            telem = self._telemetry_queue.get_nowait()
                            await ws.send(json.dumps(telem))
                        except asyncio.QueueEmpty:
                            pass

            except Exception as e:
                print(f"[Relay] WS error: {e}")
                await asyncio.sleep(2)


# ---------------------------------------------------------------------- #
#  Entry point
# ---------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description="Crazyflie Relay for OpenClaw Gateway")
    parser.add_argument("--gateway", default="ws://localhost:18789",
                        help="OpenClaw gateway WebSocket URI (default: ws://localhost:18789)")
    parser.add_argument("--uri", default="radio://0/80/2M/E7E7E7E7E7",
                        help="Crazyflie URI (default: radio://0/80/2M/E7E7E7E7E7)")
    parser.add_argument("--telemetry-hz", type=int, default=10,
                        help="Telemetry publish rate in Hz (default: 10)")
    parser.add_argument("--token", default=None,
                        help="Auth token for the gateway")
    args = parser.parse_args()

    relay = CrazyflieRelay(
        gateway_uri=args.gateway,
        cf_uri=args.uri,
        telemetry_hz=args.telemetry_hz,
        token=args.token
    )

    relay.start()
    try:
        asyncio.run(relay.run())
    except KeyboardInterrupt:
        print("\n[Relay] Shutting down...")
        relay.stop()


if __name__ == "__main__":
    main()

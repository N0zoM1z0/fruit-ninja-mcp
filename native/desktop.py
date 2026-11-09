#!/usr/bin/env python3
"""Persistent XTest executor and screenshot worker; no game state or aiming policy."""
import base64
import ctypes as C
import ctypes.util
import io
import json
import math
import sys
import time
from PIL import ImageGrab


class Desktop:
    def __init__(self, display):
        self.display = display
        self.x = C.CDLL(ctypes.util.find_library("X11"))
        self.xt = C.CDLL(ctypes.util.find_library("Xtst"))
        self.x.XOpenDisplay.argtypes = [C.c_char_p]
        self.x.XOpenDisplay.restype = C.c_void_p
        self.x.XDefaultScreen.argtypes = [C.c_void_p]
        self.x.XDefaultScreen.restype = C.c_int
        self.x.XDisplayWidth.argtypes = [C.c_void_p, C.c_int]
        self.x.XDisplayHeight.argtypes = [C.c_void_p, C.c_int]
        self.x.XFlush.argtypes = [C.c_void_p]
        self.x.XCloseDisplay.argtypes = [C.c_void_p]
        self.xt.XTestFakeMotionEvent.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong]
        self.xt.XTestFakeButtonEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
        self.dpy = self.x.XOpenDisplay(display.encode())
        if not self.dpy:
            raise RuntimeError(f"Cannot open X display {display}")
        self.screen = self.x.XDefaultScreen(self.dpy)
        self.width = self.x.XDisplayWidth(self.dpy, self.screen)
        self.height = self.x.XDisplayHeight(self.dpy, self.screen)
        self.down = False

    def mouse(self, x, y, down):
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [x, y]):
            raise ValueError("Invalid mouse coordinates")
        x, y = round(x), round(y)
        if not (0 <= x < self.width and 0 <= y < self.height):
            raise ValueError("Mouse outside display")
        self.xt.XTestFakeMotionEvent(self.dpy, self.screen, x, y, 0)
        if bool(down) != self.down:
            self.xt.XTestFakeButtonEvent(self.dpy, 1, int(bool(down)), 0)
            self.down = bool(down)
        self.x.XFlush(self.dpy)

    def path(self, points, start_epoch_ms):
        if not (2 <= len(points) <= 256) or points[0]["t_ms"] != 0:
            raise ValueError("Expected 2..256 points beginning at t=0")
        for i, point in enumerate(points):
            x, y, t = (point[k] for k in ["x", "y", "t_ms"])
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [x, y, t]):
                raise ValueError("Invalid path number")
            if not (0 <= round(x) < self.width and 0 <= round(y) < self.height and 0 <= t <= 1000):
                raise ValueError("Path outside display/timing limits")
            if i:
                a = points[i - 1]
                dt = t - a["t_ms"]
                if dt <= 0 or math.hypot(x - a["x"], y - a["y"]) / dt * 1000 > 5000.001:
                    raise ValueError("Invalid path timing/speed")
        self.mouse(points[0]["x"], points[0]["y"], False)
        delay = start_epoch_ms / 1000 - time.time()
        if delay < -0.1:
            raise ValueError("Stroke plan expired before execution")
        time.sleep(max(0, delay))
        begun, epoch = time.monotonic(), time.time() * 1000
        samples, lateness = 0, 0
        try:
            self.mouse(points[0]["x"], points[0]["y"], True)
            for a, b in zip(points, points[1:]):
                count = max(1, math.ceil((b["t_ms"] - a["t_ms"]) / 8))
                for j in range(1, count + 1):
                    u = j / count
                    target = begun + (a["t_ms"] + (b["t_ms"] - a["t_ms"]) * u) / 1000
                    time.sleep(max(0, target - time.monotonic()))
                    lateness = max(lateness, (time.monotonic() - target) * 1000)
                    self.mouse(a["x"] + (b["x"] - a["x"]) * u, a["y"] + (b["y"] - a["y"]) * u, True)
                    samples += 1
        finally:
            self.mouse(points[-1]["x"], points[-1]["y"], False)
        return {"duration_ms": (time.monotonic() - begun) * 1000,
                "schedule_lag_ms": epoch - start_epoch_ms,
                "max_sample_lateness_ms": lateness, "samples": samples}

    def handle(self, request):
        op = request["op"]
        if op == "info":
            return {"width": self.width, "height": self.height, "executor": "persistent-XTest"}
        if op == "mouse":
            self.mouse(request["x"], request["y"], request["down"])
            return {}
        if op == "path":
            return self.path(request["points"], request["start_epoch_ms"])
        if op == "screenshot":
            output = io.BytesIO()
            ImageGrab.grab(xdisplay=self.display).save(output, format="PNG", compress_level=1)
            return {"data": base64.b64encode(output.getvalue()).decode()}
        if op == "close":
            return {}
        raise ValueError("Unknown desktop operation")

    def close(self):
        if self.down:
            self.xt.XTestFakeButtonEvent(self.dpy, 1, 0, 0)
            self.x.XFlush(self.dpy)
        self.x.XCloseDisplay(self.dpy)


if __name__ == "__main__":
    desktop = Desktop(sys.argv[1])
    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                result = {"ok": True, **desktop.handle(request)}
            except Exception as error:
                result = {"ok": False, "error": str(error)}
            print(json.dumps(result, separators=(",", ":")), flush=True)
            if result["ok"] and request["op"] == "close":
                break
    finally:
        desktop.close()

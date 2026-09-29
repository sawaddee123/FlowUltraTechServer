#!/usr/bin/env python3
"""
Python Symbol Captcha Service Daemon
Preloads FastSAM (.pt) and DINOv2 models in memory for sub-second pairwise matching.
Provides a lightweight HTTP API on port 3008.
"""

import argparse
import base64
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

# Ensure root directory is on python path
CURRENT_DIR = Path(__file__).resolve().parent
ROOT_DIR = CURRENT_DIR.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from python.symbol.solver import SymbolCaptchaSolver
from python.constants import SYMBOL_SIMILARITY_THRESHOLD

# Global preloaded solver instance
SOLVER: Optional[SymbolCaptchaSolver] = None


def get_solver() -> SymbolCaptchaSolver:
    global SOLVER
    if SOLVER is None:
        print("[symbol_service] Pre-loading FastSAM and DINOv2 models...")
        SOLVER = SymbolCaptchaSolver()
        print("[symbol_service] ✅ Models loaded and ready in memory.")
    return SOLVER


def decode_image_input(img_data: str) -> Optional[np.ndarray]:
    """Decode base64 string, data URL, or file path to OpenCV BGR numpy array."""
    if not img_data:
        return None

    # Check if it's a file path
    if os.path.exists(img_data):
        return cv2.imread(img_data)

    # Clean base64 data URI prefix
    if "," in img_data:
        img_data = img_data.split(",", 1)[1]

    try:
        raw_bytes = base64.b64decode(img_data)
        nparr = np.frombuffer(raw_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        return img
    except Exception as e:
        print(f"[symbol_service] Failed to decode image: {e}")
        return None


def solve_image_array(img: np.ndarray, threshold: float = SYMBOL_SIMILARITY_THRESHOLD) -> dict:
    solver = get_solver()
    start_time = time.time()
    match = solver.solve(img, threshold=threshold)
    elapsed = time.time() - start_time

    if match is None:
        return {
            "success": False,
            "error": "No matching symbol pair found",
            "symbol_positions": [[0, 0], [0, 0]],
            "time": elapsed,
            "image_width": int(img.shape[1]),
            "image_height": int(img.shape[0]),
        }

    first_pos, second_pos = match["positions"]
    return {
        "success": True,
        "symbol_positions": [
            [int(first_pos[0]), int(first_pos[1])],
            [int(second_pos[0]), int(second_pos[1])],
        ],
        "similarity": float(match.get("similarity", 0.0)),
        "time": elapsed,
        "image_width": int(img.shape[1]),
        "image_height": int(img.shape[0]),
    }


class SymbolServiceHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Concise logging
        sys.stderr.write(f"[symbol_service] {self.address_string()} - {format % args}\n")

    def _send_json(self, status_code: int, data: dict):
        response_bytes = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(response_bytes)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        if self.path in ("/health", "/api/v1/health", "/"):
            solver = get_solver()
            self._send_json(200, {
                "status": "ok",
                "service": "SymbolCaptchaSolver",
                "model_detector": "FastSAM-s.pt",
                "model_extractor": "dinov2_vits14",
                "device": solver.detector.device,
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path in ("/solve", "/api/v1/solve", "/captcha/symbol", "/api/v1/captcha/symbol"):
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._send_json(400, {"error": "Empty body"})
                return

            try:
                body = self.rfile.read(content_length).decode("utf-8")
                payload = json.loads(body)
            except Exception as e:
                self._send_json(400, {"error": f"Invalid JSON payload: {e}"})
                return

            raw_image = payload.get("image") or payload.get("image_path")
            if not raw_image:
                self._send_json(400, {"error": "Missing 'image' or 'image_path' in payload"})
                return

            img = decode_image_input(raw_image)
            if img is None:
                self._send_json(422, {"error": "Could not decode image data"})
                return

            threshold = float(payload.get("threshold", SYMBOL_SIMILARITY_THRESHOLD))
            result = solve_image_array(img, threshold=threshold)
            status_code = 200 if result.get("success") else 422
            self._send_json(status_code, result)
        else:
            self._send_json(404, {"error": "Unknown endpoint"})


def run_service(port: int = 3008, host: str = "127.0.0.1"):
    # Preload solver before accepting connections
    get_solver()

    server_address = (host, port)
    httpd = ThreadingHTTPServer(server_address, SymbolServiceHandler)
    print(f"\n=======================================================")
    print(f"🚀 Python Symbol Solver Daemon listening on http://{host}:{port}")
    print(f"=======================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Symbol Solver Daemon...")
        httpd.shutdown()


def run_cli_single(image_path: str):
    """Direct single-image solve via CLI."""
    img = cv2.imread(image_path)
    if img is None:
        print(json.dumps({"success": False, "error": f"Cannot load image {image_path}"}))
        sys.exit(1)

    result = solve_image_array(img)
    print(json.dumps(result))
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Python Symbol Captcha Service Daemon")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SYMBOL_PORT", "3008")), help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host address")
    parser.add_argument("--solve", type=str, help="Solve a single image file and print JSON (CLI mode)")

    args = parser.parse_args()

    if args.solve:
        run_cli_single(args.solve)
    else:
        run_service(port=args.port, host=args.host)

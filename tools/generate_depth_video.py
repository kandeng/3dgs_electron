#!/usr/bin/env python3
"""
Generate a depth-map video from a source video using Intel MiDaS.

This script processes every frame of the input video through MiDaS
(monocular depth estimation) and writes a grayscale depth video where:
    255 (white) = very close to camera (walls, obstacles)
    0   (black) = very far from camera (sky, distant background)

The output can be loaded in Three.js as a depth texture for collision
detection between the 3D drone and objects in the background video.

Usage:
    python3 tools/generate_depth_video.py
    python3 tools/generate_depth_video.py --input asset/counter_strike.mp4 --output asset/counter_strike_depth.mp4

Requirements:
    pip install torch torchvision opencv-python timm

Note:
    First run downloads the MiDaS model weights (~1.4 GB for DPT_Large).
    Processing is much faster on CUDA GPU. CPU works but is slower.
"""

import argparse
import cv2
import numpy as np
import torch
import os


def load_midas_model():
    """Load MiDaS depth estimation model via PyTorch Hub."""
    print("[Depth] Loading MiDaS model from PyTorch Hub...")

    # DPT_Large  = best quality, ~1.4 GB, slower
    # DPT_Hybrid = good quality, ~500 MB, faster
    # MiDaS      = legacy model, ~100 MB, fastest
    model_type = "DPT_Large"

    midas = torch.hub.load("intel-isl/MiDaS", model_type, trust_repo=True)

    device = torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")
    midas.to(device)
    midas.eval()

    print(f"[Depth] Model '{model_type}' loaded on {device}")
    return midas, device, model_type


def get_transforms(model_type):
    """Get the correct input transforms for the selected MiDaS variant."""
    midas_transforms = torch.hub.load("intel-isl/MiDaS", "transforms", trust_repo=True)

    if model_type in ("DPT_Large", "DPT_Hybrid"):
        transform = midas_transforms.dpt_transform
    else:
        transform = midas_transforms.small_transform

    return transform


def process_frame(frame_bgr, model, transform, device):
    """
    Run MiDaS on a single OpenCV BGR frame.

    Returns a uint8 grayscale depth map (0-255) where higher values
    mean closer to the camera.
    """
    # Convert BGR -> RGB for MiDaS
    img_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

    # Prepare input batch
    input_batch = transform(img_rgb).to(device)

    # Inference
    with torch.no_grad():
        prediction = model(input_batch)
        # Resize prediction back to original image resolution
        prediction = torch.nn.functional.interpolate(
            prediction.unsqueeze(1),
            size=img_rgb.shape[:2],
            mode="bicubic",
            align_corners=False,
        ).squeeze()

    # Move to CPU and convert to numpy
    depth = prediction.cpu().numpy()

    # Normalize to 0-255 (MiDaS outputs relative inverse depth)
    depth_min = depth.min()
    depth_max = depth.max()
    if depth_max - depth_min > 1e-6:
        depth = (depth - depth_min) / (depth_max - depth_min)
    else:
        depth = np.zeros_like(depth)

    depth = (depth * 255).astype(np.uint8)
    return depth


def main():
    parser = argparse.ArgumentParser(
        description="Generate a depth-map video from a source video using MiDaS"
    )
    parser.add_argument(
        "--input",
        default="asset/counter_strike.mp4",
        help="Path to input video (default: asset/counter_strike.mp4)",
    )
    parser.add_argument(
        "--output",
        default="asset/counter_strike_depth.mp4",
        help="Path to output depth video (default: asset/counter_strike_depth.mp4)",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=30,
        help="Output video FPS (default: 30)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"[Error] Input video not found: {args.input}")
        return 1

    # Create output directory if needed
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir)

    # Load MiDaS
    model, device, model_type = load_midas_model()
    transform = get_transforms(model_type)

    # Open input video
    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        print(f"[Error] Cannot open input video: {args.input}")
        return 1

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    input_fps = cap.get(cv2.CAP_PROP_FPS)

    output_fps = args.fps if args.fps else input_fps

    print(f"[Depth] Input:  {width}x{height} @ {input_fps:.2f} fps, {total_frames} frames")
    print(f"[Depth] Output: {width}x{height} @ {output_fps:.2f} fps")

    # Prepare output video writer (grayscale)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(
        args.output, fourcc, output_fps, (width, height), isColor=False
    )
    if not out.isOpened():
        print(f"[Error] Cannot open output video for writing: {args.output}")
        return 1

    frame_idx = 0
    print("[Depth] Processing frames...")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        depth_map = process_frame(frame, model, transform, device)
        out.write(depth_map)

        frame_idx += 1
        if frame_idx % 30 == 0 or frame_idx == total_frames:
            pct = (frame_idx / total_frames) * 100 if total_frames > 0 else 0
            print(f"[Depth] Progress: {frame_idx}/{total_frames} frames ({pct:.1f}%)")

    cap.release()
    out.release()

    print(f"[Depth] Done! Output saved to: {args.output}")
    return 0


if __name__ == "__main__":
    exit(main())

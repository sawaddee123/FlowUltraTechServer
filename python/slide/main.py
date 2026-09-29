#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Slide Captcha Solver - Main Entry Point

Usage:
    python -m python.slide.main --image slide.jpg
    python -m python.slide.main --screen slide.jpg
    python -m python.slide.main -i images/slide --visualize
"""

import sys
import argparse
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from python.constants import SLIDE_DEBUG_PATH, SLIDE_MODEL_NAME
from python.slide import solve_slide_captcha, SlideCaptchaSolver


def main():
    parser = argparse.ArgumentParser(
        description="Slide Captcha Solver",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Solve single image
  python -m python.slide.main --image slide.jpg
  python -m python.slide.main --screen slide.jpg
  
  # Solve with visualization
  python -m python.slide.main --image slide.jpg --visualize
  
  # Process directory
  python -m python.slide.main -i images/slide --visualize
  
  # Custom model
  python -m python.slide.main --image slide.jpg --model custom-model.pt
        """
    )
    
    parser.add_argument(
        '--image', '--screen',
        dest='image',
        type=str,
        help='Single slide image path'
    )
    
    parser.add_argument(
        '--dir', '-i',
        type=str,
        help='Directory containing slide images'
    )
    
    parser.add_argument(
        '--model', '-m',
        type=str,
        default=SLIDE_MODEL_NAME,
        help=f'Path to YOLO model (default: {SLIDE_MODEL_NAME})'
    )
    
    parser.add_argument(
        '--visualize', '-v',
        action='store_true',
        help='Show visualization of results'
    )
    
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Save debug images showing detection process'
    )
    
    parser.add_argument(
        '--debug-path',
        type=str,
        default='debug_slide',
        help='Directory to save debug images (default: debug_slide)'
    )
    
    parser.add_argument(
        '--save',
        type=str,
        help='Save visualization to this path'
    )
    
    parser.add_argument(
        '--all',
        action='store_true',
        help='Process all images in directory'
    )
    
    args = parser.parse_args()
    
    # Get image paths
    if args.dir:
        image_dir = Path(args.dir)
        if not image_dir.exists():
            print(f"❌ Directory not found: {args.dir}")
            return 1
        
        images = list(image_dir.glob("*.jpg")) + list(image_dir.glob("*.png"))
        if len(images) == 0:
            print(f"❌ No images found in {args.dir}")
            return 1
        
        print(f"📁 Found {len(images)} images in {args.dir}")
        
        # Process one or all
        if args.all:
            image_paths = images
        else:
            image_paths = [images[0]]
            print(f"🖼️  Processing first image: {images[0].name}")
        
    elif args.image:
        image_paths = [Path(args.image)]
    else:
        # Default: use images/slide directory
        default_dir = Path(__file__).parent.parent.parent / "images" / "slide"
        if default_dir.exists():
            images = list(default_dir.glob("*.jpg")) + list(default_dir.glob("*.png"))
            if len(images) > 0:
                image_paths = [images[0]]
                print(f"📁 Using default: {images[0].name}")
            else:
                print("❌ No images found in default directory")
                parser.print_help()
                return 1
        else:
            print("❌ Must provide --image or --dir")
            parser.print_help()
            return 1
    
    # Solve
    try:
        solver = SlideCaptchaSolver(args.model)
        
        success_count = 0
        
        for img_path in image_paths:
            print(f"\n{'='*70}")
            print(f"📷 Processing: {img_path.name}")
            print(f"{'='*70}")
            
            if args.visualize or args.debug:
                pos = solver.detect_with_visualization(
                    str(img_path), 
                    show=args.visualize,
                    save_path=args.save,
                    debug=args.debug,
                    debug_path=args.debug_path
                )
            else:
                pos = solver.solve(str(img_path))
            
            if pos[0] > 0 or pos[1] > 0:
                success_count += 1
                print(f"✅ Position: ({pos[0]}, {pos[1]})")
            else:
                print("⚠️  No puzzle piece detected")
        
        # Summary
        if len(image_paths) > 1:
            print(f"\n{'='*70}")
            print(f"📊 Summary: {success_count}/{len(image_paths)} successful")
            print(f"{'='*70}")
        
        return 0 if success_count > 0 else 1
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())

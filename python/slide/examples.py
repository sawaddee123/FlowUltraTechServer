#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Example: Slide Captcha Solver Usage
"""

import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from python.slide import solve_slide_captcha, SlideCaptchaSolver
import cv2


def example_1_simple():
    """Example 1: Simple usage"""
    print("\n" + "="*70)
    print("Example 1: Simple Usage")
    print("="*70)
    
    x, y = solve_slide_captcha(
        image='images/slide/slide1.jpg',
        visualize=True
    )
    
    if x > 0 or y > 0:
        print(f"\nSlide to: ({x}, {y})")
    else:
        print("\nNo puzzle piece detected")


def example_2_reusable_solver():
    """Example 2: Reusable solver for multiple slides"""
    print("\n" + "="*70)
    print("Example 2: Reusable Solver")
    print("="*70)
    
    # Initialize once
    solver = SlideCaptchaSolver('jigsaw-model.pt')
    
    # Solve multiple slides
    slides = [
        'images/slide/slide1.jpg',
        'images/slide/slide2.jpg',
        # Add more slides
    ]
    
    for i, slide in enumerate(slides):
        try:
            x, y = solver.solve(slide)
            print(f"Slide {i + 1}: Move to ({x}, {y})")
        except Exception as e:
            print(f"Slide {i + 1}: Error - {e}")


def example_3_with_numpy_array():
    """Example 3: Using numpy array"""
    print("\n" + "="*70)
    print("Example 3: Using NumPy Array")
    print("="*70)
    
    # Load image
    img = cv2.imread('images/slide/slide1.jpg')
    
    # Solve
    solver = SlideCaptchaSolver()
    x, y = solver.find_position(img)
    
    print(f"\nPosition: ({x}, {y})")


def example_4_with_confidence():
    """Example 4: Confidence threshold"""
    print("\n" + "="*70)
    print("Example 4: Confidence Threshold")
    print("="*70)
    
    solver = SlideCaptchaSolver()
    
    # Test different confidence thresholds
    thresholds = [0.0, 0.3, 0.5, 0.7]
    
    for threshold in thresholds:
        x, y = solver.find_position(
            'images/slide/slide1.jpg',
            conf_threshold=threshold
        )
        print(f"Threshold {threshold}: Position ({x}, {y})")


def example_5_batch_processing():
    """Example 5: Process multiple images in directory"""
    print("\n" + "="*70)
    print("Example 5: Batch Processing")
    print("="*70)
    
    solver = SlideCaptchaSolver()
    
    slide_dir = Path('images/slide')
    slides = list(slide_dir.glob('*.jpg')) + list(slide_dir.glob('*.png'))
    
    results = []
    for slide_path in slides:
        x, y = solver.find_position(str(slide_path))
        results.append({
            'file': slide_path.name,
            'position': (x, y),
            'success': x > 0 or y > 0
        })
    
    # Summary
    success_count = sum(1 for r in results if r['success'])
    print(f"\nProcessed: {len(results)} images")
    print(f"Success: {success_count}/{len(results)}")
    
    for result in results:
        status = "✅" if result['success'] else "❌"
        print(f"{status} {result['file']}: {result['position']}")


def example_6_visualization():
    """Example 6: Visualize and save result"""
    print("\n" + "="*70)
    print("Example 6: Visualization")
    print("="*70)
    
    solver = SlideCaptchaSolver()
    
    # Detect with visualization
    x, y = solver.detect_with_visualization(
        image_path='images/slide/slide1.jpg',
        show=True,
        save_path='slide_result.jpg'
    )
    
    print(f"\nPosition: ({x}, {y})")
    print("Visualization saved to: slide_result.jpg")


def example_7_error_handling():
    """Example 7: Error handling"""
    print("\n" + "="*70)
    print("Example 7: Error Handling")
    print("="*70)
    
    solver = SlideCaptchaSolver()
    
    # Handle missing file
    try:
        x, y = solver.find_position('nonexistent.jpg')
    except ValueError as e:
        print(f"Error caught: {e}")
    
    # Handle no detection
    x, y = solver.find_position(
        'images/slide/slide1.jpg',
        conf_threshold=0.99  # Very high threshold
    )
    
    if x == 0 and y == 0:
        print("No puzzle piece detected - threshold may be too high")
    else:
        print(f"Position: ({x}, {y})")


def example_8_web_automation():
    """Example 8: Web automation simulation"""
    print("\n" + "="*70)
    print("Example 8: Web Automation Simulation")
    print("="*70)
    
    solver = SlideCaptchaSolver()
    
    # Simulate web scraping workflow
    print("\n1. Download captcha image...")
    captcha_path = 'images/slide/slide1.jpg'
    
    print("2. Solve captcha...")
    x, y = solver.solve(captcha_path, verbose=False)
    
    print("3. Move slider...")
    if x > 0:
        print(f"   -> Moving slider to position {x}")
        print("   -> Success!")
    else:
        print("   -> Failed to detect puzzle piece")


if __name__ == "__main__":
    print("\n" + "#"*70)
    print("# Slide Captcha Solver Examples")
    print("#"*70)
    
    # Run examples
    try:
        # example_1_simple()
        # example_2_reusable_solver()
        # example_3_with_numpy_array()
        # example_4_with_confidence()
        # example_5_batch_processing()
        # example_6_visualization()
        example_7_error_handling()
        # example_8_web_automation()
        
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()

# Slide Captcha Solver

Jigsaw puzzle piece detection using YOLO

## 🎯 Overview

This solver detects the position of a sliding puzzle piece in a captcha image using a trained YOLO model.

## 📦 Module

### `solver.py`
- YOLO-based object detection
- Finds puzzle piece center position
- Visualization support

## 🚀 Usage

### Command Line

```bash
# Solve single image
python -m python.slide.main --image slide.jpg

# With visualization
python -m python.slide.main --image slide.jpg --visualize

# Process directory (first image)
python -m python.slide.main -i images/slide

# Process all images in directory
python -m python.slide.main -i images/slide --all

# Save result
python -m python.slide.main --image slide.jpg --visualize --save result.jpg

# Custom model
python -m python.slide.main --image slide.jpg --model custom-jigsaw.pt
```

### Python API

```python
from python.slide import solve_slide_captcha

# Simple usage
position = solve_slide_captcha(
    image='slide.jpg',
    visualize=True
)

x, y = position
print(f"Slide to position: ({x}, {y})")
```

### Advanced Usage

```python
from python.slide import SlideCaptchaSolver

# Initialize once, reuse multiple times
solver = SlideCaptchaSolver(model_path="jigsaw-model.pt")

# Solve multiple captchas
for slide_image in slides:
    position = solver.solve(slide_image, verbose=True)
    x, y = position
    
    if x > 0 or y > 0:
        print(f"Move slider to: ({x}, {y})")
    else:
        print("No puzzle piece detected")

# With visualization
position = solver.detect_with_visualization(
    image_path='slide.jpg',
    show=True,
    save_path='result.jpg'
)
```

## ⚙️ Model

### Default Model
- **File**: `jigsaw-model.pt`
- **Location**: `python_tests/jigsaw-model.pt`
- **Type**: YOLOv8 trained on jigsaw puzzle pieces
- **Classes**: 
  - Class 0: Puzzle piece (target)
  - Other classes: Distractors

### Custom Model

You can train your own YOLO model:

```python
from ultralytics import YOLO

# Train
model = YOLO('yolov8n.pt')
model.train(data='jigsaw.yaml', epochs=100)

# Use with solver
solver = SlideCaptchaSolver('runs/detect/train/weights/best.pt')
```

## 🔧 How It Works

```
[Slide Image]
      ↓
1. YOLO Detection
   - Detect all objects
   - Filter class 0 (puzzle piece)
      ↓
2. Find Best Match
   - Highest confidence
   - Calculate center (x, y)
      ↓
3. Return Position
   - Center coordinates
   - Ready for sliding action
```

## 📊 Performance

- **Accuracy**: ~98% on standard jigsaw captchas
- **Speed**: ~50ms per image (GPU)
- **GPU Memory**: ~1GB

## 🎨 Visualization

When using `--visualize`:
- **Green boxes**: All detected objects
- **Red box**: Best match (puzzle piece)
- **Red circle**: Center point (target position)
- **Text**: Position coordinates and confidence

## 🐛 Troubleshooting

### Model not found
```bash
# Check if model exists
ls python_tests/jigsaw-model.pt

# Or provide full path
python -m python.slide.main --image slide.jpg --model /path/to/model.pt
```

### No puzzle piece detected
- Check if image contains a puzzle piece
- Try lowering confidence threshold
- Verify model is correct type

### Wrong position
- Model may need retraining
- Check if image quality is good
- Verify puzzle piece is visible

## 📝 Requirements

```
ultralytics>=8.0.0
torch>=2.0.0
opencv-python>=4.8.0
numpy>=1.24.0
```

## 🔗 Integration

### Web Automation

```python
from selenium import webdriver
from python.slide import solve_slide_captcha

# Get captcha image
driver = webdriver.Chrome()
driver.get('https://example.com/captcha')
captcha_element = driver.find_element_by_id('captcha')
captcha_element.screenshot('slide.jpg')

# Solve
x, y = solve_slide_captcha('slide.jpg')

# Move slider
slider = driver.find_element_by_id('slider')
action = webdriver.ActionChains(driver)
action.click_and_hold(slider).move_by_offset(x, 0).release().perform()
```

### API Server

```python
from flask import Flask, request, jsonify
from python.slide import SlideCaptchaSolver

app = Flask(__name__)
solver = SlideCaptchaSolver()

@app.route('/solve', methods=['POST'])
def solve():
    file = request.files['image']
    img = cv2.imdecode(np.frombuffer(file.read(), np.uint8), cv2.IMREAD_COLOR)
    
    x, y = solver.solve(img, verbose=False)
    
    return jsonify({'x': x, 'y': y})

if __name__ == '__main__':
    app.run()
```

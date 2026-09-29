# Python Captcha Solvers

Modular captcha solving library with Symbol (3D Object) and Slide (Jigsaw) solvers.

## 📦 Modules

### 🎯 Symbol Captcha Solver
**Location**: `python/symbol/`

3D object matching using FastSAM + DINOv2:
- Detects and segments objects
- Matches symbols to target objects
- Returns click positions

[Full Documentation](symbol/README.md)

**Quick Start**:
```python
from python.symbol import solve_symbol_captcha

matches = solve_symbol_captcha(
    symbol_images=['symbol1.jpg', 'symbol2.jpg'],
    screen_image='screen.jpg'
)
```

### 🧩 Slide Captcha Solver
**Location**: `python/slide/`

Jigsaw puzzle detection using YOLO:
- Detects puzzle piece position
- Returns slide coordinates
- Fast and accurate

[Full Documentation](slide/README.md)

**Quick Start**:
```python
from python.slide import solve_slide_captcha

x, y = solve_slide_captcha('slide.jpg')
```

## 🚀 Installation

### Requirements

```bash
pip install ultralytics transformers torch opencv-python numpy Pillow
```

### Models

**Symbol Solver**:
- FastSAM: Auto-downloads from Ultralytics
- DINOv2: Auto-downloads from HuggingFace

**Slide Solver**:
- YOLO model: `python_tests/jigsaw-model.pt` (required)

## 📚 Usage Examples

### Command Line

#### Symbol Solver
```bash
# Solve with visualization
python -m python.symbol.main -s sym1.jpg -s sym2.jpg --screen screen.jpg -v

# Use directory
python -m python.symbol.main -i images/symbol --visualize

# Custom threshold
python -m python.symbol.main -i images/symbol -t 0.8
```

#### Slide Solver
```bash
# Solve single image
python -m python.slide.main --image slide.jpg -v

# Process directory
python -m python.slide.main -i images/slide --all

# Custom model
python -m python.slide.main --image slide.jpg --model custom.pt
```

#### Full Debug Batch
```bash
# Run both solvers for every image in images/symbol and images/slide
python -m python.full_debug

# Run only one captcha type
python -m python.full_debug --type symbol
python -m python.full_debug --type slide

# Use custom output folder and symbol threshold
python -m python.full_debug --output debug_all --threshold 0.80
```

### Python API

#### Symbol Solver - Simple
```python
from python.symbol import solve_symbol_captcha

# Solve and get positions
matches = solve_symbol_captcha(
    symbol_images=['sym1.jpg', 'sym2.jpg'],
    screen_image='screen.jpg',
    threshold=0.75,
    visualize=True
)

# Process results
for match in matches:
    symbol_id = match['symbol_id']
    x, y = match['position']
    similarity = match['similarity']
    print(f"Symbol {symbol_id}: Click at ({x}, {y}) - {similarity:.2%}")
```

#### Symbol Solver - Advanced
```python
from python.symbol import SymbolCaptchaSolver
import cv2

# Initialize once (faster for multiple captchas)
solver = SymbolCaptchaSolver(
    fastsam_model="FastSAM-x.pt",
    dino_model="facebook/dinov2-small"
)

# Solve multiple captchas
for captcha in captchas:
    matches = solver.solve(
        symbol_images=captcha['symbols'],
        screen_image=captcha['screen'],
        threshold=0.75
    )
    
    # Click on matches
    for match in matches:
        x, y = match['position']
        # Your click automation here
```

#### Slide Solver - Simple
```python
from python.slide import solve_slide_captcha

# Get position
x, y = solve_slide_captcha('slide.jpg', visualize=True)

if x > 0:
    print(f"Slide to: ({x}, {y})")
    # Your slide automation here
```

#### Slide Solver - Advanced
```python
from python.slide import SlideCaptchaSolver

# Initialize once
solver = SlideCaptchaSolver('jigsaw-model.pt')

# Solve multiple
for slide in slides:
    x, y = solver.find_position(slide)
    
    if x > 0:
        # Move slider
        move_slider_to(x)
```

### Web Automation Example

```python
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from python.symbol import solve_symbol_captcha
from python.slide import solve_slide_captcha

driver = webdriver.Chrome()
driver.get('https://example.com/captcha')

# Symbol Captcha
if captcha_type == 'symbol':
    # Get symbols and screen
    symbol_elements = driver.find_elements_by_class_name('symbol')
    screen_element = driver.find_element_by_id('screen')
    
    # Save screenshots
    symbols = []
    for i, elem in enumerate(symbol_elements):
        path = f'symbol_{i}.jpg'
        elem.screenshot(path)
        symbols.append(path)
    
    screen_element.screenshot('screen.jpg')
    
    # Solve
    matches = solve_symbol_captcha(symbols, 'screen.jpg')
    
    # Click matches
    for match in matches:
        x, y = match['position']
        # Convert to screen coordinates and click
        action = ActionChains(driver)
        action.move_to_element_with_offset(screen_element, x, y).click().perform()

# Slide Captcha
elif captcha_type == 'slide':
    # Get captcha image
    captcha_element = driver.find_element_by_id('captcha')
    captcha_element.screenshot('slide.jpg')
    
    # Solve
    x, y = solve_slide_captcha('slide.jpg')
    
    # Slide
    slider = driver.find_element_by_id('slider')
    action = ActionChains(driver)
    action.click_and_hold(slider).move_by_offset(x, 0).release().perform()
```

## 🔧 Configuration

### Symbol Solver

**Detection** (`python/symbol/detection.py`):
```python
FASTSAM_MODEL = "FastSAM-x.pt"      # or "FastSAM-s.pt" (faster)
CONF_THRESHOLD = 0.65               # 0.4-0.8 (lower = more objects)
IOU_THRESHOLD = 0.3                 # 0.3-0.7 (lower = less overlap)
MIN_AREA = 1500                     # Minimum object size
MAX_AREA = 35000                    # Maximum object size
```

**Matching** (`python/symbol/matching.py`):
```python
SIMILARITY_THRESHOLD = 0.75         # 0.7-0.85 (higher = stricter)
```

**Features** (`python/symbol/features.py`):
```python
DINO_MODEL = "facebook/dinov2-small"  # or dinov2-base, dinov2-large
```

### Slide Solver

**Model** (`python/slide/solver.py`):
```python
DEFAULT_MODEL = "jigsaw-model.pt"   # Custom YOLO model path
```

## 📊 Performance

| Solver | Accuracy | Speed (GPU) | Memory |
|--------|----------|-------------|--------|
| Symbol | ~95% | 2-3s | ~4GB |
| Slide | ~98% | ~50ms | ~1GB |

## 🏗️ Project Structure

```
python/
├── symbol/                 # Symbol captcha solver
│   ├── __init__.py
│   ├── preprocessing.py    # Background removal
│   ├── detection.py        # FastSAM detection
│   ├── features.py         # DINOv2 features
│   ├── matching.py         # Symbol matching
│   ├── solver.py           # Main solver
│   ├── main.py             # CLI entry point
│   └── README.md
│
├── slide/                  # Slide captcha solver
│   ├── __init__.py
│   ├── solver.py           # YOLO detection
│   ├── main.py             # CLI entry point
│   └── README.md
│
└── README.md               # This file
```

## 🧪 Testing

### Symbol Solver
```bash
# Test with sample images
python -m python.symbol.main -i images/symbol -v

# Test with custom threshold
python -m python.symbol.main -i images/symbol -t 0.8 -v
```

### Slide Solver
```bash
# Test single image
python -m python.slide.main -i images/slide -v

# Test all images
python -m python.slide.main -i images/slide --all
```

## 🐛 Troubleshooting

### Symbol Solver

**No objects detected**:
- Lower `MIN_AREA` if objects are small
- Lower `CONF_THRESHOLD` to detect more objects
- Check preprocessing (RGB threshold may be too strict)

**Wrong matches**:
- Increase `SIMILARITY_THRESHOLD` (stricter matching)
- Use larger DINOv2 model (`dinov2-base` or `dinov2-large`)
- Check if symbols are clear and well-cropped

**Objects merged**:
- Lower `IOU_THRESHOLD` (more aggressive NMS)
- Use `FastSAM-x.pt` instead of `FastSAM-s.pt`

### Slide Solver

**Model not found**:
```bash
ls python_tests/jigsaw-model.pt
# If missing, check model location or provide full path
```

**Wrong position**:
- Verify puzzle piece is visible and clear
- Check image quality
- May need model retraining for different puzzle types

## 📝 Requirements

```txt
ultralytics>=8.0.0
transformers>=4.30.0
torch>=2.0.0
opencv-python>=4.8.0
numpy>=1.24.0
Pillow>=10.0.0
```

## 📄 License

MIT License - See LICENSE file for details

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📧 Support

For issues and questions:
- Check documentation in `symbol/README.md` and `slide/README.md`
- Review troubleshooting sections
- Open an issue on GitHub

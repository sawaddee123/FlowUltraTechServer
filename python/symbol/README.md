# Symbol Captcha Solver

Find the two most visually similar 3D objects in one captcha image using FastSAM and DINOv2.

## Pipeline

1. Remove the bright background.
2. Detect candidate objects with FastSAM and filter invalid masks.
3. Draw each FastSAM mask as a binary silhouette: symbol = black, all other pixels = white.
4. Extract one DINOv2 feature vector from each silhouette.
5. Compare every unordered object pair once: `n * (n - 1) / 2` comparisons.
6. Return the two centers for the pair with the highest cosine similarity, provided it meets the threshold.

For example, four objects produce the pairs `(1,2)`, `(1,3)`, `(1,4)`, `(2,3)`, `(2,4)`, and `(3,4)`. Pairs are unordered, so `(2,1)` is not compared again.

## Command Line

```bash
python -m python.symbol.main --screen screen.jpg
python -m python.symbol.main --screen screen.jpg --threshold 0.80 --debug
python -m python.symbol.main --screen screen.jpg --save result.jpg
```

## Python API

```python
from python.symbol import solve_symbol_captcha

match = solve_symbol_captcha("screen.jpg", threshold=0.75)
if match is not None:
    first_position, second_position = match["positions"]
    print(first_position, second_position, match["similarity"])
```

The match result contains `object_indices`, `positions`, `bboxes`, and `similarity`. It is `None` when fewer than two valid objects are detected or no pair meets the threshold.

## Configuration

Detection constants are in `detection.py`; the default pair similarity threshold is in `matching.py`.

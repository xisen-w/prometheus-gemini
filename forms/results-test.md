Settings: a field is kept when readers holding at least 30% of the vote report it; readers: hydrogen, neon, carbon, argon (each on the original and an enhanced view); a red-team verifier's vote counts 0x (0 = not used); prompt v2. A predicted pair counts when its label is at least 70% similar and its value at least 80% similar to an annotated pair (normalised edit distance, case and punctuation ignored).

## Test: FUNSD's 50 test forms (never seen during development)

### Original scans

| System | Precision | Recall | F1 | Exact-match F1 | Fields found / predicted / in the annotations |
|---|---|---|---|---|---|
| single hydrogen | 59.4 | 72.5 | **65.3** | 57.1 | 413 / 695 / 570 |
| single neon | 68.8 | 73.2 | **70.9** | 61.7 | 417 / 606 / 570 |
| single carbon | 63.4 | 73.9 | **68.2** | 59.2 | 421 / 664 / 570 |
| single argon | 65.7 | 76.1 | **70.5** | 61.1 | 434 / 661 / 570 |
| swarm, vote only | 65.6 | 74.4 | **69.7** | 59.7 | 424 / 646 / 570 |
| swarm (readers + red team) | 66.7 | 74.4 | **70.3** | 60.2 | 424 / 636 / 570 |

Swarm vs the best single call (single neon): -0.6 F1 points, 95% interval -4.7 to 3.0 (paired bootstrap over forms; -0.3 standard errors). Better on 8 forms, worse on 8, of 50.

| Per-form F1 | Worst form | 10th percentile | Median | Forms under 30 |
|---|---|---|---|---|
| single neon | 0.0 | 16.7 | 80.0 | 8 |
| swarm (readers + red team) | 0.0 | 21.6 | 80.0 | 7 |

### Degraded copies (rotated 90°/180°, skewed + blurred, half resolution + heavy JPEG, dim + tilted)

| System | Precision | Recall | F1 | Exact-match F1 | Fields found / predicted / in the annotations |
|---|---|---|---|---|---|
| single hydrogen | 60.3 | 69.6 | **64.7** | 54.7 | 397 / 658 / 570 |
| single neon | 66.5 | 73.5 | **69.8** | 59.5 | 419 / 630 / 570 |
| single carbon | 70.5 | 74.4 | **72.4** | 61.0 | 424 / 601 / 570 |
| single argon | 64.2 | 74.4 | **68.9** | 58.4 | 424 / 660 / 570 |
| swarm, vote only | 65.4 | 73.0 | **69.0** | 58.2 | 416 / 636 / 570 |
| swarm (readers + red team) | 65.4 | 73.0 | **69.0** | 58.2 | 416 / 636 / 570 |

Swarm vs the best single call (single carbon): -3.4 F1 points, 95% interval -9.2 to 0.8 (paired bootstrap over forms; -1.3 standard errors). Better on 11 forms, worse on 13, of 50.

| Per-form F1 | Worst form | 10th percentile | Median | Forms under 30 |
|---|---|---|---|---|
| single carbon | 0.0 | 0.0 | 81.8 | 8 |
| swarm (readers + red team) | 0.0 | 32.3 | 76.5 | 5 |

| Degradation | Forms | Best single F1 | Swarm F1 |
|---|---|---|---|
| rot90 | 10 | 85.3 | 72.9 |
| rot180 | 10 | 64.4 | 62.6 |
| skew | 10 | 73.2 | 73.0 |
| lowres | 10 | 59.0 | 61.4 |
| dim | 10 | 76.8 | 73.8 |


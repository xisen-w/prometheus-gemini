Settings: a field is kept when readers holding at least 30% of the vote report it; readers: hydrogen, neon, carbon, argon (each on the original and an enhanced view); a red-team verifier's vote counts 0x (0 = not used); prompt v2. A predicted pair counts when its label is at least 70% similar and its value at least 80% similar to an annotated pair (normalised edit distance, case and punctuation ignored).

## Dev: 20 forms from FUNSD's training set

### Original scans

| System | Precision | Recall | F1 | Exact-match F1 | Fields found / predicted / in the annotations |
|---|---|---|---|---|---|
| single hydrogen | 71.5 | 65.0 | **68.1** | 61.5 | 228 / 319 / 351 |
| single neon | 72.3 | 66.1 | **69.0** | 62.2 | 232 / 321 / 351 |
| single carbon | 72.9 | 66.7 | **69.6** | 62.2 | 234 / 321 / 351 |
| single argon | 72.7 | 67.5 | **70.0** | 63.2 | 237 / 326 / 351 |
| swarm, vote only | 71.8 | 65.2 | **68.4** | 60.0 | 229 / 319 / 351 |
| swarm (readers + red team) | 71.8 | 65.2 | **68.4** | 60.0 | 229 / 319 / 351 |

Swarm vs the best single call (single argon): -1.7 F1 points, 95% interval -3.4 to 0.3 (paired bootstrap over forms; -1.8 standard errors). Better on 5 forms, worse on 7, of 20.

| Per-form F1 | Worst form | 10th percentile | Median | Forms under 30 |
|---|---|---|---|---|
| single argon | 0.0 | 33.3 | 70.0 | 2 |
| swarm (readers + red team) | 0.0 | 31.7 | 63.2 | 2 |

### Degraded copies (rotated 90°/180°, skewed + blurred, half resolution + heavy JPEG, dim + tilted)

| System | Precision | Recall | F1 | Exact-match F1 | Fields found / predicted / in the annotations |
|---|---|---|---|---|---|
| single hydrogen | 69.4 | 62.7 | **65.9** | 55.7 | 220 / 317 / 351 |
| single neon | 69.3 | 63.5 | **66.3** | 58.5 | 223 / 322 / 351 |
| single carbon | 74.3 | 62.7 | **68.0** | 58.1 | 220 / 296 / 351 |
| single argon | 72.2 | 65.2 | **68.6** | 58.1 | 229 / 317 / 351 |
| swarm, vote only | 68.9 | 63.2 | **66.0** | 56.2 | 222 / 322 / 351 |
| swarm (readers + red team) | 68.9 | 63.2 | **66.0** | 56.2 | 222 / 322 / 351 |

Swarm vs the best single call (single argon): -2.6 F1 points, 95% interval -5.6 to 0.6 (paired bootstrap over forms; -1.6 standard errors). Better on 4 forms, worse on 12, of 20.

| Per-form F1 | Worst form | 10th percentile | Median | Forms under 30 |
|---|---|---|---|---|
| single argon | 0.0 | 26.7 | 70.0 | 3 |
| swarm (readers + red team) | 0.0 | 22.2 | 65.0 | 3 |

| Degradation | Forms | Best single F1 | Swarm F1 |
|---|---|---|---|
| rot90 | 4 | 87.6 | 83.1 |
| rot180 | 4 | 78.1 | 71.0 |
| skew | 4 | 61.5 | 64.1 |
| lowres | 4 | 56.9 | 58.4 |
| dim | 4 | 58.4 | 55.6 |


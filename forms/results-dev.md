Settings: a field is kept when readers holding at least 50% of the vote report it; a red-team verifier's vote counts 1x. A predicted pair counts when its label is at least 70% similar and its value at least 80% similar to an annotated pair (normalised edit distance, case and punctuation ignored).

## Dev: 20 forms from FUNSD's training set

### Original scans

| System | Precision | Recall | F1 | Exact-match F1 | Fields found / predicted / in the annotations |
|---|---|---|---|---|---|
| single hydrogen | 54.5 | 53.8 | **54.2** | 48.7 | 189 / 347 / 351 |
| single neon | 40.7 | 55.6 | **47.0** | 42.7 | 195 / 479 / 351 |
| single carbon | 38.4 | 48.4 | **42.8** | 37.8 | 170 / 443 / 351 |
| single argon | 41.5 | 55.3 | **47.4** | 42.5 | 194 / 468 / 351 |
| swarm, vote only (8 readers) | 57.5 | 52.4 | **54.8** | 49.2 | 184 / 320 / 351 |
| swarm (8 readers + 2 red team) | 47.8 | 52.7 | **50.1** | 44.7 | 185 / 387 / 351 |

Swarm vs the best single call (single hydrogen): -4.0 F1 points, 95% interval -14.8 to 7.9 (paired bootstrap over forms; -0.7 standard errors). Better on 3 forms, worse on 6, of 20.

### Degraded copies (rotated 90°/180°, skewed + blurred, half resolution + heavy JPEG, dim + tilted)

| System | Precision | Recall | F1 | Exact-match F1 | Fields found / predicted / in the annotations |
|---|---|---|---|---|---|
| single hydrogen | 54.7 | 53.6 | **54.1** | 46.6 | 188 / 344 / 351 |
| single neon | 53.3 | 55.6 | **54.4** | 47.1 | 195 / 366 / 351 |
| single carbon | 36.0 | 51.0 | **42.2** | 34.7 | 179 / 497 / 351 |
| single argon | 37.9 | 51.0 | **43.5** | 36.7 | 179 / 472 / 351 |
| swarm, vote only (8 readers) | 42.8 | 51.3 | **46.6** | 39.9 | 180 / 421 / 351 |
| swarm (8 readers + 2 red team) | 46.4 | 51.0 | **48.6** | 41.5 | 179 / 386 / 351 |

Swarm vs the best single call (single neon): -5.8 F1 points, 95% interval -13.8 to 2.4 (paired bootstrap over forms; -1.3 standard errors). Better on 3 forms, worse on 5, of 20.

| Degradation | Forms | Best single F1 | Swarm F1 |
|---|---|---|---|
| rot90 | 4 | 41.1 | 48.9 |
| rot180 | 4 | 51.5 | 50.2 |
| skew | 4 | 64.9 | 64.9 |
| lowres | 4 | 59.2 | 42.4 |
| dim | 4 | 57.8 | 48.3 |


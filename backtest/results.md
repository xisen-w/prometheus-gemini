# Nasdaq Composite, next-day close: offline backtest

20 trading days, 2026-10-26 to 2026-11-20. Each forecast saw only data up to the previous close and had no tools, so nothing from the target day could leak in. Data: daily Nasdaq Composite, S&P 500, VIX and 10-year yield (Yahoo Finance).

| Forecaster | Mean abs. error (points) | Mean abs. error (%) | Actual close inside its 80% interval | Mean interval width | Direction right | Brier score of p(up) |
|---|---|---|---|---|---|---|
| Random walk (tomorrow = today) | 428 | 1.74% | 15 of 20 | 4.1% | makes no call | 0.250 |
| One Gemini 4 Neon call | 427 | 1.74% | 16 of 20 | 4.4% | 9 of 20 | 0.252 |
| Desk: 6 analysts + red team + synthesiser | 426 | 1.73% | 17 of 20 | 4.9% | 6 of 13 | 0.252 |

| Day | Previous close | Actual close | Change | Desk forecast (80% interval, p up) | Single call | Desk error |
|---|---|---|---|---|---|---|
| 2026-10-26 | 25955 | 26169 | 0.82% | 25965 (25430–26465, 0.51) | 25975 | -204 |
| 2026-10-27 | 26169 | 26478 | 1.18% | 26170 (25660–26640, 0.50) | 26195 | -308 |
| 2026-10-28 | 26478 | 26550 | 0.27% | 26485 (26015–26925, 0.51) | 26490 | -65 |
| 2026-10-29 | 26550 | 26185 | -1.38% | 26550 (26100–26940, 0.50) | 26565 | 365 |
| 2026-10-30 | 26185 | 25437 | -2.86% | 26210 (25730–26650, 0.53) | 26205 | 773 |
| 2026-11-02 | 25437 | 25164 | -1.07% | 25460 (24860–26020, 0.52) | 25465 | 296 |
| 2026-11-03 | 25164 | 25372 | 0.83% | 25170 (24560–25780, 0.51) | 25190 | -202 |
| 2026-11-04 | 25372 | 25737 | 1.44% | 25365 (24790–25915, 0.49) | 25390 | -372 |
| 2026-11-05 | 25737 | 24315 | -5.52% | 25740 (25250–26210, 0.51) | 25760 | 1425 |
| 2026-11-06 | 24315 | 24579 | 1.09% | 24360 (23350–25330, 0.52) | 24380 | -219 |
| 2026-11-09 | 24579 | 25253 | 2.74% | 24580 (23830–25285, 0.50) | 24605 | -673 |
| 2026-11-10 | 25253 | 25066 | -0.74% | 25230 (24560–25900, 0.49) | 25265 | 164 |
| 2026-11-11 | 25066 | 25466 | 1.60% | 25075 (24440–25680, 0.51) | 25090 | -391 |
| 2026-11-12 | 25466 | 25366 | -0.39% | 25465 (24830–26070, 0.50) | 25485 | 99 |
| 2026-11-13 | 25366 | 25136 | -0.91% | 25370 (24750–25950, 0.51) | 25385 | 234 |
| 2026-11-16 | 25136 | 24510 | -2.49% | 25135 (24485–25715, 0.50) | 25150 | 625 |
| 2026-11-17 | 24510 | 24328 | -0.74% | 24520 (23800–25200, 0.51) | 24540 | 192 |
| 2026-11-18 | 24328 | 24430 | 0.42% | 24330 (23620–25010, 0.50) | 24365 | -100 |
| 2026-11-19 | 24430 | 23879 | -2.25% | 24425 (23720–25110, 0.50) | 24455 | 546 |
| 2026-11-20 | 23879 | 22618 | -5.28% | 23890 (23060–24660, 0.51) | 23925 | 1272 |

## Next session after 2026-11-20

Last close 22617.73. Desk forecast **22660**, 80% interval 21580 to 23680, probability of a higher close 52%. Following a 5.28% Friday plunge that pushed the 5-day loss to 10.02% and the VIX to 35.89, extreme short-term oversold conditions and short-covering potential roughly balance the strong downward momentum and risk of weekend margin liquidation. We set a nearly flat point forecast of 22660 (p_up 0.52), trimming the optimism of the mean-reversion and cross-asset analysts because large drops in this sample have shown mixed next-day follow-through. To stay calibrated to conditional daily Nasdaq volatility exceeding 3% (given VIX at 35.89 and Nasdaq's elevated selloff beta), we adopt the red team's wider, slightly downside-skewed 80% interval of 21580 to 23680.

Single call: 22685 (21780–23560). Random walk interval: 21970–23285.

Model calls: 189, 1.46M tokens, 0 failed.

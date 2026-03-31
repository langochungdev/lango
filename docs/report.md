# Step 1 Report

## 1. Dictionary API
| Word | Lang | Lookup | Latency (ms) | Missing Fields | Fallback |
|---|---|---:|---:|---|---|
| hello | en | 200 | 445.79 | phonetic | no |
| xin chào | vi | 200 | 428.84 | phonetic | no |
| こんにちは | ja | 404 | 50.26 | meanings | yes |
| 안녕하세요 | ko | 200 | 51.57 | none | no |
| привет | ru | 200 | 133.08 | none | no |
| 你好 | zh-CN | 200 | 51.79 | none | no |
| hallo | de | 200 | 55.38 | none | no |
| bonjour | fr | 200 | 57.01 | none | no |
| hei | fi | 200 | 744.66 | none | no |

- Average lookup latency: 224.26 ms

## 2. Translation
- Argos available: True (direct=16, pivot=56)
- NLLB available: True (load=9978.87 ms)
- NLLB RAM before/after load: 1508.86 MB -> 1014.23 MB

### Pivot Pairs (Argos)
- vi -> zh-CN (via en)
- vi -> ja (via en)
- vi -> ko (via en)
- vi -> ru (via en)
- vi -> de (via en)
- vi -> fr (via en)
- vi -> fi (via en)
- zh-CN -> vi (via en)
- zh-CN -> ja (via en)
- zh-CN -> ko (via en)
- zh-CN -> ru (via en)
- zh-CN -> de (via en)
- zh-CN -> fr (via en)
- zh-CN -> fi (via en)
- ja -> vi (via en)
- ja -> zh-CN (via en)
- ja -> ko (via en)
- ja -> ru (via en)
- ja -> de (via en)
- ja -> fr (via en)
- ja -> fi (via en)
- ko -> vi (via en)
- ko -> zh-CN (via en)
- ko -> ja (via en)
- ko -> ru (via en)
- ko -> de (via en)
- ko -> fr (via en)
- ko -> fi (via en)
- ru -> vi (via en)
- ru -> zh-CN (via en)
- ru -> ja (via en)
- ru -> ko (via en)
- ru -> de (via en)
- ru -> fr (via en)
- ru -> fi (via en)
- de -> vi (via en)
- de -> zh-CN (via en)
- de -> ja (via en)
- de -> ko (via en)
- de -> ru (via en)
- ... and 16 more

### Latency Comparison
| Pair | Input | Argos OK | Argos ms | NLLB OK | NLLB ms |
|---|---|---|---:|---|---:|
| vi->en | word | True | 4483.95 | True | 4895.71 |
| vi->en | sentence | True | 98.95 | True | 3423.15 |
| vi->en | paragraph_100w | True | 445.61 | True | 6777.85 |
| vi->ja | word | True | 8196.83 | True | 933.24 |
| vi->ja | sentence | True | 198.69 | True | 1594.36 |
| vi->ja | paragraph_100w | True | 877.71 | True | 26679.59 |
| vi->fi | word | True | 4928.93 | True | 1112.99 |
| vi->fi | sentence | True | 204.87 | True | 1760.81 |
| vi->fi | paragraph_100w | True | 931.04 | True | 11974.13 |
| zh-CN->ko | word | True | 1564.34 | True | 624.28 |
| zh-CN->ko | sentence | True | 244.84 | True | 2521.13 |
| zh-CN->ko | paragraph_100w | True | 872.51 | True | 12631.05 |
| ja->ru | word | True | 1938.26 | True | 911.46 |
| ja->ru | sentence | True | 325.98 | True | 2050.91 |
| ja->ru | paragraph_100w | True | 1438.38 | True | 33760.01 |
| en->vi | word | True | 721.31 | True | 420.09 |
| en->vi | sentence | True | 85.90 | True | 1550.07 |
| en->vi | paragraph_100w | True | 397.13 | True | 10280.15 |

- Auto-detect available: True, accuracy=1.0

## 3. Audio
- html5_audio_ok: 1 case(s)
- speech_synthesis_fallback: 5 case(s)
- Google URL swap success variants: 3/3
- Native audio tools: mpv=False ffplay=False
- Web Speech API: manual runtime check required in Tauri WebView

## 4. Image Search
- DuckDuckGo reachable in 4/4 queries
- Wikipedia search reachable in 4/4 queries
- Google CSE only runs when GOOGLE_CSE_KEY and GOOGLE_CSE_CX are provided
- Cache TTL probe: 480 seconds
- Infinite scroll threshold probe: 260px

## 5. Recommendation
- Use Argos as default for low-latency local translation.
- Enable NLLB as quality mode for difficult language pairs.
- Keep word lookup fallback enabled to guarantee minimal output on API failures.

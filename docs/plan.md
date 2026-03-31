# DictOver Desktop — Kế hoạch triển khai

> Tài liệu này là roadmap 3 bước để port DictOver từ Anki add-on sang desktop app (Tauri 2.0).
> Dựa trên `analysis.md` (spec nghiệp vụ) + nghiên cứu stack ở trên.

---

## Step 1 — Kiểm tra dữ liệu & tính khả thi (Research & Feasibility)

**Mục tiêu:** Trước khi code, xác minh tất cả API/service thực tế trả về gì, Argos dịch chéo ra sao, và toàn bộ fallback chain có hoạt động đúng không.

**Output:** File `report.md` ghi rõ kết quả từng case.

---

### 1.1 Dictionary API — Kiểm tra lookup response

Viết script `scripts/probe/probe_dictionary.py`:

```python
# Test tất cả 9 ngôn ngữ nguồn + fallback chain
CASES = [
    # (word, source_lang, expected_fields)
    ("hello",     "en", ["phonetic", "meanings", "audio_url"]),
    ("xin chào",  "vi", ["phonetic", "meanings"]),
    ("こんにちは",  "ja", ["meanings"]),
    ("안녕하세요",  "ko", ["meanings"]),
    ("привет",    "ru", ["meanings"]),
    ("你好",       "zh-CN", ["meanings"]),
    ("hallo",     "de", ["meanings"]),
    ("bonjour",   "fr", ["meanings"]),
    ("hei",       "fi", ["meanings"]),
]
# Probe DictionaryAPI.dev (en) + Wiktionary REST (non-en)
# Ghi: status, response time, có audio không, fallback triggered không
```

Kiểm tra:
- DictionaryAPI.dev trả về đúng fields không (`phonetic`, `meanings[].definitions[]`, `audio`)
- Wiktionary REST cho non-EN: `vi`, `ja`, `ko`, `ru`, `zh-CN`, `de`, `fr`, `fi`
- Wiktionary action API bổ sung audio cho non-EN có hoạt động không
- Khi lookup lỗi → fallback sang translate 1 từ (`auto_lookup_fallback`) có cho kết quả tối thiểu không

---

### 1.2 Translation — Argos vs NLLB, dịch chéo 9 ngôn ngữ

Viết script `scripts/probe/probe_translation.py`:

**Test matrix dịch chéo (pivot qua EN nếu cần):**

| Source | Target | Argos direct? | Phải pivot? |
|--------|--------|--------------|-------------|
| vi | en | Có | Không |
| vi | ja | Không | Phải vi→en→ja |
| vi | fi | Không | Phải vi→en→fi |
| zh-CN | ko | Không | Phải zh→en→ko |
| ja | ru | Không | Phải ja→en→ru |
| ... | ... | ... | ... |

```python
# Với Argos Translate:
# 1. List tất cả package đã cài
# 2. Test từng cặp ngôn ngữ cần — direct hay pivot
# 3. Đo thời gian dịch: 1 từ / 1 câu / 1 đoạn (~100 từ)
# 4. So sánh chất lượng với NLLB-200 distilled trên cùng input

# Với NLLB-200 distilled 600M (qua ctranslate2):
# 1. Load model, đo RAM usage
# 2. Đo latency: first inference / subsequent
# 3. Test 9 ngôn ngữ

TEST_SENTENCES = {
    "vi": "Hôm nay thời tiết rất đẹp, tôi muốn đi dạo.",
    "en": "The quick brown fox jumps over the lazy dog.",
    "zh": "今天天气很好，我想出去走走。",
    "ja": "今日はとても良い天気で、散歩に行きたいです。",
    "ko": "오늘 날씨가 매우 좋아서 산책을 하고 싶습니다.",
    "ru": "Сегодня очень хорошая погода, я хочу прогуляться.",
    "de": "Heute ist das Wetter sehr schön, ich möchte spazieren gehen.",
    "fr": "Aujourd'hui le temps est très beau, je veux me promener.",
    "fi": "Tänään on hyvin kaunis sää, haluaisin lähteä kävelylle.",
}
```

Kiểm tra case đặc biệt:
- Dịch 1 từ (lookup fallback) — chất lượng vs dịch cả câu
- Dịch đoạn >200 ký tự — có bị truncate không
- Ngôn ngữ `auto` detect — accuracy trên từng ngôn ngữ

---

### 1.3 Audio — Kiểm tra fallback chain

Viết script `scripts/probe/probe_audio.py`:

```
Chain theo analysis.md §6.3:
1. HTML5 Audio play audio_url từ dictionary
2. Nếu fail: swap domain googleapis ↔ google.com, gtx ↔ tw-ob → retry
3. Nếu fail: native audio (desktop: mpv/ffplay thay aqt.sound)
4. Nếu fail: speechSynthesis (Web Speech API trong WebView)
5. Nếu không có audio_url: thẳng speechSynthesis
```

Kiểm tra:
- URL audio từ DictionaryAPI.dev còn valid không (thực tế nhiều URL chết)
- Google TTS URL (cả 2 domain) có hoạt động không từ máy local
- Swap domain logic có đúng regex không
- speechSynthesis trong Tauri WebView2/WebKitGTK có support 9 ngôn ngữ không

---

### 1.4 Image Search — Kiểm tra source fallback

Viết script `scripts/probe/probe_image.py`:

```
Chain theo analysis.md §6.5:
1. DuckDuckGo instant answer images
2. Google CSE (nếu có key/cx)
3. Wikipedia search
4. Wikipedia exact-title bổ sung
```

Kiểm tra:
- DuckDuckGo scraping còn hoạt động không (hay bị block)
- Wikipedia API response format
- Ranking algorithm title/query relevance
- Cache 8 phút + infinite scroll threshold 260px — logic đúng không

---

### 1.5 Chạy toàn bộ probe

```bash
# Tạo virtualenv
python -m venv .probe-env && source .probe-env/bin/activate
pip install requests argostranslate ctranslate2 transformers sentencepiece

# Chạy từng probe
python scripts/probe/probe_dictionary.py  > results/dict_report.json
python scripts/probe/probe_translation.py > results/translation_report.json
python scripts/probe/probe_audio.py       > results/audio_report.json
python scripts/probe/probe_image.py       > results/image_report.json

# Tổng hợp thành report.md
python scripts/probe/generate_report.py
```

**Output: `report.md`** gồm:
- Bảng kết quả từng API (status, latency, missing fields)
- So sánh Argos vs NLLB chất lượng + tốc độ
- Danh sách cặp ngôn ngữ cần pivot
- Các fallback nào hoạt động / không hoạt động
- Recommendation: dùng Argos hay NLLB, và settings tối ưu

---

## Step 2 — Code 2 core feature + UI settings + CI/CD pipeline

**Mục tiêu:** Implement đủ để chạy được, build ra installer, tự động hóa release.

---

### 2.1 Kiến trúc project

```
dictover-desktop/
├── src-tauri/           # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── hotkey.rs        # Global hotkey + text inject
│   │   ├── selection.rs     # Accessibility hook (text selection detect)
│   │   ├── bridge.rs        # IPC commands
│   │   └── config.rs        # config.json load/save
│   └── Cargo.toml
├── src/                 # React + TypeScript frontend
│   ├── components/
│   │   ├── Popover/         # Feature 1: popover định nghĩa
│   │   ├── Settings/        # UI settings (clone từ analysis.md §3)
│   │   └── FloatingBtn/     # Floating settings button §4.5
│   ├── hooks/
│   │   ├── usePopover.ts
│   │   └── useTranslate.ts
│   └── services/
│       ├── dictionary.ts    # Gọi IPC → Rust → Python sidecar
│       └── translate.ts
├── sidecar/             # Python translation engine
│   ├── main.py          # FastAPI local server
│   ├── translation.py   # Argos / NLLB wrapper
│   └── requirements.txt
├── scripts/
│   ├── probe/           # Step 1 scripts
│   ├── dev.sh           # Dev server
│   ├── build.sh         # Build installer
│   ├── changelog.sh     # Generate changelog từ commits
│   └── release.sh       # Tag + build + upload release
└── .github/
    └── workflows/
        ├── test.yml
        └── release.yml
```

---

### 2.2 Feature 1 — Popover định nghĩa khi tô chữ

**Rust: `selection.rs`**

```rust
// macOS: AXObserver theo dõi kAXSelectedTextChangedNotification
// Windows: SetWinEventHook(EVENT_OBJECT_TEXTSELECTIONCHANGED)
// Linux: AT-SPI atspi_event_listener_register

pub fn start_selection_listener(tx: Sender<SelectionEvent>) {
    // Mỗi khi text selection thay đổi → gửi event qua channel
    // Frontend nhận qua Tauri event: "selection-changed"
}
```

**Frontend: `usePopover.ts`**

```typescript
// State machine theo analysis.md §4.1
type PopoverState = 'idle' | 'loading' | 'lookup' | 'translate' | 'error'

// Logic:
// 1 từ → lookup API
// nhiều từ → translate API
// trigger_mode=shortcut → chờ keydown combo trước
// trigger_mode=auto → gọi ngay
```

**CSS:** Clone y hệt từ analysis.md §5.2:
- `.apl-popover`: fixed, z-index 9999, max-width min(560px, calc(100vw-20px))
- `.apl-subpanel`: z-index 10001
- `.apl-settings-root`: z-index 10030

---

### 2.3 Feature 2 — Hotkey dịch nhanh text trong field

**Rust: `hotkey.rs`**

```rust
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use enigo::{Enigo, Key, Keyboard, Settings};

// 1. Đăng ký global hotkey (default: Ctrl+Shift+T)
// 2. Khi trigger:
//    a. Lấy text trong focused field (Ctrl+A → Ctrl+C → read clipboard)
//    b. Gọi Python sidecar dịch
//    c. Inject text mới vào field (Ctrl+A → type new text)

pub async fn on_hotkey_triggered(app: AppHandle) {
    let text = get_focused_field_text().await;
    let translated = call_translation_sidecar(&text).await;
    inject_text_to_field(&translated).await;
}
```

**Python sidecar: `sidecar/main.py`**

```python
from fastapi import FastAPI
from translation import translate

app = FastAPI()

@app.post("/translate")
async def translate_endpoint(req: TranslateRequest):
    # Dùng Argos hoặc NLLB tùy config
    # Trả về trong <100ms cho câu ngắn
    result = translate(req.text, req.source, req.target)
    return {"result": result, "engine": "argos|nllb"}
```

---

### 2.4 UI Settings

Clone từ analysis.md §3, implement đủ 13 settings keys:

```typescript
// Render settings panel với tất cả controls:
// - enable_lookup / enable_translate / enable_audio toggles
// - auto_play_audio_mode: off | word | all
// - popover_trigger_mode: auto | shortcut + input combo
// - source_language / target_language dropdowns (9 ngôn ngữ)
// - max_definitions slider
// - show_example toggle
// - popover_open_panel_mode: none | details | images
// - popover_definition_language_mode: output | input | english

// Save → ghi config.json
// Load → đọc config.json khi app start
```

---

### 2.5 Scripts cho agent code — Dev + Build + Deploy

**`scripts/dev.sh`** — Chạy dev mode:

```bash
#!/bin/bash
set -e

echo "[1/3] Start Python sidecar..."
cd sidecar
pip install -r requirements.txt -q
uvicorn main:app --port 49152 --reload &
SIDECAR_PID=$!
cd ..

echo "[2/3] Start Tauri dev..."
npm install
SIDECAR_PORT=49152 npm run tauri dev

# Cleanup khi thoát
trap "kill $SIDECAR_PID" EXIT
```

**`scripts/build.sh`** — Build installer:

```bash
#!/bin/bash
set -e

TARGET=${1:-"current"}  # current | all | windows | macos | linux

echo "[1/4] Build Python sidecar thành binary..."
cd sidecar
pip install pyinstaller -q
pyinstaller main.py --onefile --name dictover-sidecar --distpath ../src-tauri/binaries/
cd ..

echo "[2/4] Chạy unit tests trước khi build..."
cargo test --manifest-path src-tauri/Cargo.toml
pytest sidecar/tests/ -q

echo "[3/4] Build Tauri app..."
npm run tauri build

echo "[4/4] Output installer:"
ls -lh src-tauri/target/release/bundle/
# macOS: .dmg + .app
# Windows: .msi + .exe (NSIS)
# Linux: .deb + .AppImage
```

**`scripts/changelog.sh`** — Tạo changelog từ commits chưa push:

```bash
#!/bin/bash
# Lấy commits chưa push lên remote

BRANCH=$(git rev-parse --abbrev-ref HEAD)
REMOTE="origin/$BRANCH"

# Commits chưa push
UNPUSHED=$(git log $REMOTE..HEAD --oneline 2>/dev/null || git log --oneline -20)

if [ -z "$UNPUSHED" ]; then
  echo "Không có commit mới."
  exit 0
fi

# Parse conventional commits → nhóm theo type
echo "## Changelog\n"
echo "$UNPUSHED" | awk '
/^[a-z0-9]+ feat/ { print "### Features\n- " substr($0, index($0,$2)) }
/^[a-z0-9]+ fix/  { print "### Bug Fixes\n- " substr($0, index($0,$2)) }
/^[a-z0-9]+ docs/ { print "### Docs\n- " substr($0, index($0,$2)) }
/^[a-z0-9]+ chore/{ print "### Chores\n- " substr($0, index($0,$2)) }
'
```

**`scripts/release.sh`** — Tag + build + upload release:

```bash
#!/bin/bash
set -e

VERSION=$1
if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh v1.0.0"
  exit 1
fi

echo "[1/4] Tạo changelog..."
CHANGELOG=$(bash scripts/changelog.sh)

echo "[2/4] Cập nhật version trong tauri.conf.json + Cargo.toml..."
sed -i "s/\"version\": \".*\"/\"version\": \"${VERSION#v}\"/" src-tauri/tauri.conf.json

echo "[3/4] Build installer..."
bash scripts/build.sh

echo "[4/4] Tạo Git tag + GitHub Release..."
git add -A
git commit -m "chore: release $VERSION"
git tag -a "$VERSION" -m "$CHANGELOG"
git push origin main --tags

# Upload qua GitHub CLI
gh release create "$VERSION" \
  --title "DictOver $VERSION" \
  --notes "$CHANGELOG" \
  src-tauri/target/release/bundle/macos/*.dmg \
  src-tauri/target/release/bundle/msi/*.msi \
  src-tauri/target/release/bundle/deb/*.deb \
  src-tauri/target/release/bundle/appimage/*.AppImage
```

---

### 2.6 Git hooks — Pre-push kiểm tra + tự thêm changelog

**`.git/hooks/pre-push`** (hoặc dùng `husky`):

```bash
#!/bin/bash
set -e

echo "=== Pre-push checks ==="

# 1. Chạy tests nhanh
echo "[1/3] Running unit tests..."
cargo test --manifest-path src-tauri/Cargo.toml --quiet
pytest sidecar/tests/ -q --tb=short

# 2. Lint
echo "[2/3] Lint check..."
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run lint --silent

# 3. Tạo changelog và thêm vào CHANGELOG.md
echo "[3/3] Generating changelog..."
CHANGELOG=$(bash scripts/changelog.sh)
if [ -n "$CHANGELOG" ]; then
  DATE=$(date +%Y-%m-%d)
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  # Prepend vào CHANGELOG.md
  echo "## [$DATE] $BRANCH\n$CHANGELOG\n" | cat - CHANGELOG.md > /tmp/cl_tmp
  mv /tmp/cl_tmp CHANGELOG.md
  git add CHANGELOG.md
  git commit --amend --no-edit
  echo "CHANGELOG.md đã được cập nhật."
fi

echo "=== Pre-push OK ==="
```

Cài hook:

```bash
# Dùng husky để không phải copy thủ công
npm install --save-dev husky
npx husky install
npx husky add .husky/pre-push "bash .git/hooks/pre-push"
```

---

### 2.7 GitHub Actions CI/CD

**`.github/workflows/test.yml`** — Chạy mỗi commit:

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - name: Rust unit tests
        run: cargo test --manifest-path src-tauri/Cargo.toml
      - name: Python unit tests
        run: |
          pip install pytest -q
          pytest sidecar/tests/ -q
```

**`.github/workflows/release.yml`** — Tự động build + release khi push tag:

```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  build-and-release:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - name: Build sidecar
        run: |
          pip install pyinstaller
          cd sidecar && pyinstaller main.py --onefile --name dictover-sidecar
      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "DictOver ${{ github.ref_name }}"
          releaseBody: |
            ${{ steps.changelog.outputs.content }}
          releaseDraft: false
```

---

## Step 3 — Test tự động core features

**Mục tiêu:** Coverage đủ để tự tin release, chạy được trong CI không cần GUI thật.

---

### 3.1 Unit tests — Rust

**File: `src-tauri/src/tests/`**

```rust
// Test text inject sanitize
#[test]
fn test_sanitize_text_for_inject() {
    assert_eq!(sanitize_inject("hello\r\n"), "hello");
    assert_eq!(sanitize_inject("  spaces  "), "spaces");
}

// Test config load/save
#[test]
fn test_config_roundtrip() {
    let cfg = Config { target_language: "vi".into(), ..Default::default() };
    let json = serde_json::to_string(&cfg).unwrap();
    let loaded: Config = serde_json::from_str(&json).unwrap();
    assert_eq!(loaded.target_language, "vi");
}

// Test hotkey string parse
#[test]
fn test_hotkey_parse() {
    assert!(parse_hotkey("Ctrl+Shift+T").is_ok());
    assert!(parse_hotkey("invalid").is_err());
}
```

Chạy: `cargo test`

---

### 3.2 Unit tests — Python sidecar

**File: `sidecar/tests/test_translation.py`**

```python
import pytest
from translation import translate, detect_language

def test_translate_vi_to_en():
    result = translate("xin chào", src="vi", tgt="en")
    assert "hello" in result.lower()

def test_translate_en_to_vi():
    result = translate("hello", src="en", tgt="vi")
    assert "xin chào" in result.lower() or "chào" in result.lower()

def test_translate_pivot_vi_to_ja():
    # vi không có model trực tiếp sang ja → phải pivot qua en
    result = translate("xin chào", src="vi", tgt="ja")
    assert len(result) > 0  # ít nhất không crash

def test_detect_language():
    assert detect_language("xin chào") == "vi"
    assert detect_language("hello world") == "en"
    assert detect_language("こんにちは") == "ja"

def test_translate_empty_string():
    assert translate("", src="vi", tgt="en") == ""

def test_translate_long_text():
    text = "Đây là một đoạn văn dài. " * 20  # ~500 ký tự
    result = translate(text, src="vi", tgt="en")
    assert len(result) > 0
```

**File: `sidecar/tests/test_api.py`**

```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_translate_endpoint():
    resp = client.post("/translate", json={"text": "xin chào", "source": "vi", "target": "en"})
    assert resp.status_code == 200
    assert "result" in resp.json()

def test_translate_invalid_lang():
    resp = client.post("/translate", json={"text": "test", "source": "xx", "target": "en"})
    assert resp.status_code == 422  # validation error
```

Chạy: `pytest sidecar/tests/ -v`

---

### 3.3 Integration tests — Tauri IPC

**File: `tests/integration/test_ipc.ts`** (Vitest + @tauri-apps/api mock):

```typescript
import { invoke } from '@tauri-apps/api/core'
import { vi, describe, it, expect } from 'vitest'

// Mock Tauri IPC trong test environment
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('Translation IPC', () => {
  it('gọi translate command với đúng params', async () => {
    const mockInvoke = vi.mocked(invoke)
    mockInvoke.mockResolvedValue({ result: 'Hello', engine: 'argos' })

    const result = await invoke('translate', {
      text: 'xin chào', source: 'vi', target: 'en'
    })

    expect(mockInvoke).toHaveBeenCalledWith('translate', expect.objectContaining({
      text: 'xin chào'
    }))
    expect(result).toEqual({ result: 'Hello', engine: 'argos' })
  })
})

describe('Popover state machine', () => {
  it('1 từ → trigger lookup, nhiều từ → trigger translate', () => {
    expect(getActionType('hello')).toBe('lookup')
    expect(getActionType('hello world how are you')).toBe('translate')
  })
})
```

Chạy: `npm run test`

---

### 3.4 E2E tests — WebdriverIO + Tauri Driver

**File: `tests/e2e/translate.spec.ts`**

```typescript
// Chạy app thật, điều khiển qua WebDriver
describe('Feature: Hotkey translate', () => {
  it('thay thế text trong field khi bấm hotkey', async () => {
    // Mở app
    const input = await $('input[data-testid="translate-field"]')
    await input.setValue('xin chào')

    // Trigger hotkey
    await browser.keys(['Control', 'Shift', 'T'])
    await browser.pause(300)  // đợi dịch xong

    const val = await input.getValue()
    expect(val).toBe('Hello')
  })
})

describe('Feature: Popover on selection', () => {
  it('hiện popover khi tô 1 từ', async () => {
    const textEl = await $('[data-testid="selectable-text"]')

    // Double click để select 1 từ
    await textEl.doubleClick()
    await browser.pause(500)

    const popover = await $('[data-testid="popover"]')
    await popover.waitForDisplayed({ timeout: 2000 })
    expect(await popover.isDisplayed()).toBe(true)
  })
})
```

**`wdio.conf.ts`** — Config WebdriverIO với Tauri:

```typescript
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.spec.ts'],
  capabilities: [{
    'tauri:options': { application: './src-tauri/target/release/dictover' }
  }],
  services: ['@tauri-apps/wdio-tauri-service'],
}
```

---

### 3.5 Hướng dẫn chạy tests

#### Lần đầu — Cài dependencies

```bash
# 1. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Node dependencies
npm install

# 3. Python sidecar deps
python -m venv .venv && source .venv/bin/activate
pip install -r sidecar/requirements.txt

# 4. Tauri CLI
npm install -g @tauri-apps/cli
```

#### Chạy từng layer

```bash
# Unit tests Rust
cargo test --manifest-path src-tauri/Cargo.toml

# Unit tests Python
source .venv/bin/activate
pytest sidecar/tests/ -v

# Frontend unit + integration (Vitest)
npm run test

# E2E (cần build app trước)
bash scripts/build.sh
npx wdio run wdio.conf.ts
```

#### Chạy tất cả một lần

```bash
bash scripts/test-all.sh
# Output: summary pass/fail từng layer
# Exit code 0 = tất cả pass
```

---

## Tóm tắt thứ tự thực hiện

```
Step 1: probe scripts → report.md
   ↓ (confirm stack: Argos hay NLLB, API nào dùng được)
Step 2a: setup project structure + scripts
Step 2b: implement Feature 1 (popover) + Feature 2 (hotkey translate)
Step 2c: implement Settings UI
Step 2d: setup CI/CD + git hooks
   ↓ (app chạy được, build ra installer)
Step 3: viết tests → chạy test-all.sh → green
```

---

*Tài liệu này dành cho agent code và developer tham chiếu trong suốt quá trình phát triển.*

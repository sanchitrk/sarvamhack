---
name: translate
description: Translate text between English and Indian languages using Sarvam AI (Sarvam-Translate, Mayura). Handles content translation and app localization across 22+ languages with mode control, script options, and numeral formats. Use when translating or localizing content for Indian users.
license: Apache-2.0
metadata:
  author: sarvam-ai
  version: "3.1"
---

# Translation — Sarvam AI

> [!IMPORTANT]
> Auth: `api-subscription-key` header — NOT `Authorization: Bearer`. Base URL: `https://api.sarvam.ai/v1`

## Models

| Model | Max Input | Languages | Features |
|-------|-----------|-----------|----------|
| `sarvam-translate:v1` | 2,000 chars | 23 (22 Indian + English) | `mode` (`formal` only), `speaker_gender`, `numerals_format` |
| `mayura:v1` | 1,000 chars | 11 (10 Indian + English) | All `mode` values, `output_script`, `speaker_gender`, `numerals_format`, auto source detection |

## Quick Start (Python)

```python
from sarvamai import SarvamAI
client = SarvamAI()

response = client.text.translate(
    input="Hello, how are you?",
    source_language_code="en-IN",
    target_language_code="hi-IN",
    model="sarvam-translate:v1"
)
print(response.translated_text)
```

## Quick Start (JavaScript/TypeScript)

```typescript
import { SarvamAIClient } from "sarvamai";

const client = new SarvamAIClient({ apiSubscriptionKey: "YOUR_SARVAM_API_KEY" });

const response = await client.text.translate({
    input: "Hello, how are you?",
    source_language_code: "en-IN",
    target_language_code: "hi-IN",
    model: "sarvam-translate:v1"
});
console.log(response.translated_text);
```

## Gotchas

| Gotcha | Detail |
|--------|--------|
| **Method name** | Both Python & JS: `client.text.translate({...})` — NOT `client.translate.translate()`. Same `text` namespace in both SDKs. |
| **`output_script` on sarvam-translate** | NOT supported — only works with `mayura:v1` (`roman`, `fully-native`, `spoken-form-in-native`). Silently ignored on `sarvam-translate:v1`. |
| **`mode` values** | `sarvam-translate:v1` supports `formal` only. Colloquial modes (`modern-colloquial`, `classic-colloquial`, `code-mixed`) are `mayura:v1` only. `speaker_gender` works on BOTH models. |
| **Auto language detection** | `source_language_code="auto"` only works with `mayura:v1`. `sarvam-translate:v1` requires an explicit source language. |
| **Odia language code** | `od-IN` — NOT `or-IN`. |
| **Character limits** | Exceeding returns 422. Split long text at sentence boundaries. |

## Full Docs

Fetch language codes, mode examples, script options, and numeral formats from:

- **https://docs.sarvam.ai/llms.txt** — comprehensive docs index
- [Translation Guide](https://docs.sarvam.ai/api/api-guides-tutorials/text-processing/translation)
- [Rate Limits](https://docs.sarvam.ai/api/ratelimits)

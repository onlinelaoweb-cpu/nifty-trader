'use strict';
// ── News Sentiment — cost guard + response reader (13 Oct 2026) ──────────────
// Why this file exists: the News Sentiment job called the Claude API every 20 minutes around the clock
// (~72 calls/day) even when the headlines had not changed, and some replies came back empty ("Raw text: (empty)")
// but were still billed. Pure helpers only — no network, no clock reads unless passed in — so they are unit-tested.
const crypto = require('crypto');

// Same headlines in a different order (or with stray spaces / capitals) must count as "the same news".
function headlinesKey(headlines) {
    const norm = (Array.isArray(headlines) ? headlines : [])
        .map(h => String(h == null ? '' : h).toLowerCase().replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .sort();
    if (!norm.length) return '';
    return crypto.createHash('sha1').update(norm.join('\n')).digest('hex');
}

// What to do this cycle:
//   'closed' — market is not in its news window → do not even call NewsAPI / Claude (keep the last reading)
//   'same'   — headlines are identical to the last scored set (whether it scored fine or failed) → reuse, no call
//   'call'   — new headlines → score them
function decide({ marketDay, key, lastKey }) {
    if (!marketDay) return 'closed';
    if (key && lastKey && key === lastKey) return 'same';
    return 'call';
}

// Claude can return several content blocks (e.g. a "thinking" block first, then "text"). Reading content[0].text
// blindly gives '' when the first block is not text. Take the first real text block.
function pickText(data) {
    const blocks = data && Array.isArray(data.content) ? data.content : [];
    for (const b of blocks) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text;
    }
    return '';
}

// One short line for the log when the reply has no usable text, so the real cause is visible next time.
function describeReply(data) {
    if (!data || typeof data !== 'object') return 'no response body';
    const blocks = Array.isArray(data.content) ? data.content.map(b => (b && b.type) || '?').join(',') : 'none';
    const u = data.usage || {};
    return `stop_reason=${data.stop_reason || '?'} blocks=[${blocks}] tokens in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'}`;
}

module.exports = { headlinesKey, decide, pickText, describeReply };
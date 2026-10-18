'use strict';
const assert = require('assert');
const J = require('../src/utils/autoJournal');
const tr = (o) => ({ state: 'CLOSED', fire_ts: '2026-10-16T04:00:00Z', side: 'CE', strike: 25000, entry_premium: 100, lots: 2, lot_size: 65, realized_pct: 10, realized_rs: 1300, exit_reason: 'full_target', ...o });
const rows = [tr({ realized_pct: 40, realized_rs: 5200 }), tr({ fire_ts: '2026-10-15T04:00:00Z', realized_pct: -20, realized_rs: null, lot_size: null }), tr({ state: 'OPEN', realized_pct: null, realized_rs: null, exit_reason: null })];
const mk = (instrument, source) => rows.map(r => ({ ...r, instrument, source }));
const rep = { days: 30, strategies: J.summarize([...mk('NIFTY', 'Brahmastra'), ...mk('CRUDE', 'Murarka')]) };
const t = J.reportText(rep, { instrument: 'nifty', source: 'brahmastra' });
assert(/NIFTY Brahmastra: 3 trades/.test(t) && !/CRUDE/.test(t));
assert(/Rs is known for 1 of 2 closed trades/.test(t));          // the explanation line for a +avg / -Rs mismatch
assert(/\(OPEN\)/.test(t) && /full_target/.test(t));
assert(t.indexOf('10-15') < t.indexOf('10-16'));                 // oldest first, IST date
assert(/No matching/.test(J.reportText(rep, { instrument: 'GOLD' })));
assert(J.reportText(rep).includes('CRUDE') && J.reportText(rep).includes('NIFTY'));   // no filter = everything
assert(/No matching/.test(J.reportText(null)));
console.log('autoJournalText tests OK');
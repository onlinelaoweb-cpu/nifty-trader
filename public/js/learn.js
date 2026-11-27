/* 📚 "Seekho" — option trading A to Z, inside the Paper Trade tab (27 Nov 2026).
 * Lessons (Basic -> Intermediate -> Advanced) in Hinglish, each with a short quiz; three hands-on tools (premium simulator with Greeks, payoff-diagram builder,
 * position-size calculator); a glossary; and "missions" that tick themselves from the person's own paper trades.
 * Education only — no order, no broker, no signal, no server call, and nothing here touches the live data. Progress lives in THIS browser (localStorage).
 * Pure helpers (bs, payoff, summarize, sizeLots, missions) load in Node for tests; the DOM part never throws into the page. */
(function (root) {
  'use strict';
  var KEY = 'vn_learn_v1', PAPER_KEY = 'vn_paper_v1', LOT = 65, RATE = 0.065;

  // ---------- pure maths ----------
  function ncdf(x) {   // Abramowitz-Stegun 7.1.26 (error < 1e-7)
    var t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2);
    var p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  }
  function npdf(x) { return 0.3989422804014327 * Math.exp(-x * x / 2); }
  // Black-Scholes (no dividend; a teaching approximation for index options). S spot, K strike, T years, r rate, sig volatility (0.15 = 15%).
  // theta = change per calendar DAY, vega = change per 1 volatility point.
  function bs(S, K, T, r, sig, type) {
    var call = type !== 'PE';
    if (!(S > 0) || !(K > 0)) return { price: 0, delta: 0, theta: 0, vega: 0 };
    if (!(T > 0) || !(sig > 0)) { var iv = call ? Math.max(0, S - K) : Math.max(0, K - S); return { price: iv, delta: iv > 0 ? (call ? 1 : -1) : 0, theta: 0, vega: 0 }; }
    var sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / (sig * sq), d2 = d1 - sig * sq, disc = Math.exp(-r * T);
    var price = call ? S * ncdf(d1) - K * disc * ncdf(d2) : K * disc * ncdf(-d2) - S * ncdf(-d1);
    var delta = call ? ncdf(d1) : ncdf(d1) - 1;
    var th = -(S * npdf(d1) * sig) / (2 * sq) + (call ? -r * K * disc * ncdf(d2) : r * K * disc * ncdf(-d2));
    return { price: price, delta: delta, theta: th / 365, vega: S * npdf(d1) * sq / 100 };
  }
  // legs: [{ type:'CE'|'PE', side:'BUY'|'SELL', strike, premium }] — profit/loss per unit (1 qty) at expiry spot S
  function payoff(legs, S) {
    var t = 0; legs.forEach(function (l) {
      var v = l.type === 'CE' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
      t += (l.side === 'BUY' ? 1 : -1) * (v - l.premium);
    }); return t;
  }
  function summarize(legs, center) {
    var lo = Math.max(1, center - 1500), hi = center + 1500, step = 10, xs = [], ys = [];
    for (var x = lo; x <= hi; x += step) { xs.push(x); ys.push(payoff(legs, x)); }
    var maxP = Math.max.apply(null, ys), maxL = Math.min.apply(null, ys), n = ys.length, up = ys[n - 1] - ys[n - 2], dn = ys[1] - ys[0], be = [];
    for (var i = 1; i < n; i++) if ((ys[i - 1] < 0 && ys[i] >= 0) || (ys[i - 1] > 0 && ys[i] <= 0)) be.push(Math.round(xs[i - 1] + (0 - ys[i - 1]) * (xs[i] - xs[i - 1]) / (ys[i] - ys[i - 1])));
    return { xs: xs, ys: ys, maxProfit: maxP, maxLoss: maxL, profitOpenUp: up > 1e-9, profitOpenDown: dn < -1e-9, lossOpenUp: up < -1e-9, lossOpenDown: dn > 1e-9, breakevens: be };
  }
  // lots you may trade so that hitting the stop loses at most riskPct of capital
  function sizeLots(capital, riskPct, premium, slPct, lot) {
    lot = lot || LOT; var risk = capital * riskPct / 100, perLot = premium * slPct / 100 * lot;
    return perLot > 0 ? { riskRs: risk, perLot: perLot, lots: Math.floor(risk / perLot) } : { riskRs: risk, perLot: 0, lots: 0 };
  }
  var PRESETS = {
    'Long Call (CALL kharido)': [['CE', 'BUY', 0]],
    'Long Put (PUT kharido)': [['PE', 'BUY', 0]],
    'Short Call (CALL becho)': [['CE', 'SELL', 0]],
    'Short Put (PUT becho)': [['PE', 'SELL', 0]],
    'Bull Call Spread': [['CE', 'BUY', 0], ['CE', 'SELL', 200]],
    'Bear Put Spread': [['PE', 'BUY', 0], ['PE', 'SELL', -200]],
    'Long Straddle': [['CE', 'BUY', 0], ['PE', 'BUY', 0]],
    'Long Strangle': [['CE', 'BUY', 200], ['PE', 'BUY', -200]],
    'Short Straddle': [['CE', 'SELL', 0], ['PE', 'SELL', 0]],
    'Iron Condor': [['CE', 'SELL', 200], ['CE', 'BUY', 400], ['PE', 'SELL', -200], ['PE', 'BUY', -400]]
  };
  function buildLegs(presetName, spot, days, ivPct) {
    var atm = Math.round(spot / 50) * 50, T = Math.max(days, 0.05) / 365;
    return (PRESETS[presetName] || PRESETS['Long Call (CALL kharido)']).map(function (d) {
      var k = atm + d[2], pr = Math.max(0.05, Math.round(bs(spot, k, T, RATE, ivPct / 100, d[0]).price * 20) / 20);
      return { type: d[0], side: d[1], strike: k, premium: pr };
    });
  }
  // missions tick from the person's own paper-trade record (see paper-trade.js)
  function missions(st) {
    var all = ((st && st.open) || []).concat((st && st.closed) || []).filter(function (t) { return t.opt; }), closed = ((st && st.closed) || []);
    function any(f) { return all.some(f); }
    return [
      { id: 'm1', text: 'Chain se ek option BUY karo (market order)', done: any(function (t) { return t.side === 'BUY'; }) },
      { id: 'm2', text: 'SL lagakar ek trade lo', done: any(function (t) { return t.sl !== null && t.sl !== undefined; }) },
      { id: 'm3', text: 'Ek trade SL ya Target se band hote dekho', done: closed.some(function (t) { return t.reason === 'SL laga' || t.reason === 'Target mila'; }) },
      { id: 'm4', text: 'Ek LIMIT order lagao', done: any(function (t) { return t.otype === 'LIMIT'; }) },
      { id: 'm5', text: 'Ek TRIGGER order lagao', done: any(function (t) { return t.otype === 'TRIGGER'; }) },
      { id: 'm6', text: 'Ek PUT (PE) trade lo', done: any(function (t) { return t.opt === 'PE'; }) },
      { id: 'm7', text: 'SELL (option writing) ek baar try karo — chhote size mein', done: any(function (t) { return t.side === 'SELL'; }) },
      { id: 'm8', text: 'Ek Carry Forward trade lo', done: any(function (t) { return t.product === 'CARRY'; }) },
      { id: 'm9', text: '10 trade poore karo', done: closed.length >= 10 },
      { id: 'm10', text: '30 trade poore karo — tab natija thoda bharose layak', done: closed.length >= 30 }
    ];
  }

  // ---------- lessons ----------
  var LESSONS = [
    { id: 'b1', lvl: 'BASIC', title: 'Option kya hota hai?', pts: [
      'Option ek contract hai: aap ek <b>tay price (strike)</b> par Nifty kharidne (<b>CALL – CE</b>) ya bechne (<b>PUT – PE</b>) ka <b>haq</b> kharidte ho, farz nahi. Iske liye jo paisa dete ho wo <b>premium</b> hai.',
      '<b>CALL</b> tab faayda deta hai jab Nifty <b>badhe</b>. <b>PUT</b> tab jab Nifty <b>gire</b>.',
      '<b>1 lot</b> = abhi 65 qty. Premium ₹100 hai to 1 lot ka cost = 100 × 65 = <b>₹6,500</b>.',
      '<b>Expiry</b> = contract ki aakhri taareekh (Nifty ka weekly expiry Tuesday ko). Uske baad option ya to zero ya intrinsic value par settle.',
      'Khareedne wale (buyer) ka maximum nuksaan = <b>sirf premium</b>. Isliye shuruaat hamesha buying se.'],
      ex: 'Nifty 25,000. Aapne 25,000 CE ₹120 mein kharida. Expiry par Nifty 25,200 → value 200 → faayda (200−120) × 65 = <b>₹5,200</b>. Nifty 24,900 → value 0 → nuksaan 120 × 65 = <b>₹7,800</b> (poora premium).',
      quiz: [{ q: 'CALL option kab faayda deta hai?', o: ['Nifty badhe', 'Nifty gire', 'Nifty na hile'], a: 0, why: 'CALL = upar jaane par faayda. Gire to premium ghat-ta hai.' },
             { q: 'Option buyer ka maximum nuksaan?', o: ['Unlimited', 'Sirf diya hua premium', 'Strike price'], a: 1, why: 'Buyer ne jo premium diya, bas utna hi doob sakta hai.' }] },
    { id: 'b2', lvl: 'BASIC', title: 'Strike aur ITM / ATM / OTM', pts: [
      'Nifty ke strikes 50 points ke gap par hote hain (25,550, 25,600 …).',
      '<b>ATM</b> (At The Money): strike ≈ Nifty ka abhi ka bhav.',
      '<b>ITM</b> (In The Money): CALL mein strike <b>neeche</b> hai, PUT mein strike <b>upar</b> hai. Inme <b>intrinsic value</b> hoti hai, isliye mehnge.',
      '<b>OTM</b> (Out of The Money): CALL mein strike upar, PUT mein neeche. Sasta, par jeetne ki probability kam — aksar "lottery".',
      'Beginner ke liye ATM ya halka ITM zyada samajhdaar; door ka OTM sasta lagta hai par ziyadatar zero hota hai.'],
      ex: 'Nifty 25,600. 25,500 CE = ITM (100 pts intrinsic). 25,700 CE = OTM. 25,700 PE = ITM, 25,500 PE = OTM.',
      quiz: [{ q: 'Nifty 25,600 hai. 25,500 PUT kya kehlata hai?', o: ['ITM', 'ATM', 'OTM'], a: 2, why: 'PUT tab ITM hota hai jab strike Nifty se upar ho. 25,500 neeche hai → OTM.' },
             { q: 'Same expiry mein kaun sa zyada mehnga hoga?', o: ['25,500 CE (ITM)', '25,700 CE (OTM)', 'Dono barabar'], a: 0, why: 'ITM mein intrinsic value bhi hoti hai, isliye premium zyada.' }] },
    { id: 'b3', lvl: 'BASIC', title: 'Premium kaise banta hai', pts: [
      '<b>Premium = Intrinsic value + Time value</b>.',
      '<b>Intrinsic</b>: CALL = max(0, Nifty − strike); PUT = max(0, strike − Nifty). Jo abhi "asli" kamai hai.',
      '<b>Time value</b>: expiry jitni door aur market jitna zyada hilne wala (volatility), utni zyada. Expiry par ye <b>0</b> ho jaati hai.',
      'Isiliye Nifty sahi direction mein gaya par <b>time</b> zyada nikal gaya, to premium phir bhi kam ya flat reh sakta hai.'],
      ex: 'Nifty 25,600, 25,500 CE ka premium ₹160 hai → intrinsic 100 + time value 60. ATM option (25,600 CE) ₹90 hai → intrinsic 0, poora ₹90 time value — wo expiry tak ghat-ta jayega.',
      quiz: [{ q: 'ATM option ki intrinsic value kitni hoti hai?', o: ['Premium ke barabar', 'Zero', 'Strike ke barabar'], a: 1, why: 'ATM mein strike ≈ Nifty, to max(0, Nifty − strike) ≈ 0. Poora premium time value hai.' },
             { q: 'Expiry par time value kitni bachti hai?', o: ['Zero', 'Aadhi', 'Wahi jo pehle thi'], a: 0, why: 'Expiry par sirf intrinsic value bachti hai.' }] },
    { id: 'b4', lvl: 'BASIC', title: 'Buyer vs Seller', pts: [
      '<b>Buyer</b>: nuksaan limited (premium), faayda bada ho sakta hai, <b>time uske khilaf</b> (roz premium ghat-ta hai), jeetne ki probability kam.',
      '<b>Seller (writer)</b>: faayda limited (jo premium mila), nuksaan <b>bahut bada</b> (CALL becha to theory mein unlimited), <b>time uske favour</b>, probability zyada — par ek bada jhatka kai hafton ki kamai kha leta hai.',
      'Seller ko <b>margin</b> chahiye hota hai (buyer ko sirf premium).',
      'Seedha sa udaharan: seller roz ₹1 uthata hai, par kabhi kabhi bulldozer se kuchla jata hai.',
      'Paper Trade mein SELL try karo — live mein tab hi jab risk poori tarah samajh aa jaye.'],
      ex: 'Nifty 25,000. 25,000 CE ₹100 becha. Nifty 25,000 par raha → pura ₹100 aapka. Nifty 25,500 ho gaya → value 500, aapka nuksaan 500−100 = <b>400 pts × 65 = ₹26,000</b> (1 lot par).',
      quiz: [{ q: 'Naked CALL seller ka maximum nuksaan?', o: ['Sirf premium', 'Theory mein unlimited', 'Margin ke barabar'], a: 1, why: 'Nifty jitna upar, utna nuksaan — koi upper limit nahi.' },
             { q: 'Roz ke time decay (theta) se kaun kamata hai?', o: ['Buyer', 'Seller', 'Dono'], a: 1, why: 'Premium ghate to seller ko faayda, buyer ko nuksaan.' }] },
    { id: 'b5', lvl: 'BASIC', title: 'Pehla trade: SL, target aur position size', w: 'size', pts: [
      'Trade se pehle 3 sawal: <b>Entry kyun? SL kahan? Target kahan?</b> Jawab nahi pata to trade mat lo.',
      '<b>Ek trade mein risk capital ka 1–2%</b> se zyada nahi. ₹5 lakh capital → max risk ₹5,000–10,000.',
      '<b>Lots = risk ÷ (SL points × qty)</b>. Neeche calculator se nikalo.',
      '<b>Risk:Reward</b> kam se kam 1 : 1.5 rakho (₹1 risk par ₹1.5 ka target).',
      '<b>SL lagao aur hatao mat.</b> SL door karna sabse mehnga galti hai.'],
      ex: 'Capital ₹5,00,000, risk 1% = ₹5,000. Premium ₹100, SL 20% = 20 pts × 65 = ₹1,300 per lot → <b>3 lot</b> (3 × 1,300 = ₹3,900 risk).',
      quiz: [{ q: 'Capital ₹2,00,000 hai, 1% risk matlab ek trade mein max nuksaan?', o: ['₹200', '₹2,000', '₹20,000'], a: 1, why: '2,00,000 × 1% = ₹2,000.' },
             { q: 'Trade ulta chal raha hai. Sahi kya hai?', o: ['SL door kar do', 'SL par band hone do', 'Aur lots badha do (averaging)'], a: 1, why: 'SL isiliye lagaya tha. Door karna ya averaging chhote nuksaan ko bada bana deta hai.' }] },

    { id: 'i1', lvl: 'INTERMEDIATE', title: 'Delta, Theta, Vega (Greeks)', w: 'sim', pts: [
      '<b>Delta</b>: Nifty ₹1 hile to premium kitna hilega. ATM ≈ 0.5; ITM 1 ke paas; OTM 0 ke paas. PUT ka delta negative hota hai.',
      '<b>Theta</b>: roz ka <b>time decay</b>. Expiry ke paas ATM option ka theta sabse tez — buyer ka dushman.',
      '<b>Vega</b>: volatility (IV) 1 point badhe to premium kitna badhe.',
      'Neeche simulator mein spot, din aur IV badal kar dekho premium kaise badalta hai. (Black-Scholes model — asli bhav se thoda alag ho sakta hai.)'],
      ex: 'ATM CALL ka delta 0.5 aur Nifty 40 pts badha → premium lagbhag 20 pts badhega (40 × 0.5), agar baaki sab same rahe.',
      quiz: [{ q: 'ATM CALL ka delta lagbhag kitna hota hai?', o: ['0.1', '0.5', '1.0'], a: 1, why: 'ATM par 50-50 chance, delta ≈ 0.5.' },
             { q: 'Theta (time decay) sabse tez kab hota hai?', o: ['Expiry se door', 'Expiry ke paas', 'Hamesha barabar'], a: 1, why: 'Expiry ke kareeb ATM option ka time value tezi se jhadta hai.' }] },
    { id: 'i2', lvl: 'INTERMEDIATE', title: 'IV aur India VIX', pts: [
      '<b>IV (Implied Volatility)</b> = market ko jitna hilne ki ummeed hai, wo option ke daam mein chhupi hoti hai. <b>India VIX</b> iska index-level naap hai (app ke header mein VIX dikhta hai).',
      'Event (budget, RBI, result) se pehle IV chadhta hai, event ke baad girta hai — isse kehte hain <b>IV crush</b>.',
      'IV crush mein Nifty sahi chale tab bhi premium kam badhta ya gir bhi sakta hai.',
      'VIX bada = option mehnge (buyer ko zyada dena, seller ko zyada milta). VIX chhota = option sasta.'],
      ex: 'Result se pehle 5 din wala ATM CALL ≈ ₹275 (IV 22%). Nifty 50 pts badha (delta se ≈ +₹25), par IV 22% → 14% gir gaya (vega se ≈ −₹95). Premium ≈ ₹205 — direction sahi, phir bhi nuksaan (andaaza, Simulator mein khud check karo).',
      quiz: [{ q: 'IV crush kab hota hai?', o: ['Event ke baad', 'Event se pehle', 'Sirf expiry par'], a: 0, why: 'Event ka nateeja aate hi uncertainty khatam ho jati hai aur IV gir jaata hai.' },
             { q: 'VIX zyada ho to option kaise hote hain?', o: ['Sasta', 'Mehnge', 'Koi farak nahi'], a: 1, why: 'Zyada volatility = zyada time value = mehnga premium.' }] },
    { id: 'i3', lvl: 'INTERMEDIATE', title: 'Expiry day aur "zero to hero" ka sach', pts: [
      'Expiry din <b>theta bahut tez</b> hota hai aur <b>gamma bada</b> — chhoti Nifty move par premium ₹5 se ₹50 ya ₹50 se ₹0 minutes mein.',
      'Isliye log "zero to hero" dhoondte hain, par zyadatar <b>hero to zero</b> hota hai.',
      'Is app ke apne forward test mein bhi chhote scalps costs ke baad paisa nahi bana paaye — jo cheez bahut tez dikhti hai wo aksar costs mein dab jati hai.',
      'Rule: expiry din <b>chhota size</b>, <b>tight SL</b>, ya sirf dekho aur seekho.'],
      ex: 'Expiry par ₹10 ka OTM CALL: 65 qty = ₹650 ka dao. Nifty thoda hile to ₹40 (+₹1,950) ya ₹0 (−₹650). Jeet kam baar, par dikhti hai badi — isi se jaal bichta hai.',
      quiz: [{ q: 'Expiry din premium itni jaldi kyun badalta hai?', o: ['Theta + gamma dono tez', 'Brokerage badh jati hai', 'Lot size badal jata hai'], a: 0, why: 'Time value bahut tezi se jhadta hai aur delta bhi jaldi badalta hai.' },
             { q: 'Expiry din sabse samajhdaar approach?', o: ['Sabse sasta OTM, bada size', 'Chhota size aur tight SL', 'SL hata do'], a: 1, why: 'Risk control hi bachata hai.' }] },
    { id: 'i4', lvl: 'INTERMEDIATE', title: 'OI, PCR aur support / resistance', pts: [
      '<b>OI (Open Interest)</b> = kitne contracts abhi khule hain. Chain mein "OI" aur "OI change" dikhta hai.',
      'Kisi strike par bada <b>CALL OI</b> aksar <b>resistance</b> mana jata hai, bada <b>PUT OI</b> <b>support</b> — kyunki wahan writers (sellers) ne daav lagaya hai.',
      '<b>PCR</b> = Put OI ÷ Call OI. Ye bheed ka mood batata hai; extreme values par bheed ek taraf jhuki hoti hai. Akela signal nahi.',
      'Price badhe + OI badhe = naye long positions; price badhe + OI ghate = short covering. Isko context ke saath padho.',
      'Support/resistance guarantee nahi — wo strike tootne par writers bhi bhaagte hain.'],
      ex: 'Chain mein 25,800 CE par sabse bada OI hai to 25,800 ke aas-paas Nifty ko rukawat milne ki sambhavna zyada — par 25,800 ke upar tik gaya to wahi seller SL mein bhaagenge aur move tez ho sakta hai.',
      quiz: [{ q: 'Kisi strike par bahut zyada CALL OI aksar kya maana jata hai?', o: ['Support', 'Resistance', 'Kuch nahi'], a: 1, why: 'Wahan CALL writers ko Nifty ke rukne ki ummeed hai.' },
             { q: 'PCR kya naapta hai?', o: ['Put OI ÷ Call OI', 'Premium ÷ Strike', 'Profit ÷ Capital'], a: 0, why: 'Put-Call Ratio = Put OI / Call OI.' }] },
    { id: 'i5', lvl: 'INTERMEDIATE', title: 'Charges aur slippage — chhupi lagat', pts: [
      'Har trade par <b>brokerage, STT, exchange charges, GST</b> lagte hain, aur bid-ask ki wajah se <b>slippage</b> bhi.',
      'Paper Trade mein hisaab: 1 lot, ₹100 premium par round-trip charges ≈ <b>₹59</b> + slippage (₹0.5 × 2 × 65) = ₹65 → lagbhag <b>₹124</b> pehle se jeb se.',
      'Matlab premium ko kam se kam ~2 pts upar jana hi padega sirf barabari ke liye.',
      'Chhote targets (5–10 pts) mein ye lagat bahut badi hoti hai. Isiliye bahut zyada trade karna (overtrading) nuksaan karta hai.'],
      ex: '10 pts ka target = 650 gross. Lagat ₹124 → asli hath mein ₹526 (19% kat gaya). 30 pts ke target par wahi lagat sirf ~6%.',
      quiz: [{ q: 'Chhote target + bahut trades ka kya asar?', o: ['Lagat ka bahut bada hissa', 'Koi asar nahi', 'Lagat ghat jati hai'], a: 0, why: 'Fixed lagat chhote profit ko zyada khati hai.' },
             { q: 'Slippage kya hai?', o: ['Expected aur asli fill price ka fark', 'Brokerage ka naam', 'Tax'], a: 0, why: 'Order turant bhar jaye isliye thoda kharab bhav milta hai.' }] },

    { id: 'a1', lvl: 'ADVANCED', title: 'Payoff diagram padhna', w: 'payoff', preset: 'Long Call (CALL kharido)', pts: [
      '<b>Payoff diagram</b> expiry par har Nifty level par faayda/nuksaan ka naksha hai. Har strategy se pehle ise dekho.',
      '<b>Breakeven</b>: CALL buy = strike + premium; PUT buy = strike − premium.',
      'Chart mein <b>hara</b> hissa faayda, <b>laal</b> hissa nuksaan. Seedhi flat line = limited, ubharti hui = unlimited.',
      'Neeche kisi bhi strategy ko chuno — premiums Black-Scholes se nikalte hain, spot / din / IV aap badal sakte ho.'],
      ex: 'Long Call 25,600 @ ₹90: breakeven 25,690. Nifty 25,690 se upar → faayda; neeche → nuksaan, par max ₹90 × 65 = ₹5,850 hi.',
      quiz: [{ q: '25,500 PUT ₹80 mein kharida. Breakeven?', o: ['25,580', '25,420', '25,500'], a: 1, why: 'PUT ka breakeven = strike − premium = 25,500 − 80 = 25,420.' },
             { q: 'Payoff chart mein flat loss line ka matlab?', o: ['Loss limited', 'Loss unlimited', 'Profit guaranteed'], a: 0, why: 'Flat = us level ke baad aur nuksaan nahi.' }] },
    { id: 'a2', lvl: 'ADVANCED', title: 'Spreads: risk ko bandho', w: 'payoff', preset: 'Bull Call Spread', pts: [
      '<b>Bull Call Spread</b>: neeche wala CALL <b>kharido</b> + upar wala CALL <b>becho</b>. Cost kam; max profit aur max loss dono <b>limited</b>.',
      '<b>Bear Put Spread</b>: upar wala PUT kharido + neeche wala PUT becho (girne ka view).',
      'Faayda: becha hua option cost kam karta hai aur theta / IV ka asar ghatata hai. Nuksaan: profit capped.',
      '<b>Max profit</b> = strikes ka gap − net debit. <b>Max loss</b> = net debit.'],
      ex: '25,500 CE ₹160 kharida, 25,700 CE ₹80 becha → net debit ₹80. Gap 200. Max profit (200−80) × 65 = <b>₹7,800</b>, max loss 80 × 65 = <b>₹5,200</b>, breakeven 25,580.',
      quiz: [{ q: 'Bull Call Spread ka maximum nuksaan?', o: ['Net debit', 'Unlimited', 'Strikes ka gap'], a: 0, why: 'Dono legs lagakar jo net paisa diya, bas utna hi doob sakta hai.' },
             { q: 'Spread single CALL se sasta kyun?', o: ['Upar ka CALL bechne se premium milta hai', 'Brokerage kam', 'Expiry door'], a: 0, why: 'Becha hua leg cost ghata deta hai.' }] },
    { id: 'a3', lvl: 'ADVANCED', title: 'Straddle, Strangle aur Iron Condor', w: 'payoff', preset: 'Long Straddle', pts: [
      '<b>Long Straddle</b>: same strike ka CALL + PUT dono kharido. <b>Bada move</b> kisi bhi taraf — faayda. Breakeven = strike ± dono premium ka jod.',
      '<b>Long Strangle</b>: OTM CALL + OTM PUT; sasta, par aur bada move chahiye.',
      '<b>Short Straddle / Strangle</b>: dono becho — Nifty range mein rahe to kamai; bada move aaya to bahut bada nuksaan.',
      '<b>Iron Condor</b>: short strangle + door ke 2 legs ka hedge → risk defined, margin kam.',
      'Event se pehle IV mehnga hota hai, to straddle kharidna mehnga padta hai.'],
      ex: '25,600 straddle: CALL ₹90 + PUT ₹85 = ₹175 cost. Breakeven 25,425 aur 25,775 — Nifty 175 pts se zyada hile tabhi faayda.',
      quiz: [{ q: 'Long straddle kab faayda deta hai?', o: ['Bada move kisi bhi taraf', 'Nifty bilkul na hile', 'Sirf upar jaye'], a: 0, why: 'Dono legs lage hain, ek taraf ka bada move kaafi.' },
             { q: 'Iron condor ka fayda?', o: ['Risk defined', 'Unlimited profit', 'Koi margin nahi'], a: 0, why: 'Door ke 2 legs max loss ko bandh dete hain.' }] },
    { id: 'a4', lvl: 'ADVANCED', title: 'Hedging, margin aur gap risk', pts: [
      'Naked option selling mein <b>margin bada</b> lagta hai (Paper Trade mein approx 11% of Nifty value; asli SPAN margin broker batata hai) aur risk bahut bada.',
      '<b>Hedged position</b> (spread / condor) mein margin kam aur worst-case pehle se pata.',
      'Seller ke liye position size: worst-case nuksaan capital ke ~2% mein rakho.',
      '<b>Gap risk</b>: raat bhar rakhne (Carry Forward) par Nifty gap-up/down khule to SL ka bhav fill nahi hota — nuksaan SL se bhi bada ho sakta hai.',
      'Result / global event wale din Carry mat karo ya size aadha rakho.'],
      ex: 'Short 25,600 straddle ₹175 mila, raat ko global sell-off → Nifty 300 pts neeche khula. Aapka SL 25,500 par tha, par pehla bhav hi 25,300 → nuksaan SL se kahin bada.',
      quiz: [{ q: 'Gap opening mein SL ka kya hota hai?', o: ['Hamesha SL par hi fill', 'SL se door bhav par fill ho sakta hai', 'SL cancel ho jata hai'], a: 1, why: 'Market gap se khule to beech ke levels milte hi nahi.' },
             { q: 'Hedged position ka ek fayda?', o: ['Worst-case pehle se pata', 'Profit guaranteed', 'Charges nahi lagte'], a: 0, why: 'Hedge se max loss defined ho jata hai.' }] },
    { id: 'a5', lvl: 'ADVANCED', title: 'Edge, expectancy aur trading journal', pts: [
      '<b>Expectancy</b> per trade = (jeet% × avg jeet) − (haar% × avg haar) − lagat.',
      '40% jeet-rate bhi chalega agar avg jeet ≥ 2 × avg haar. 70% jeet-rate bhi fail ho sakta hai agar haar bahut badi ho.',
      'Natije par bharosa karne ke liye kam se kam <b>30–50 trades</b> ka record chahiye. Paper Trade ka "Natija" yahi dikhata hai.',
      '<b>Journal</b>: har trade ka reason, SL, result aur galti likho. Revenge trading, overtrading, averaging down se bacho.',
      'SEBI ke studies mein lagbhag 90% individual F&O traders ko nuksaan hua. Isliye pehle paper, phir bahut chhota size.'],
      ex: 'Jeet-rate 40%, avg jeet ₹3,000, avg haar ₹1,000 → 0.4 × 3,000 − 0.6 × 1,000 = <b>+₹600 per trade</b> (lagat se pehle). Jeet-rate 70% par avg jeet ₹500, avg haar ₹1,500 → 350 − 450 = <b>−₹100</b>.',
      quiz: [{ q: 'Jeet 40%, avg jeet ₹3,000, avg haar ₹1,000. Expectancy (lagat se pehle)?', o: ['+₹600', '−₹600', '₹0'], a: 0, why: '0.4×3000 − 0.6×1000 = 1200 − 600 = +600.' },
             { q: 'Natije par bharosa kitne trades ke baad?', o: ['3–5', '10', '30 ya zyada'], a: 2, why: 'Kam trades mein kismat ka role bahut bada hota hai.' }] }
  ];
  var GLOSSARY = [
    ['Premium', 'Option ka daam jo buyer deta hai.'], ['Strike', 'Wo tay price jis par option ka haq hota hai.'], ['Lot', 'Ek contract ki qty (Nifty abhi 65).'],
    ['CE / PE', 'CALL aur PUT option.'], ['ITM / ATM / OTM', 'Strike Nifty ke hisaab se andar / barabar / bahar.'], ['Intrinsic value', 'Option ki abhi ki asli kamai.'],
    ['Time value', 'Premium ka wo hissa jo expiry tak ghat jata hai.'], ['Theta', 'Roz ka time decay.'], ['Delta', 'Nifty 1 hile to premium kitna hile.'], ['Vega', 'IV 1 point badle to premium kitna badle.'],
    ['IV / VIX', 'Expected volatility; VIX index-level naap.'], ['OI', 'Abhi khule contracts ki sankhya.'], ['PCR', 'Put OI ÷ Call OI.'], ['Margin', 'Seller ko broker ke paas rakhna padta paisa.'],
    ['Slippage', 'Expected aur asli fill price ka fark.'], ['SL', 'Stop Loss — nuksaan rokne ka level.'], ['Breakeven', 'Wo Nifty level jahan na faayda na nuksaan.'], ['Expiry', 'Contract ki aakhri taareekh.']
  ];

  // ---------- storage ----------
  var mem = { done: {}, quiz: {} };
  function load() { try { var raw = root.localStorage && root.localStorage.getItem(KEY); if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') return { done: o.done || {}, quiz: o.quiz || {} }; } } catch (e) { /* ignore */ } return mem; }
  function save(p) { mem = p; try { root.localStorage && root.localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }
  function paperState() { try { var raw = root.localStorage && root.localStorage.getItem(PAPER_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

  // ---------- DOM ----------
  var P = null, view = 'home', answers = {}, tool = { preset: null, spot: null, days: 4, iv: 15, simSpot: null, simDays: 4, simIv: 15, simType: 'CE', capital: 500000, riskPct: 1, prem: 100, slPct: 20 };
  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inr(x) { var a = Math.abs(Math.round(x)); return (x < 0 ? '-' : '') + '₹' + a.toLocaleString('en-IN'); }
  function liveSpot() { try { var v = root.PaperTrade && root.PaperTrade.spot && root.PaperTrade.spot(); if (v > 0) return Math.round(v / 50) * 50; } catch (e) { /* ignore */ } return 25000; }
  var CSS = '.lrn-card{background:var(--bg2,#0d1626);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:10px}.lrn-h{font-size:12px;letter-spacing:1px;color:var(--dim);font-weight:700;margin-bottom:8px}' +
    '.lrn-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 4px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer}.lrn-row:last-child{border-bottom:0}' +
    '.lrn-bar{height:6px;background:var(--bg3);border-radius:4px;overflow:hidden}.lrn-bar>i{display:block;height:100%;background:var(--green)}.lrn-pt{margin:0 0 8px;line-height:1.6;font-size:14px}' +
    '.lrn-ex{background:rgba(47,123,255,.12);border-left:3px solid #2f7bff;border-radius:6px;padding:8px 10px;font-size:13px;line-height:1.6;margin:10px 0}.lrn-opt{display:block;width:100%;text-align:left;padding:10px;margin:5px 0;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:14px;cursor:pointer}' +
    '.lrn-opt.ok{border-color:var(--green);background:rgba(52,211,153,.15)}.lrn-opt.bad{border-color:var(--red);background:rgba(248,113,113,.15)}.lrn-in{width:100%;box-sizing:border-box;padding:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:14px}' +
    '.lrn-btn{padding:10px 14px;border:0;border-radius:20px;background:#12a65a;color:#fff;font-weight:700;font-size:14px;cursor:pointer}.lrn-btn.alt{background:var(--bg3);color:var(--text);border:1px solid var(--border)}';
  function styleOnce() { if (typeof document === 'undefined' || $('lrn-style')) return; var e = document.createElement('style'); e.id = 'lrn-style'; e.textContent = CSS; (document.head || document.documentElement).appendChild(e); }
  function doneCount() { return LESSONS.filter(function (l) { return P.done[l.id]; }).length; }

  function homeHtml() {
    var h = [], dc = doneCount(), ms = missions(paperState()), md = ms.filter(function (m) { return m.done; }).length;
    h.push('<div class="lrn-card"><div style="font-size:16px;font-weight:700;margin-bottom:4px;">📚 Option Trading — Basic se Advanced</div><div style="font-size:12px;color:var(--dim);margin-bottom:8px;line-height:1.5;">Chhote lessons, har ek ke baad quiz, aur seedha Paper Trade mein practice. Sirf shiksha hai — trading salah nahi.</div><div class="lrn-bar"><i style="width:' + Math.round(100 * dc / LESSONS.length) + '%"></i></div><div style="font-size:12px;color:var(--dim);margin-top:4px;">' + dc + ' / ' + LESSONS.length + ' lessons poore</div></div>');
    h.push('<div class="lrn-card"><div class="lrn-h">🎯 PRACTICE MISSIONS (' + md + ' / ' + ms.length + ') — Paper Trade karte hi khud tick hote hain</div>' + ms.map(function (m) { return '<div style="font-size:13px;padding:4px 0;color:' + (m.done ? 'var(--green)' : 'var(--text)') + ';">' + (m.done ? '✅ ' : '⬜ ') + esc(m.text) + '</div>'; }).join('') + '</div>');
    ['BASIC', 'INTERMEDIATE', 'ADVANCED'].forEach(function (lv) {
      var ls = LESSONS.filter(function (l) { return l.lvl === lv; }), d = ls.filter(function (l) { return P.done[l.id]; }).length;
      h.push('<div class="lrn-card"><div class="lrn-h">' + ({ BASIC: '🟢 BASIC', INTERMEDIATE: '🟡 INTERMEDIATE', ADVANCED: '🔴 ADVANCED' })[lv] + ' · ' + d + '/' + ls.length + '</div>' +
        ls.map(function (l, i) { return '<div class="lrn-row" data-lrn-open="' + l.id + '"><span>' + (P.done[l.id] ? '✅ ' : '') + (i + 1) + '. ' + esc(l.title) + '</span><span style="color:var(--dim);">' + (P.quiz[l.id] != null ? 'quiz ' + P.quiz[l.id] + '/2 · ' : '') + '›</span></div>'; }).join('') + '</div>');
    });
    h.push('<div class="lrn-card"><details><summary style="cursor:pointer;font-weight:700;">📖 Glossary (A–Z shabd)</summary><div style="margin-top:8px;">' + GLOSSARY.map(function (g) { return '<div style="font-size:13px;padding:4px 0;line-height:1.5;"><b>' + esc(g[0]) + '</b> — ' + esc(g[1]) + '</div>'; }).join('') + '</div></details></div>');
    h.push('<div style="font-size:11px;color:var(--dim);text-align:center;">Sirf shiksha — financial advice nahi. Options mein asli paisa doob sakta hai.</div>');
    return h.join('');
  }
  // --- tools ---
  function sizeToolHtml() {
    var r = sizeLots(tool.capital, tool.riskPct, tool.prem, tool.slPct, LOT);
    return '<div class="lrn-card"><div class="lrn-h">🧮 POSITION SIZE CALCULATOR</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:var(--dim);">' +
      '<label>Capital ₹<input class="lrn-in" id="lrn-cap" type="number" value="' + tool.capital + '"></label><label>Risk % per trade<input class="lrn-in" id="lrn-risk" type="number" step="0.5" value="' + tool.riskPct + '"></label>' +
      '<label>Premium ₹<input class="lrn-in" id="lrn-prem" type="number" value="' + tool.prem + '"></label><label>SL % (premium ka)<input class="lrn-in" id="lrn-slp" type="number" value="' + tool.slPct + '"></label></div><div id="lrn-size-out">' + sizeOut(r) + '</div></div>';
  }
  function sizeOut(r) { return '<div style="margin-top:8px;font-size:13px;line-height:1.7;">Max risk: <b>' + inr(r.riskRs) + '</b> · 1 lot ka SL-risk: <b>' + inr(r.perLot) + '</b><br>Aap le sakte ho: <b style="font-size:18px;color:var(--green);">' + r.lots + ' lot</b>' + (r.lots < 1 ? ' <span style="color:var(--amber);">(1 lot bhi risk se bada — premium/SL ya capital badlo)</span>' : '') + '</div>'; }
  function simOut() {
    var sp = tool.simSpot || liveSpot(), atm = Math.round(sp / 50) * 50, base = liveSpot(), T = Math.max(tool.simDays, 0.05) / 365;
    var now = bs(sp, base, T, RATE, tool.simIv / 100, tool.simType), ref = bs(base, base, Math.max(4, 0.05) / 365, RATE, 0.15, tool.simType);
    return '<div style="font-size:13px;line-height:1.8;margin-top:8px;">Strike <b>' + base + '</b> ' + tool.simType + ' · Nifty <b>' + sp + '</b> · ' + tool.simDays + ' din · IV ' + tool.simIv + '%<br>Premium: <b style="font-size:20px;">₹' + now.price.toFixed(2) + '</b> <span style="color:var(--dim);">(1 lot = ' + inr(now.price * LOT) + ')</span><br>Delta <b>' + now.delta.toFixed(2) + '</b> · Theta <b style="color:var(--red);">' + now.theta.toFixed(2) + '/din</b> (' + inr(now.theta * LOT) + ' per lot) · Vega <b>' + now.vega.toFixed(2) + '</b> per 1% IV</div>' +
      '<div style="font-size:11px;color:var(--dim);margin-top:4px;">Compare: ATM, 4 din, IV 15% par premium ₹' + ref.price.toFixed(2) + '. Slider badal kar dekho kya badalta hai.</div>';
  }
  function simToolHtml() {
    var base = liveSpot(); if (!tool.simSpot) tool.simSpot = base;
    return '<div class="lrn-card"><div class="lrn-h">🎛️ PREMIUM SIMULATOR (Greeks)</div>' +
      '<div class="ptx-seg" style="margin-bottom:8px;"><button data-lrn-st="CE" class="' + (tool.simType === 'CE' ? 'on' : '') + '">CALL</button><button data-lrn-st="PE" class="' + (tool.simType === 'PE' ? 'on' : '') + '">PUT</button></div>' +
      '<label style="font-size:12px;color:var(--dim);">Nifty: <b id="lrn-v1">' + tool.simSpot + '</b><input id="lrn-s1" type="range" min="' + (base - 600) + '" max="' + (base + 600) + '" step="10" value="' + tool.simSpot + '" style="width:100%"></label>' +
      '<label style="font-size:12px;color:var(--dim);">Expiry mein din: <b id="lrn-v2">' + tool.simDays + '</b><input id="lrn-s2" type="range" min="0.25" max="10" step="0.25" value="' + tool.simDays + '" style="width:100%"></label>' +
      '<label style="font-size:12px;color:var(--dim);">IV %: <b id="lrn-v3">' + tool.simIv + '</b><input id="lrn-s3" type="range" min="8" max="40" step="1" value="' + tool.simIv + '" style="width:100%"></label><div id="lrn-sim-out">' + simOut() + '</div></div>';
  }
  function chartSvg(S) {
    var W = 340, H = 170, pad = 8, xs = S.xs, ys = S.ys, lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    var span = hi - lo, px = function (i) { return pad + (W - 2 * pad) * i / (xs.length - 1); }, py = function (v) { return pad + (H - 2 * pad) * (1 - (v - lo) / span); }, y0 = py(0), pts = ys.map(function (v, i) { return px(i).toFixed(1) + ',' + py(v).toFixed(1); }).join(' ');
    var area = 'M' + px(0).toFixed(1) + ',' + y0.toFixed(1) + ' L' + pts.split(' ').join(' L') + ' L' + px(xs.length - 1).toFixed(1) + ',' + y0.toFixed(1) + ' Z';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="background:rgba(0,0,0,.2);border-radius:8px;"><defs><clipPath id="lrn-up"><rect x="0" y="0" width="' + W + '" height="' + Math.max(0, y0).toFixed(1) + '"/></clipPath><clipPath id="lrn-dn"><rect x="0" y="' + Math.max(0, y0).toFixed(1) + '" width="' + W + '" height="' + H + '"/></clipPath></defs>' +
      '<path d="' + area + '" fill="rgba(52,211,153,.35)" clip-path="url(#lrn-up)"/><path d="' + area + '" fill="rgba(248,113,113,.35)" clip-path="url(#lrn-dn)"/><line x1="0" x2="' + W + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '" stroke="#8aa" stroke-dasharray="3 3"/><polyline points="' + pts + '" fill="none" stroke="#fff" stroke-width="2"/></svg>';
  }
  function payoffOut() {
    var spot = tool.spot || liveSpot(), legs = buildLegs(tool.preset, spot, tool.days, tool.iv), S = summarize(legs, spot), q = LOT;
    var mp = S.profitOpenUp ? 'Unlimited' : (S.profitOpenDown ? 'Bahut bada' : inr(S.maxProfit * q)), ml = S.lossOpenUp ? 'Unlimited' : (S.lossOpenDown ? 'Bahut bada' : inr(Math.abs(S.maxLoss * q)));
    var net = legs.reduce(function (a, l) { return a + (l.side === 'BUY' ? -1 : 1) * l.premium; }, 0);
    return '<div style="font-size:12px;line-height:1.7;margin:6px 0;">' + legs.map(function (l) { return '<span style="display:inline-block;margin-right:8px;"><b style="color:' + (l.side === 'BUY' ? 'var(--green)' : 'var(--red)') + ';">' + l.side + '</b> ' + l.strike + ' ' + l.type + ' @ ₹' + l.premium.toFixed(2) + '</span>'; }).join('') + '</div>' + chartSvg(S) +
      '<div style="font-size:13px;line-height:1.8;margin-top:6px;">Net ' + (net < 0 ? 'debit (diya)' : 'credit (mila)') + ': <b>₹' + Math.abs(net).toFixed(2) + '</b> (' + inr(Math.abs(net) * q) + ' per lot)<br>Max profit: <b style="color:var(--green);">' + mp + '</b> · Max loss: <b style="color:var(--red);">' + ml + '</b><br>Breakeven: <b>' + (S.breakevens.length ? S.breakevens.join(' / ') : '--') + '</b></div><div style="font-size:11px;color:var(--dim);">Chart ka x-axis: expiry par Nifty (' + (spot - 1500) + ' – ' + (spot + 1500) + '). Per lot = ' + q + ' qty.</div>';
  }
  function payoffToolHtml() {
    var spot = tool.spot || liveSpot();
    return '<div class="lrn-card"><div class="lrn-h">📈 PAYOFF BUILDER</div><select id="lrn-preset" class="lrn-in" style="margin-bottom:8px;">' + Object.keys(PRESETS).map(function (k) { return '<option' + (k === tool.preset ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:11px;color:var(--dim);"><label>Nifty<input class="lrn-in" id="lrn-ps" type="number" step="50" value="' + spot + '"></label><label>Expiry mein din<input class="lrn-in" id="lrn-pd" type="number" step="0.5" value="' + tool.days + '"></label><label>IV %<input class="lrn-in" id="lrn-pi" type="number" value="' + tool.iv + '"></label></div><div id="lrn-pay-out">' + payoffOut() + '</div></div>';
  }
  function lessonHtml(l) {
    var h = [], ans = answers[l.id] || {}, score = 0, total = l.quiz.length;
    h.push('<div class="lrn-card"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><button class="lrn-btn alt" data-lrn-back="1" style="padding:4px 12px;">‹</button><div><div style="font-size:11px;color:var(--dim);letter-spacing:1px;">' + l.lvl + '</div><div style="font-size:16px;font-weight:700;">' + esc(l.title) + '</div></div></div>');
    l.pts.forEach(function (p) { h.push('<div class="lrn-pt">• ' + p + '</div>'); });
    h.push('<div class="lrn-ex"><b>Example:</b> ' + l.ex + '</div></div>');
    if (l.w === 'size') h.push(sizeToolHtml());
    if (l.w === 'sim') h.push(simToolHtml());
    if (l.w === 'payoff') { if (!tool.preset || tool.presetFor !== l.id) { tool.preset = l.preset; tool.presetFor = l.id; } h.push(payoffToolHtml()); }
    h.push('<div class="lrn-card"><div class="lrn-h">✍️ QUIZ</div>');
    l.quiz.forEach(function (qq, qi) {
      var a = ans[qi]; if (a !== undefined && a === qq.a) score++;
      h.push('<div style="font-weight:600;margin:6px 0;">' + (qi + 1) + '. ' + esc(qq.q) + '</div>' + qq.o.map(function (o, oi) {
        var cls = a === undefined ? '' : (oi === qq.a ? ' ok' : (oi === a ? ' bad' : ''));
        return '<button class="lrn-opt' + cls + '" data-lrn-q="' + qi + ':' + oi + '"' + (a !== undefined ? ' disabled' : '') + '>' + esc(o) + '</button>';
      }).join('') + (a !== undefined ? '<div style="font-size:12px;color:var(--dim);margin:4px 0 8px;line-height:1.5;">' + (a === qq.a ? '✅ Sahi. ' : '❌ Galat. ') + esc(qq.why) + '</div>' : ''));
    });
    var answered = Object.keys(ans).length === total;
    if (answered) h.push('<div style="margin-top:8px;font-weight:700;">Score: ' + score + ' / ' + total + '</div>');
    h.push('<div style="margin-top:10px;display:flex;gap:8px;"><button class="lrn-btn" data-lrn-done="1">' + (P.done[l.id] ? '✅ Poora (dobara mark karo)' : 'Lesson poora mark karo') + '</button>' + (nextOf(l) ? '<button class="lrn-btn alt" data-lrn-open="' + nextOf(l).id + '">Agla ›</button>' : '') + '</div></div>');
    return h.join('');
  }
  function nextOf(l) { var i = LESSONS.indexOf(l); return LESSONS[i + 1] || null; }
  var curLesson = null;
  function draw() {
    var host = $('learn-card'); if (!host) return; styleOnce();
    host.innerHTML = view === 'home' ? homeHtml() : lessonHtml(curLesson);
  }
  function lessonById(id) { return LESSONS.filter(function (l) { return l.id === id; })[0] || null; }
  function onClick(e) {
    try {
      var el = e.target && e.target.closest ? e.target.closest('[data-lrn-open],[data-lrn-back],[data-lrn-q],[data-lrn-done],[data-lrn-st]') : null; if (!el) return;
      if (el.hasAttribute('data-lrn-open')) { curLesson = lessonById(el.getAttribute('data-lrn-open')); if (curLesson) { view = 'lesson'; try { window.scrollTo(0, 0); } catch (x) { /* ignore */ } } }
      else if (el.hasAttribute('data-lrn-back')) view = 'home';
      else if (el.hasAttribute('data-lrn-q') && curLesson) {
        var pr = el.getAttribute('data-lrn-q').split(':'); answers[curLesson.id] = answers[curLesson.id] || {}; answers[curLesson.id][Number(pr[0])] = Number(pr[1]);
        var a = answers[curLesson.id]; if (Object.keys(a).length === curLesson.quiz.length) { var sc = 0; curLesson.quiz.forEach(function (q, i) { if (a[i] === q.a) sc++; }); P.quiz[curLesson.id] = Math.max(P.quiz[curLesson.id] || 0, sc); save(P); }
      } else if (el.hasAttribute('data-lrn-done') && curLesson) { P.done[curLesson.id] = true; save(P); }
      else if (el.hasAttribute('data-lrn-st')) { tool.simType = el.getAttribute('data-lrn-st') === 'PE' ? 'PE' : 'CE'; }
      draw();
    } catch (err) { try { console.warn('[Learn]', err && err.message); } catch (_) {} }
  }
  function numOf(id, d) { var e = $(id), v = e ? Number(e.value) : NaN; return isFinite(v) ? v : d; }
  function onInput(e) {   // update only the result blocks, so typing / sliding keeps focus
    try {
      var id = e.target && e.target.id; if (!id || id.indexOf('lrn-') !== 0) return;
      if (id === 'lrn-cap' || id === 'lrn-risk' || id === 'lrn-prem' || id === 'lrn-slp') {
        tool.capital = numOf('lrn-cap', tool.capital); tool.riskPct = numOf('lrn-risk', tool.riskPct); tool.prem = numOf('lrn-prem', tool.prem); tool.slPct = numOf('lrn-slp', tool.slPct);
        var o = $('lrn-size-out'); if (o) o.innerHTML = sizeOut(sizeLots(tool.capital, tool.riskPct, tool.prem, tool.slPct, LOT));
      } else if (id === 'lrn-s1' || id === 'lrn-s2' || id === 'lrn-s3') {
        tool.simSpot = numOf('lrn-s1', tool.simSpot); tool.simDays = numOf('lrn-s2', tool.simDays); tool.simIv = numOf('lrn-s3', tool.simIv);
        var v1 = $('lrn-v1'), v2 = $('lrn-v2'), v3 = $('lrn-v3'); if (v1) v1.textContent = tool.simSpot; if (v2) v2.textContent = tool.simDays; if (v3) v3.textContent = tool.simIv;
        var so = $('lrn-sim-out'); if (so) so.innerHTML = simOut();
      } else if (id === 'lrn-ps' || id === 'lrn-pd' || id === 'lrn-pi' || id === 'lrn-preset') {
        var pe = $('lrn-preset'); if (pe) tool.preset = pe.value;
        tool.spot = numOf('lrn-ps', tool.spot) || null; tool.days = Math.max(0.05, numOf('lrn-pd', tool.days)); tool.iv = Math.min(80, Math.max(3, numOf('lrn-pi', tool.iv)));
        var po = $('lrn-pay-out'); if (po) po.innerHTML = payoffOut();
      }
    } catch (err) { /* ignore */ }
  }
  var inited = false;
  function show() { if (!P) P = load(); view = 'home'; draw(); }
  function init() {
    try {
      if (inited || typeof document === 'undefined') return; var sub = $('paper-sub'), card = $('learn-card'); if (!sub || !card) return; inited = true;
      card.addEventListener('click', onClick); card.addEventListener('input', onInput); card.addEventListener('change', onInput);
      sub.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-sub]') : null; if (!b) return;
        var learn = b.getAttribute('data-sub') === 'learn', pt = $('pt-card');
        Array.prototype.forEach.call(sub.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
        if (pt) pt.style.display = learn ? 'none' : ''; card.style.display = learn ? '' : 'none';
        if (learn) show();
      });
    } catch (e) { try { console.warn('[Learn]', e && e.message); } catch (_) {} }
  }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init(); }

  var api = { bs: bs, payoff: payoff, summarize: summarize, sizeLots: sizeLots, buildLegs: buildLegs, missions: missions, PRESETS: PRESETS, LESSONS: LESSONS, init: init };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Learn = api;
})(typeof window !== 'undefined' ? window : globalThis);

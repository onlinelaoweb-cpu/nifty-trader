'use strict';
// Go-Live Checklist content (13 Oct 2026) — served only through the token-protected /api/go-live-checklist route,
// never as a public static file (the Security gate names real gaps in this app). Text mirrors the Claude Doc.
// `backtick` spans are rendered as <code>. Not legal advice; Gate 2 items must be confirmed with Fyers / SEBI / a lawyer.
module.exports = {
  updated: '2026-10-13',
  intro: 'Abhi live trading ka samay nahi hai: paanch gates mein se ek bhi poora nahi hua. App paper trading par hi rahega jab tak paanchon tick na ho jaayein. Gates ek ke baad ek hain, koi skip nahi. Ek bhi fail ho toh wapas paper par.',
  disclaimer: 'Main vakeel nahi hoon aur SEBI ke niyam badalte rehte hain. Gate 2 ka har item apne broker (Fyers) ki compliance page ya SEBI/NSE ke circular se khud match karna.',
  gates: [
    { id: 'g1', title: 'Gate 1 · Aankde', note: 'Go tabhi, jab ek pehle se naam liya hua engine kam se kam 100 independent bets par costs ke baad positive nikle.', items: [
      'Ek hi engine/strategy ka naam pehle likh do. Sirf wahi jaanchi jaayegi (multiple-testing se bachne ke liye).',
      'Niyam freeze: test window mein koi rule ya threshold nahi badlega. Badla toh ginti dobara zero se.',
      'Ek bet = same strike + same direction, 90 minute ke andar. 100 trades nahi, 100 bets gino.',
      'Kam se kam 100 independent bets aur 20 trading days, forward paper data se (Auto Journal, 12 Oct ke baad).',
      'Costs shamil: STT, ~0.07% turnover, 1 point slippage har taraf. (`&cost=` flag exit-rule-study mein abhi baaki hai.)',
      'Costs ke baad average per bet positive aur 95% range ka neeche wala hissa bhi 0 se upar.',
      'Split-half: pehla aadha aur doosra aadha, dono alag-alag positive.',
      'Koi ek din kul profit ke 30% se zyada nahi (ek trending din se jeet nahi).',
      '18 Oct ka unified audit pura, crude alag Nifty se.',
      'Paper mein worst day aur max drawdown likh lo. Yahi Gate 4 ki loss limit ka aadhaar banega.' ] },
    { id: 'g2', title: 'Gate 2 · SEBI aur broker', note: 'Static IP ka niyam Railway ke saath sabse bada practical roadblock hai. Points ek broker-blog se hain, SEBI ke asli circular se nahi; har item broker se confirm karo.', items: [
      'Fyers se confirm: retail API algo ke niyam (static IP, OAuth + 2FA, roz session band, algo-ID tagging) tumhare account par kaise lagu hain.',
      'Static IP: Railway par static outbound IP milta hai ya nahi, aur kharcha kitna. Extra kharcha tay karne se pehle tumhari approval.',
      'Order rate 10 orders per second se bahut neeche. Code mein hard cap (jaise 1 order/second).',
      'Sirf apne (aur dependent family ke) account ke liye. Kisi dost ya doosre ka paisa ya account nahi.',
      'Signals doosron ko (Telegram group, YouTube): jab tak SEBI Research Analyst / Investment Adviser ka sawal saaf na ho, koi buy/sell call nahi.',
      'Daily login flow OAuth + 2FA ke saath chale.',
      'F&O ki kamai ka tax aur record: CA se confirm (audit, ITR form).' ] },
    { id: 'g3', title: 'Gate 3 · Security', note: 'Live orders ke saath ek leaked token ya ek galat push seedha paisa hai. Zyada tar kaam muft hain.', items: [
      '`APP_TOKEN` lamba aur random (32+ characters). Order wale kaam ke liye token URL mein nahi, sirf header mein.',
      'Token compare constant-time ho. Order wale routes par `APP_TOKEN` na ho toh app band rahe, khula nahi.',
      'Order ke liye alag step: alag PIN ya TOTP. Sirf `APP_TOKEN` se order nahi.',
      'GitHub account par 2FA aur `main` branch protected: seedha push nahi, tests pass hone par hi merge.',
      'Railway account par 2FA, sirf zaroori log. Secrets sirf Railway variables mein, kabhi file ya chat mein nahi.',
      '`package-lock.json` jodo, versions pin karo, `npm audit` chalao.',
      'Content-Security-Policy sahi karo, taaki koi XSS token na chura sake.',
      'Telegram bot token surakshit rakho.',
      'Broker API key sirf zaroori permission ke saath aur static IP se bandhi ho.',
      'Logs mein koi token ya key na dikhe (ek baar poora check). 401 errors achanak badhne par Telegram alert.',
      'Database ka URL private ho, public proxy band.' ] },
    { id: 'g4', title: 'Gate 4 · Risk engine', note: 'Abhi app mein order bhejne wala code hai hi nahi (sirf paper). Pehla version sirf suggest kare aur order tumhare tap se jaaye.', items: [
      'Order sirf tumhare tap ke baad jaaye (phir TOTP). App khud order nahi bhejta.',
      'Server par hard limits: pilot mein max 1 lot, max 1 open position, din mein max 3 orders.',
      'Daily loss limit (Gate 1 ke worst-day se tay hoga). Limit lagte hi naye orders band.',
      'Kill switch: ek tap aur ek Railway variable se saare naye orders band. Khule position ka manual square-off raasta.',
      'Duplicate order nahi: restart ya retry par wahi order dobara nahi. Har order ki apni ID.',
      'Order ke liye price sirf broker ke apne feed se. Yahoo fallback par ho toh order band.',
      'Har minute broker se order/position ka status match. Mismatch par turant Telegram alert.',
      'Sirf limit orders, ek price band ke andar. Illiquid strike par order nahi.',
      'Samay ke niyam: 09:20 se pehle aur 15:00 ke baad naye orders nahi. Expiry din ke alag niyam likho.',
      'Nakli broker ke saath poora test: timeout, aadha fill, reject, token expire. Alag staging deploy.',
      'Kam se kam 2 hafte dry-run: poora live code path chale par order nakli broker ko jaaye.' ] },
    { id: 'g5', title: 'Gate 5 · 1 lot ka pilot', note: 'Pilot paise kamane ke liye nahi, yeh dekhne ke liye hai ki live fill paper se kitna alag aata hai. Achha hafta aane par bhi lots nahi badhte.', items: [
      'Sirf Gate 1 mein naam liya hua ek engine, sirf 1 lot, sirf Nifty.',
      'Kam se kam 20 trading days. Beech mein rule nahi badalna.',
      'Roz ki aur hafte ki loss limit pehle se likhi hui. Lagte hi band.',
      'Roz ek line likho: kya paper se alag hua (slippage, deri, reject, manual override).',
      'Din 10 aur din 20 par review: live ka average per bet, paper ke saath. Fark costs se zyada ho toh wapas paper.',
      'Pilot rokne ke niyam (pehle se tay): paper se kharab live, ya loss limit do baar lagi, ya koi order-galti.',
      'Lots badhane ka faisla sirf ek alag, poore review ke baad. Kabhi ek achhe hafte ke baad nahi.' ] }
  ]
};
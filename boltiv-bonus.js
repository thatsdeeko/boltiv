/* BOLTIV Bonus / Cashback UI.
   - Purchase pages: shows a "Use my Bonus Balance" switch and tells the server (useBonus:true) when it is on.
   - Dashboard: shows the Bonus Balance card with the "How cashback works" explainer.
   Fully defensive: if anything fails, the page behaves exactly as it did before. */
(function(){
  'use strict';
  var API=window.BOLTIV_API_BASE||'';
  var PURCHASE_PATHS=['/api/vtu/purchase','/api/vtu/airtime','/api/vtu/data','/api/vtu/cable','/api/vtu/electricity','/api/vtu/exam-pin'];
  var useBonus=false;          // only becomes true when the switch exists and is on
  var bonus=null;

  function money(n){return '\u20A6'+Number(n||0).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});}
  function dateText(d){try{return new Date(d).toLocaleDateString('en-NG',{day:'numeric',month:'short',year:'numeric'});}catch(e){return '';}}

  // Add useBonus to purchase requests when the customer chose to use their bonus.
  var prevFetch=window.fetch;
  window.fetch=function(input,init){
    try{
      if(useBonus&&init&&String(init.method||'').toUpperCase()==='POST'&&typeof init.body==='string'){
        var url=typeof input==='string'?input:(input&&input.url)||'';
        var path=url.replace(/^https?:\/\/[^\/]+/,'').split('?')[0];
        if(PURCHASE_PATHS.indexOf(path)!==-1){
          var payload=JSON.parse(init.body);
          if(payload&&typeof payload==='object'){
            payload.useBonus=true;
            init=Object.assign({},init,{body:JSON.stringify(payload)});
          }
        }
      }
    }catch(e){}
    return prevFetch.call(window,input,init);
  };

  function authHeaders(){
    var h={};
    try{var t=window.boltivMemoryStorage&&window.boltivMemoryStorage.getItem('boltivAuthToken');if(t)h.Authorization='Bearer '+t;}catch(e){}
    return h;
  }
  function loadBonus(){
    return prevFetch.call(window,API+'/api/bonus',{credentials:'include',headers:authHeaders(),cache:'no-store'})
      .then(function(r){return r.json();})
      .then(function(d){return d&&d.success&&d.bonus?d.bonus:null;})
      .catch(function(){return null;});
  }

  /* ---------- purchase pages ---------- */
  function mountSwitch(b){
    var button=document.getElementById('purchaseButton')||document.getElementById('pay')||document.getElementById('buy');
    if(!button||!button.parentNode||document.getElementById('boltivBonusSwitch'))return;
    if(!b||!(b.balance>0))return;
    var soon=b.nextExpiry?('Soonest expiry: '+money(b.nextExpiry.amount)+' on '+dateText(b.nextExpiry.date)):'';
    var card=document.createElement('div');
    card.id='boltivBonusSwitch';
    card.style.cssText='margin:14px 0;padding:14px 16px;border:1px solid #e8d9a8;border-radius:16px;background:#fffdf4;display:flex;align-items:center;gap:12px;';
    card.innerHTML=
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:13px;font-weight:900;color:#171717">Use my Bonus Balance</div>'+
        '<div style="font-size:11px;color:#777;margin-top:3px;line-height:1.5">'+money(b.balance)+' available'+(soon?' &middot; '+soon:'')+'</div>'+
        '<div id="boltivBonusHint" style="font-size:11px;color:#8a6a07;margin-top:4px;line-height:1.5"></div>'+
      '</div>'+
      '<label style="position:relative;display:inline-block;width:46px;height:26px;flex:none;cursor:pointer">'+
        '<input id="boltivBonusToggle" type="checkbox" style="opacity:0;width:0;height:0;position:absolute">'+
        '<span id="boltivBonusTrack" style="position:absolute;inset:0;border-radius:26px;background:#d9d9d2;transition:.2s"></span>'+
        '<span id="boltivBonusKnob" style="position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3)"></span>'+
      '</label>';
    button.parentNode.insertBefore(card,button);
    var toggle=document.getElementById('boltivBonusToggle');
    var track=document.getElementById('boltivBonusTrack');
    var knob=document.getElementById('boltivBonusKnob');
    var hint=document.getElementById('boltivBonusHint');
    function paint(){
      useBonus=toggle.checked;
      track.style.background=toggle.checked?'#b8860b':'#d9d9d2';
      knob.style.left=toggle.checked?'23px':'3px';
      hint.textContent=toggle.checked
        ?'Your bonus is used first (it can cover all or part of this purchase). Your wallet pays the rest.'
        :'Only your wallet will be used for this purchase.';
    }
    toggle.addEventListener('change',paint);
    toggle.checked=true;   // default: use bonus first; the customer can switch it off
    paint();
  }

  /* ---------- dashboard ---------- */
  function mountDashboardCard(b){
    var mount=document.getElementById('bonusSection');
    if(!mount||document.getElementById('boltivBonusCard')||!b)return;
    var paused=b.enabled===false;
    var card=document.createElement('section');
    card.id='boltivBonusCard';
    card.className='bonus-card';
    var soon=b.nextExpiry?('<div class="bonus-expiry">'+money(b.nextExpiry.amount)+' expires on '+dateText(b.nextExpiry.date)+'</div>'):'';
    var pausedNote=paused?'<div class="bonus-paused">Cashback is currently paused. Your existing bonus can still be used.</div>':'';
    card.innerHTML=
      '<div class="bonus-label">BONUS BALANCE</div>'+
      '<div class="bonus-value">'+money(b.balance)+'</div>'+
      soon+pausedNote+
      '<details class="bonus-details"><summary>How cashback works</summary>'+
      '<ul>'+
        '<li>Earn cashback every time you buy <b>data</b>: <b>1%</b> on purchases from ₦100 to ₦1,000 and <b>2%</b> on purchases above ₦1,000.</li>'+
        '<li>The most you can earn on one purchase is <b>'+money(b.maxCashback||200).replace('.00','')+'</b>.</li>'+
        '<li>Cashback goes into your Bonus Balance once your data is delivered successfully.</li>'+
        '<li>Use your Bonus Balance to pay for any purchase (data, airtime, cable, electricity, exam pins), in full or in part. You choose at checkout.</li>'+
        '<li>Bonus can be spent on purchases only and cannot be withdrawn.</li>'+
        '<li>Each cashback expires <b>'+(b.expiryDays||90)+' days</b> after you earn it. The oldest is used first.</li>'+
        '<li>If a purchase fails or is refunded, bonus you used is returned and cashback earned on it is removed.</li>'+
      '</ul></details>';
    mount.replaceChildren(card);
  }

  /* ---------- data page: "You'll earn" line in the plan confirmation popup ---------- */
  function cashbackFor(amount){
    var a=Number(amount);
    if(!isFinite(a)||a<100)return 0;
    var c=Math.round(a*(a>1000?0.02:0.01)*100)/100;
    return Math.min(c,Number(bonus&&bonus.maxCashback)||200);
  }
  function mountCashbackPreview(){
    var box=document.getElementById('planConfirmDetails');
    if(!box||typeof MutationObserver==='undefined')return;
    var busy=false;
    function addLine(){
      if(busy||!bonus||bonus.enabled===false)return;
      try{if(typeof isAgent!=='undefined'&&isAgent)return;}catch(e){}
      if(box.querySelector('.boltiv-cashback-line'))return;
      var rows=box.querySelectorAll('.modal-detail');
      var priceRow=null;
      for(var i=0;i<rows.length;i++){var l=rows[i].querySelector('span');if(l&&l.textContent.trim()==='Price')priceRow=rows[i];}
      if(!priceRow)return;
      var strong=priceRow.querySelector('strong');
      var amount=strong?Number(String(strong.textContent).replace(/[^0-9.]/g,'')):0;
      var cb=cashbackFor(amount);
      if(!(cb>0))return;
      busy=true;
      var row=document.createElement('div');
      row.className='modal-detail boltiv-cashback-line';
      row.innerHTML='<span>Cashback</span><strong style="color:#8a6a07">+'+money(cb)+'</strong>';
      priceRow.parentNode.insertBefore(row,priceRow.nextSibling);
      busy=false;
    }
    new MutationObserver(addLine).observe(box,{childList:true});
  }

  function start(){
    var onPurchasePage=!!(document.getElementById('purchaseButton')||document.getElementById('pay')||document.getElementById('buy'));
    var onDashboard=!!document.querySelector('.home-balance-card');
    if(!onPurchasePage&&!onDashboard)return;
    var ready=window.boltivAuthReady&&typeof window.boltivAuthReady.then==='function'?window.boltivAuthReady:Promise.resolve();
    ready.then(loadBonus).then(function(b){
      bonus=b;
      if(!b)return;
      try{if(onPurchasePage)mountSwitch(b);}catch(e){}
      try{if(onDashboard)mountDashboardCard(b);}catch(e){}
      try{if(location.pathname.replace(/\/$/,'').replace(/\.html$/,'')==='/data')mountCashbackPreview();}catch(e){}
    }).catch(function(){});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();

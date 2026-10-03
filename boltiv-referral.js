/* BOLTIV Referral UI.
   - Any page: remembers ?ref=CODE from the link a friend opened.
   - Register page: sends that code with the sign-up request.
   - Dashboard: "Refer & Earn" card (code, copy, WhatsApp share, progress, rules).
   - Receipt/transactions pages: makes the customer's referral link available so shared receipts can carry it.
   Defensive: if anything fails, pages behave exactly as before. */
(function(){
  'use strict';
  var API=window.BOLTIV_API_BASE||'';
  var KEY='boltivReferralCode';
  var memory={};

  function store(){
    return window.boltivMemoryStorage||{
      getItem:function(k){try{return window.localStorage.getItem(k);}catch(e){return memory[k]||null;}},
      setItem:function(k,v){try{window.localStorage.setItem(k,v);}catch(e){memory[k]=v;}}
    };
  }
  function money(n){return '\u20A6'+Number(n||0).toLocaleString('en-NG',{minimumFractionDigits:0,maximumFractionDigits:2});}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function cleanCode(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12);}

  // 1) remember the code from the link
  try{
    var fromUrl=cleanCode(new URLSearchParams(location.search).get('ref'));
    if(fromUrl.length>=4)store().setItem(KEY,fromUrl);
  }catch(e){}

  // 2) attach it to the sign-up request
  var prevFetch=window.fetch;
  window.fetch=function(input,init){
    try{
      if(init&&String(init.method||'').toUpperCase()==='POST'&&typeof init.body==='string'){
        var url=typeof input==='string'?input:(input&&input.url)||'';
        var path=url.replace(/^https?:\/\/[^\/]+/,'').split('?')[0];
        if(path==='/api/auth/register'){
          var code=cleanCode(store().getItem(KEY));
          var payload=JSON.parse(init.body);
          if(code.length>=4&&payload&&typeof payload==='object'&&!payload.ref){
            payload.ref=code;
            init=Object.assign({},init,{body:JSON.stringify(payload)});
          }
        }
      }
    }catch(e){}
    return prevFetch.call(window,input,init);
  };

  function authHeaders(){
    var h={};
    try{var t=store().getItem('boltivAuthToken');if(t)h.Authorization='Bearer '+t;}catch(e){}
    return h;
  }
  function loadReferral(){
    return prevFetch.call(window,API+'/api/referral',{credentials:'include',headers:authHeaders(),cache:'no-store'})
      .then(function(r){return r.json();})
      .then(function(d){return d&&d.success&&d.referral?d.referral:null;})
      .catch(function(){return null;});
  }
  function inviteText(r){
    return 'Join me on BOLTIV \u2014 airtime, data, cable TV and electricity at great prices. '+
      'Sign up with my link and get a '+money(r.friendReward)+' bonus after your first '+money(r.threshold)+' in purchases: '+r.link;
  }
  function shareInvite(r){
    var text=inviteText(r);
    if(navigator.share){navigator.share({text:text}).catch(function(){});return;}
    window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank','noopener');
  }

  function mountCard(r){
    if(!r||document.getElementById('boltivReferralCard'))return;
    var services=document.querySelector('.home-services-section');
    var balance=document.querySelector('.home-balance-card');
    if(!services&&!balance)return;
    var paused=r.enabled===false;
    var s=r.stats||{};
    var card=document.createElement('section');
    card.id='boltivReferralCard';
    card.className='section';
    card.style.cssText='margin:14px 0;padding:16px 18px;border:1px solid #e8d9a8;border-radius:20px;background:#fffdf4;';

    var friend='';
    var f=r.asFriend;
    if(f&&f.status==='pending'&&!f.expired&&!paused){
      var pct=Math.max(0,Math.min(100,Math.round((f.spent/r.threshold)*100)));
      friend='<div style="margin:12px 0;padding:12px;border-radius:14px;background:#fff;border:1px solid #efe6c4">'+
        '<div style="font-size:12px;font-weight:900;color:#171717">Your welcome bonus: '+money(f.reward)+'</div>'+
        '<div style="font-size:11px;color:#777;margin-top:3px">Spend '+money(Math.max(0,r.threshold-f.spent))+' more within '+r.windowDays+' days of signing up to unlock it.</div>'+
        '<div style="height:8px;border-radius:8px;background:#eee;margin-top:8px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:#b8860b"></div></div>'+
        '<div style="font-size:10px;color:#999;margin-top:4px">'+money(f.spent)+' of '+money(r.threshold)+'</div></div>';
    }

    var pausedNote=paused?'<div style="font-size:11px;color:#b94c4c;margin-top:8px;font-weight:700">Referral rewards are currently paused.</div>':'';
    card.innerHTML=
      '<div style="font-size:10px;font-weight:900;letter-spacing:.08em;color:#777">REFER &amp; EARN</div>'+
      '<div style="font-size:15px;font-weight:900;color:#171717;margin-top:4px;line-height:1.4">Earn '+money(r.referrerReward)+' for every friend who joins and spends '+money(r.threshold)+'.</div>'+
      friend+
      '<div style="display:flex;align-items:center;gap:10px;margin-top:12px">'+
        '<div style="flex:1;min-width:0;padding:11px 12px;border:1px dashed #d4af37;border-radius:12px;background:#fff;font-weight:900;letter-spacing:.14em;font-size:15px;text-align:center;color:#8a6a07">'+esc(r.code)+'</div>'+
        '<button id="boltivRefCopy" type="button" style="border:1px solid #d4af37;background:#fffdf4;color:#8a6d00;border-radius:12px;padding:12px 14px;font-size:11px;font-weight:900;cursor:pointer">COPY LINK</button>'+
      '</div>'+
      '<button id="boltivRefShare" type="button" style="width:100%;margin-top:10px;border:0;border-radius:13px;padding:13px;background:#25D366;color:#fff;font-weight:900;font-size:12px;letter-spacing:.04em;cursor:pointer">INVITE ON WHATSAPP</button>'+
      '<div style="display:flex;gap:8px;margin-top:12px;text-align:center">'+
        '<div style="flex:1"><b style="font-size:16px">'+Number(s.total||0)+'</b><div style="font-size:10px;color:#888">Joined</div></div>'+
        '<div style="flex:1"><b style="font-size:16px">'+Number(s.rewarded||0)+'</b><div style="font-size:10px;color:#888">Rewarded</div></div>'+
        '<div style="flex:1"><b style="font-size:16px">'+money(s.earned)+'</b><div style="font-size:10px;color:#888">Earned</div></div>'+
      '</div>'+
      pausedNote+
      '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;font-weight:900;color:#b8860b">How referrals work</summary>'+
      '<ul style="margin:10px 0 0;padding-left:18px;font-size:12px;line-height:1.7;color:#444">'+
        '<li>Share your link. Your friend signs up with it.</li>'+
        '<li>When your friend has spent <b>'+money(r.threshold)+'</b> on successful purchases within <b>'+r.windowDays+' days</b> of signing up, you get <b>'+money(r.referrerReward)+'</b> and your friend gets <b>'+money(r.friendReward)+'</b>.</li>'+
        '<li>Rewards go into your Bonus Balance. It can be spent on any purchase but not withdrawn, and expires 90 days after you receive it.</li>'+
        '<li>Only new accounts can be referred, and you cannot refer yourself.</li>'+
        '<li>Up to '+r.monthlyCap+' rewarded referrals per month.</li>'+
        '<li>If purchases are refunded and the total drops below '+money(r.threshold)+', the rewards are taken back.</li>'+
      '</ul></details>';
    if(services&&services.parentNode)services.parentNode.insertBefore(card,services);
    else balance.closest('section').parentNode.insertBefore(card,balance.closest('section').nextSibling);

    var copy=document.getElementById('boltivRefCopy');
    if(copy)copy.onclick=function(){
      var done=function(){copy.textContent='COPIED';setTimeout(function(){copy.textContent='COPY LINK';},1800);};
      try{navigator.clipboard.writeText(r.link).then(done,done);}catch(e){done();}
    };
    var share=document.getElementById('boltivRefShare');
    if(share)share.onclick=function(){shareInvite(r);};
  }

  function start(){
    var onDashboard=!!document.querySelector('.home-balance-card');
    var onReceipt=!!(document.getElementById('modalDetails')||document.getElementById('details'));
    if(!onDashboard&&!onReceipt)return; // register page only needs the fetch wrapper above
    var ready=window.boltivAuthReady&&typeof window.boltivAuthReady.then==='function'?window.boltivAuthReady:Promise.resolve();
    ready.then(loadReferral).then(function(r){
      if(!r)return;
      if(r.enabled!==false)window.boltivReferralLink=r.link; // used by "share receipt"
      if(onDashboard){try{mountCard(r);}catch(e){}}
    }).catch(function(){});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();

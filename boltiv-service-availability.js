/* BOLTIV service availability.
   Reads /api/services (public) and reflects what admin has switched off or put under maintenance:
   - purchase pages (airtime, data, cable, electricity, exam-pin): full-screen "unavailable" notice instead of a form
   - dashboard: the service tile is hidden
   - services page: the card is dimmed, badged and no longer a link
   Fails OPEN: if the check can't be made, nothing changes. The server still refuses purchases for a service that is off. */
(function(){
  "use strict";
  var KEYS={"/airtime":"airtime","/bulk-airtime":"airtime","/international":"international","/sms":"sms","/data":"data","/cable":"cable","/electricity":"electricity","/exam-pin":"exam_pin"};
  var NAMES={airtime:"Airtime",data:"Data",cable:"Cable TV",electricity:"Electricity",exam_pin:"Exam PINs",international:"International Top-up",sms:"Bulk SMS"};
  var CACHE="bvServices";
  var path=(location.pathname||"/").toLowerCase().replace(/\/+$/,"").replace(/\.html$/,"")||"/";
  var pageKey=KEYS[path]||"";
  var isDashboard=path==="/dashboard",isServices=path==="/services";
  if(!pageKey&&!isDashboard&&!isServices)return;

  function readCache(){try{var c=JSON.parse(sessionStorage.getItem(CACHE)||"null");if(c&&Date.now()-c.t<120000&&Array.isArray(c.s))return c.s}catch(e){}return null}
  function writeCache(s){try{sessionStorage.setItem(CACHE,JSON.stringify({t:Date.now(),s:s}))}catch(e){}}
  function fetchServices(){
    return fetch((window.BOLTIV_API_BASE||"")+"/api/services",{cache:"no-store"})
      .then(function(r){if(!r.ok)throw new Error("x");return r.json()})
      .then(function(d){if(!d||!d.success||!Array.isArray(d.services))throw new Error("x");return d.services});
  }
  function status(list,key){
    for(var i=0;i<list.length;i++)if(list[i].key===key){
      if(list[i].enabled===false)return"off";
      if(list[i].maintenance===true)return"maintenance";
      return"ok";
    }
    return"ok";               // unknown service: leave it alone
  }

  function showBlock(key,st){
    var o=document.getElementById("bvUnavail");
    if(!o){
      o=document.createElement("div");o.id="bvUnavail";
      o.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:28px;background:var(--t-bg-ffffff,#111);color:var(--t-fg-171717,#f4f4f4);font-family:inherit;text-align:center";
      var box=document.createElement("div");box.style.cssText="max-width:340px";
      var h=document.createElement("div");h.id="bvUnavailTitle";h.style.cssText="font-size:22px;font-weight:900;letter-spacing:-.02em;margin-bottom:10px";
      var p=document.createElement("div");p.id="bvUnavailText";p.style.cssText="font-size:14px;line-height:1.6;opacity:.75;margin-bottom:22px";
      var a=document.createElement("a");a.href="/dashboard";a.textContent="BACK TO DASHBOARD";
      a.style.cssText="display:inline-block;background:#D4AF37;color:#171717;text-decoration:none;font-weight:900;font-size:12px;letter-spacing:.08em;padding:14px 22px;border-radius:14px";
      box.appendChild(h);box.appendChild(p);box.appendChild(a);o.appendChild(box);
      document.body.appendChild(o);
      document.documentElement.style.overflow="hidden";
    }
    document.getElementById("bvUnavailTitle").textContent=NAMES[key]+(st==="maintenance"?" is under maintenance":" is unavailable right now");
    document.getElementById("bvUnavailText").textContent="We've temporarily paused this service. Please check back soon. Nothing has been charged to your wallet.";
  }
  function hideBlock(){var o=document.getElementById("bvUnavail");if(o){o.remove();document.documentElement.style.overflow=""}}

  function cardKey(a){var h=(a.getAttribute("data-bv-href")||a.getAttribute("href")||"").toLowerCase().replace(/\.html$/,"");return KEYS[h]||""}
  function applyCards(list){
    var sel=isDashboard?"a.home-service-card":"a.service-card,div.service-card[data-bv-href]";
    var cards=document.querySelectorAll(sel);
    for(var i=0;i<cards.length;i++){
      var c=cards[i],k=cardKey(c);if(!k)continue;
      var st=status(list,k);
      if(isDashboard){c.style.display=st==="ok"?"":"none";continue}
      if(st!=="ok"&&c.tagName==="A"){
        c.setAttribute("data-bv-href",c.getAttribute("href"));c.removeAttribute("href");
        c.setAttribute("aria-disabled","true");c.style.opacity=".55";c.style.cursor="default";
        var arrow=c.querySelector(".service-arrow");if(arrow)arrow.style.display="none";
        var copy=c.querySelector(".service-card-copy");
        if(copy&&!copy.querySelector(".bv-off")){var b=document.createElement("span");b.className="bv-off";b.style.cssText="display:inline-block;margin-top:6px;font-size:9px;font-weight:900;letter-spacing:.08em;color:#b94c4c";b.textContent=st==="maintenance"?"UNDER MAINTENANCE":"UNAVAILABLE";copy.appendChild(b)}
      }else if(st==="ok"&&c.tagName==="A"&&!c.getAttribute("href")&&c.getAttribute("data-bv-href")){
        c.setAttribute("href",c.getAttribute("data-bv-href"));c.removeAttribute("aria-disabled");c.style.opacity="";c.style.cursor="";
        var ar=c.querySelector(".service-arrow");if(ar)ar.style.display="";
        var bb=c.querySelector(".bv-off");if(bb)bb.remove();
      }
    }
  }
  function apply(list){
    if(pageKey){var st=status(list,pageKey);if(st==="ok")hideBlock();else showBlock(pageKey,st)}
    else applyCards(list);
  }
  function run(){
    var cached=readCache();if(cached)apply(cached);
    fetchServices().then(function(list){writeCache(list);apply(list)}).catch(function(){/* fail open */});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run,{once:true});else run();
})();

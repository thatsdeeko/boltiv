/* BOLTIV inactivity lock. If the user leaves the app/site (backgrounds the tab,
   closes it, or the device sleeps) for 10+ minutes, they're shown a PIN unlock
   screen the next time they return — before they can see or use anything else
   on the page. Requires boltiv-client.js to already be loaded on the page. */
(function(){
  if(!window.boltivMemoryStorage||!window.boltivAuthReady){return;}

  const LOCK_TIMEOUT_MS=10*60*1000;
  const LAST_ACTIVE_KEY="boltivLastActive";
  const API=window.BOLTIV_API_BASE||"https://boltiv-backend.onrender.com";
  const mem=window.boltivMemoryStorage;

  function now(){return Date.now();}
  function markActive(){try{mem.setItem(LAST_ACTIVE_KEY,String(now()));}catch(e){}}
  function lastActive(){const v=Number(mem.getItem(LAST_ACTIVE_KEY)||0);return Number.isFinite(v)?v:0;}

  function authToken(){return mem.getItem("boltivAuthToken")||"";}
  function authHeaders(){const t=authToken();return t?{Authorization:"Bearer "+t}:{};}

  function currentUser(){
    try{return JSON.parse(mem.getItem("boltivUser")||"{}")||{};}catch(e){return{};}
  }
  function firstName(user){
    const name=String(user.name||"").trim();
    if(!name)return "";
    return name.split(/\s+/)[0];
  }
  function initials(user){
    const name=String(user.name||"").trim();
    if(!name)return (String(user.email||"?").charAt(0)||"?").toUpperCase();
    const parts=name.split(/\s+/).filter(Boolean);
    const chars=parts.length>1?(parts[0][0]+parts[parts.length-1][0]):parts[0].slice(0,2);
    return chars.toUpperCase();
  }

  let overlay=null;
  let pinBuffer="";
  let boxes=[];
  let submitting=false;

  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

  function buildOverlay(){
    const user=currentUser();
    const el=document.createElement("div");
    el.id="boltivLockOverlay";
    el.innerHTML=`
      <style>
        #boltivLockOverlay{position:fixed;inset:0;z-index:999999;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:64px 24px 40px;font-family:Arial,Helvetica,sans-serif;color:#171717;overflow-y:auto}
        #boltivLockOverlay *{box-sizing:border-box}
        .boltiv-lock-avatar{width:64px;height:64px;border-radius:50%;background:#fff9e6;border:1px solid #ead58a;color:#b8860b;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:1000;align-self:flex-start}
        .boltiv-lock-title{margin-top:26px;font-size:26px;font-weight:1000;align-self:flex-start}
        .boltiv-lock-sub{margin-top:6px;font-size:13px;color:#777;align-self:flex-start}
        .boltiv-lock-boxes{display:flex;gap:14px;margin-top:28px;align-self:flex-start}
        .boltiv-lock-box{width:54px;height:54px;border:1.5px solid #e5e5e1;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:1000}
        .boltiv-lock-box.filled{border-color:#D4AF37}
        .boltiv-lock-box.active{border-color:#171717}
        .boltiv-lock-box span{width:10px;height:10px;border-radius:50%;background:#171717;display:none}
        .boltiv-lock-box.filled span{display:block}
        .boltiv-lock-error{margin-top:16px;min-height:16px;font-size:11px;font-weight:800;color:#b42318;align-self:flex-start}
        .boltiv-lock-keypad{margin-top:auto;padding-top:40px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;width:100%;max-width:320px}
        .boltiv-lock-key{height:64px;border:0;background:transparent;font-size:24px;font-weight:800;color:#171717;border-radius:50%}
        .boltiv-lock-key:active{background:#f4f4f0}
        .boltiv-lock-key.boltiv-lock-bio{color:#555;font-size:19px}
        .boltiv-lock-key.boltiv-lock-back{color:#c0392b;font-size:19px}
        .boltiv-lock-logout{margin-top:26px;background:transparent;border:0;color:#171717;font-size:13px;text-decoration:underline;padding:10px}
        @media(max-width:360px){.boltiv-lock-box{width:46px;height:46px}.boltiv-lock-key{height:56px}}
      </style>
      <div class="boltiv-lock-avatar">${esc(initials(user))}</div>
      <div class="boltiv-lock-title">Welcome Back${firstName(user)?" "+esc(firstName(user)):""}</div>
      <div class="boltiv-lock-sub">Enter your 4-Digit PIN</div>
      <div class="boltiv-lock-boxes" id="boltivLockBoxes"></div>
      <div class="boltiv-lock-error" id="boltivLockError"></div>
      <div class="boltiv-lock-keypad" id="boltivLockKeypad">
        ${[1,2,3,4,5,6,7,8,9].map(n=>`<button type="button" class="boltiv-lock-key" data-digit="${n}">${n}</button>`).join("")}
        <button type="button" class="boltiv-lock-key boltiv-lock-bio" id="boltivLockBio" aria-label="Biometric unlock">&#128272;</button>
        <button type="button" class="boltiv-lock-key" data-digit="0">0</button>
        <button type="button" class="boltiv-lock-key boltiv-lock-back" id="boltivLockBack" aria-label="Delete">&#10094;</button>
      </div>
      <button type="button" class="boltiv-lock-logout" id="boltivLockLogout">Not your account? Log out</button>
    `;
    document.documentElement.style.overflow="hidden";
    document.body.appendChild(el);
    const boxRow=el.querySelector("#boltivLockBoxes");
    for(let i=0;i<4;i++){
      const b=document.createElement("div");
      b.className="boltiv-lock-box";
      b.innerHTML="<span></span>";
      boxRow.appendChild(b);
    }
    boxes=Array.from(boxRow.children);
    updateBoxes();

    el.querySelectorAll("[data-digit]").forEach(btn=>{
      btn.addEventListener("click",()=>onDigit(btn.getAttribute("data-digit")));
    });
    el.querySelector("#boltivLockBack").addEventListener("click",onBackspace);
    el.querySelector("#boltivLockBio").addEventListener("click",()=>{
      showError("Biometric unlock isn't set up on this device yet — use your PIN.");
    });
    el.querySelector("#boltivLockLogout").addEventListener("click",onLogout);

    return el;
  }

  function updateBoxes(){
    boxes.forEach((box,i)=>{
      box.classList.toggle("filled",i<pinBuffer.length);
      box.classList.toggle("active",i===pinBuffer.length);
    });
  }

  function showError(msg){
    const e=document.getElementById("boltivLockError");
    if(e)e.textContent=msg||"";
  }

  function shake(){
    const row=document.getElementById("boltivLockBoxes");
    if(!row)return;
    row.style.transition="transform .08s";
    let n=0;
    const iv=setInterval(()=>{
      n++;
      row.style.transform=n%2?"translateX(-6px)":"translateX(6px)";
      if(n>5){clearInterval(iv);row.style.transform="translateX(0)";}
    },40);
  }

  function onDigit(d){
    if(submitting||pinBuffer.length>=4)return;
    pinBuffer+=d;
    showError("");
    updateBoxes();
    if(pinBuffer.length===4)submitPin();
  }
  function onBackspace(){
    if(submitting)return;
    pinBuffer=pinBuffer.slice(0,-1);
    updateBoxes();
  }

  async function submitPin(){
    submitting=true;
    try{
      const r=await fetch(API+"/api/security/verify-pin",{
        method:"POST",
        credentials:"include",
        headers:Object.assign({"Content-Type":"application/json"},authHeaders()),
        body:JSON.stringify({pin:pinBuffer})
      });
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d.success){
        unlock();
        return;
      }
      if(r.status===429){
        showError(d.message||"Too many attempts. Please wait a few minutes and try again.");
      }else{
        showError(d.message||"Incorrect PIN. Please try again.");
      }
      shake();
      pinBuffer="";
      updateBoxes();
    }catch(e){
      showError("Unable to reach BOLTIV. Check your connection and try again.");
      pinBuffer="";
      updateBoxes();
    }finally{
      submitting=false;
    }
  }

  async function onLogout(){
    try{
      await fetch(API+"/api/auth/logout",{method:"POST",credentials:"include",headers:authHeaders()});
    }catch(e){}
    try{mem.clear();}catch(e){}
    location.replace("/login");
  }

  function unlock(){
    markActive();
    pinBuffer="";
    if(overlay&&overlay.parentNode){overlay.parentNode.removeChild(overlay);}
    overlay=null;
    document.documentElement.style.overflow="";
  }

  function showLock(){
    if(overlay)return;
    overlay=buildOverlay();
  }

  async function checkLock(){
    const user=await window.boltivAuthReady;
    if(!user)return; // not logged in — boltivRequireAuth (if present) handles that
    const elapsed=now()-lastActive();
    if(lastActive()&&elapsed>=LOCK_TIMEOUT_MS){
      // Only lock if the account actually has a Transaction PIN set — otherwise
      // there'd be nothing to verify against, and the existing "set your PIN
      // first" redirect already handles that case separately.
      try{
        const r=await fetch(API+"/api/security",{credentials:"include",cache:"no-store",headers:authHeaders()});
        const d=await r.json().catch(()=>({}));
        if(r.ok&&d.success&&d.transactionPinSet){
          showLock();
          return;
        }
      }catch(e){}
    }
    markActive();
  }

  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="hidden"){
      markActive();
    }else if(document.visibilityState==="visible"){
      checkLock();
    }
  });
  window.addEventListener("pagehide",markActive);

  // Periodic heartbeat while the page stays open and visible, so an abrupt
  // process kill (rather than a clean backgrounding event) doesn't leave a
  // stale timestamp lingering indefinitely.
  setInterval(()=>{
    if(document.visibilityState==="visible"&&!overlay)markActive();
  },30000);

  checkLock();
})();

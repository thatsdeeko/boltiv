/* BOLTIV Favorites: saved phone numbers (Airtime, Data) and smartcards (Cable TV).
   Adds a row of tappable saved items under the number field and a "Save" link when a valid number is typed.
   Fails silently: if anything goes wrong the purchase page works exactly as before. */
(function(){
  "use strict";
  try{
    var path=(location.pathname||"").replace(/\/+$/,"").replace(/\.html$/,"");
    var page=path==="/airtime"?"airtime":path==="/data"?"data":path==="/cable"?"cable":"";
    if(!page)return;
    var kind=page==="cable"?"cable":"phone";
    var input=document.getElementById(kind==="cable"?"smartcard":"phoneNumber");
    if(!input)return;
    var valid=kind==="cable"?/^\d{8,20}$/:/^0\d{10}$/;
    var noun=kind==="cable"?"smartcard":"number";
    var favs=[],editing=false,editingFor="",busy=false;

    var css=document.createElement("style");
    css.textContent=
      ".bvf{margin:8px 0 4px}"+
      ".bvf-chips{display:flex;gap:8px;overflow-x:auto;padding:2px 0 6px;-webkit-overflow-scrolling:touch}"+
      ".bvf-chip{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:8px 12px;border-radius:12px;border:1px solid var(--t-bd-e5e5e1,#e5e5e1);background:var(--t-bg-ffffff,#fff);color:var(--t-fg-171717,#171717);font-family:inherit;cursor:pointer;text-align:left}"+
      ".bvf-chip b{font-size:12px;font-weight:800;line-height:1.2}"+
      ".bvf-chip span{font-size:10px;color:var(--t-fg-777777,#777)}"+
      ".bvf-chip:active{border-color:#D4AF37}"+
      ".bvf-save{font-size:11px;font-weight:800;color:#D4AF37;min-height:18px}"+
      ".bvf-link{background:none;border:0;padding:4px 0;font:inherit;color:#D4AF37;cursor:pointer}"+
      ".bvf-form{display:flex;gap:8px;align-items:center;margin-top:4px}"+
      ".bvf-form input{flex:1;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid var(--t-bd-e5e5e1,#e5e5e1);background:var(--t-bg-ffffff,#fff);color:var(--t-fg-171717,#171717);font-size:13px;font-family:inherit}"+
      ".bvf-form button{padding:9px 12px;border-radius:10px;border:1px solid #D4AF37;background:#D4AF37;color:#171717;font-size:11px;font-weight:900;font-family:inherit;cursor:pointer}"+
      ".bvf-form button.bvf-cancel{background:transparent;color:#D4AF37}"+
      ".bvf-msg{font-size:11px;font-weight:700;color:var(--t-fg-b94c4c,#b94c4c);margin-top:4px}"+
      ".bvf-ok{color:var(--t-fg-777777,#777);font-weight:700}";
    document.head.appendChild(css);

    var box=document.createElement("div");box.className="bvf";
    var chipsEl=document.createElement("div");chipsEl.className="bvf-chips";
    var saveEl=document.createElement("div");saveEl.className="bvf-save";
    box.appendChild(chipsEl);box.appendChild(saveEl);
    input.insertAdjacentElement("afterend",box);

    function call(p,payload){
      var h={"Content-Type":"application/json"};
      var t=window.boltivMemoryStorage&&window.boltivMemoryStorage.getItem("boltivAuthToken");
      if(t)h.Authorization="Bearer "+t;
      return fetch((window.BOLTIV_API_BASE||"")+p,{method:payload?"POST":"GET",headers:h,body:payload?JSON.stringify(payload):undefined,cache:"no-store"})
        .then(function(r){return r.json().catch(function(){return {};});});
    }
    function currentValue(){return String(input.value||"").replace(/\s+/g,"");}
    function activeNetwork(){var b=document.querySelector(".network-button.active");return b?String(b.dataset.network||"").toUpperCase():"";}
    function activeProvider(){var b=document.querySelector(".provider.active");return b?String(b.dataset.provider||"").toUpperCase():"";}
    function short(v){return kind==="cable"?"…"+v.slice(-4):v.slice(0,4)+"…"+v.slice(-3);}

    function apply(f){
      if(kind==="cable"){
        // choose the provider first (it resets verification), then fill the number
        var pb=document.querySelectorAll(".provider");
        for(var i=0;i<pb.length;i++){if(String(pb[i].dataset.provider||"").toUpperCase()===f.provider){pb[i].click();break;}}
        input.value=f.recipient;
        input.dispatchEvent(new Event("input",{bubbles:true}));
      }else{
        input.value=f.recipient;
        input.dispatchEvent(new Event("input",{bubbles:true}));
        if(f.network){
          var nb=document.querySelectorAll(".network-button");
          for(var j=0;j<nb.length;j++){if(String(nb[j].dataset.network||"").toUpperCase()===f.network){nb[j].click();break;}}
        }
      }
      editing=false;refreshSave();
    }

    function renderChips(){
      chipsEl.innerHTML="";
      chipsEl.style.display=favs.length?"flex":"none";
      favs.forEach(function(f){
        var b=document.createElement("button");b.type="button";b.className="bvf-chip";
        var n=document.createElement("b");n.textContent=f.name;
        var s=document.createElement("span");s.textContent=short(f.recipient)+(f.network?" · "+f.network:f.provider?" · "+f.provider:"");
        b.appendChild(n);b.appendChild(s);
        b.onclick=function(){apply(f);};
        chipsEl.appendChild(b);
      });
    }

    function save(name,msgEl){
      if(busy)return;
      name=String(name||"").trim();
      if(!name){msgEl.textContent="Enter a name first.";return;}
      var v=currentValue(),body={kind:kind,name:name,recipient:v};
      if(kind==="cable")body.provider=activeProvider();else body.network=activeNetwork();
      busy=true;msgEl.textContent="";
      call("/api/favorites",body).then(function(d){
        busy=false;
        if(d&&d.success&&d.favorite){
          favs=favs.filter(function(x){return x.recipient!==d.favorite.recipient;});
          favs.unshift(d.favorite);editing=false;renderChips();refreshSave();
        }else msgEl.textContent=(d&&d.message)||"Could not save. Please try again.";
      }).catch(function(){busy=false;msgEl.textContent="Could not save. Please try again.";});
    }

    function refreshSave(){
      var v=currentValue();
      if(editing&&editingFor===v&&saveEl.firstChild)return;   // keep the open form while typing a name
      editing=false;saveEl.innerHTML="";
      if(!valid.test(v))return;
      var hit=favs.filter(function(f){return f.recipient===v;})[0];
      if(hit){var ok=document.createElement("span");ok.className="bvf-ok";ok.textContent="★ Saved as "+hit.name;saveEl.appendChild(ok);return;}
      var link=document.createElement("button");link.type="button";link.className="bvf-link";link.textContent="☆ Save this "+noun;
      link.onclick=function(){
        editing=true;editingFor=currentValue();saveEl.innerHTML="";
        var form=document.createElement("div");form.className="bvf-form";
        var name=document.createElement("input");name.type="text";name.maxLength=30;name.placeholder="Name, e.g. Mum";name.setAttribute("aria-label","Name for this saved "+noun);name.autocomplete="off";
        var go=document.createElement("button");go.type="button";go.textContent="SAVE";
        var no=document.createElement("button");no.type="button";no.className="bvf-cancel";no.textContent="CANCEL";
        var msg=document.createElement("div");msg.className="bvf-msg";
        go.onclick=function(){save(name.value,msg);};
        no.onclick=function(){editing=false;refreshSave();};
        name.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();save(name.value,msg);}});
        form.appendChild(name);form.appendChild(go);form.appendChild(no);
        saveEl.appendChild(form);saveEl.appendChild(msg);name.focus();
      };
      saveEl.appendChild(link);
    }

    input.addEventListener("input",refreshSave);
    input.addEventListener("blur",refreshSave);
    document.addEventListener("click",function(){setTimeout(refreshSave,60);});

    chipsEl.style.display="none";
    call("/api/favorites").then(function(d){
      if(d&&d.success){favs=(d.favorites||[]).filter(function(f){return f.kind===kind;});renderChips();refreshSave();}
    }).catch(function(){});
  }catch(e){/* never break the purchase page */}
})();

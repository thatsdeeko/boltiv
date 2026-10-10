/* BOLTIV theme switcher: "system" (default) follows the device, or the user picks "light" / "dark".
   Runs in <head> so the right theme is applied before the first paint (no white flash).
   To launch softly (dark only for people who opt in), change DEFAULT to "light". */
(function(){
  var DEFAULT="dark", KEY="boltiv-theme", COOKIE="boltiv_theme", DARK_BAR="#0c0e11";
  var root=document.documentElement, mq=null;
  try{mq=window.matchMedia("(prefers-color-scheme: dark)");}catch(e){}
  function valid(v){return v==="light"||v==="dark"||v==="system";}
  function read(){
    var v=null;
    try{v=localStorage.getItem(KEY);}catch(e){}
    if(!valid(v)){var m=document.cookie.match(new RegExp("(?:^|;\\s*)"+COOKIE+"=(light|dark|system)"));v=m?m[1]:null;}
    return valid(v)?v:DEFAULT;
  }
  function resolve(p){return p==="system"?((mq&&mq.matches)?"dark":"light"):p;}
  function bar(theme){
    var m=document.querySelector('meta[name="theme-color"]');
    if(!m)return;
    if(!m.hasAttribute("data-light"))m.setAttribute("data-light",m.getAttribute("content")||"");
    m.setAttribute("content",theme==="dark"?DARK_BAR:m.getAttribute("data-light"));
  }
  function mark(pref,theme){
    var els=document.querySelectorAll("[data-theme-set]");
    for(var i=0;i<els.length;i++){
      var on=els[i].getAttribute("data-theme-set")===pref;
      els[i].classList.toggle("active",on);
      els[i].setAttribute("aria-pressed",on?"true":"false");
    }
    var tg=document.querySelectorAll("[data-theme-toggle]");
    for(var j=0;j<tg.length;j++){
      tg[j].setAttribute("aria-label",theme==="dark"?"Switch to light mode":"Switch to dark mode");
      tg[j].setAttribute("data-mode",theme);
    }
  }
  function apply(pref){
    var theme=resolve(pref);
    root.setAttribute("data-theme",theme);
    root.setAttribute("data-theme-pref",pref);
    bar(theme);mark(pref,theme);
    try{window.dispatchEvent(new CustomEvent("boltiv-theme",{detail:{pref:pref,theme:theme}}));}catch(e){}
  }
  function save(pref){
    try{localStorage.setItem(KEY,pref);}catch(e){}
    try{document.cookie=COOKIE+"="+pref+";path=/;max-age=31536000;SameSite=Lax";}catch(e){}
  }
  window.boltivTheme={
    get:read,
    resolved:function(){return resolve(read());},
    set:function(p){if(!valid(p))return;save(p);apply(p);},
    toggle:function(){this.set(resolve(read())==="dark"?"light":"dark");}
  };
  try{var pg=(location.pathname||"/").replace(/\/+$/,"").split("/").pop().replace(/\.html$/,"")||"index";root.setAttribute("data-page",pg);}catch(e){}
  apply(read());
  if(mq){var onchg=function(){if(read()==="system")apply("system");};
    if(mq.addEventListener)mq.addEventListener("change",onchg);else if(mq.addListener)mq.addListener(onchg);}
  window.addEventListener("storage",function(e){if(e.key===KEY)apply(read());});
  document.addEventListener("DOMContentLoaded",function(){
    apply(read());
    document.addEventListener("click",function(e){
      var t=e.target.closest&&e.target.closest("[data-theme-set],[data-theme-toggle]");
      if(!t)return;
      if(t.hasAttribute("data-theme-set"))window.boltivTheme.set(t.getAttribute("data-theme-set"));
      else window.boltivTheme.toggle();
    });
  });
})();

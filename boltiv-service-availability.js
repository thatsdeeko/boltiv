(function(){
  const API_BASE='https://boltiv-backend.onrender.com';
  const KEY_MAP={'/airtime':'airtime','/data':'data','/cable':'cable','/electricity':'electricity','/exam-pin':'exam_pin'};
  function normalizePath(){
    const p=window.location.pathname.replace(/\/+$/,'')||'/';
    return p.toLowerCase();
  }
  async function getServices(){
    const r=await fetch(API_BASE+'/api/services',{cache:'no-store'});
    if(!r.ok) throw new Error('Service availability check failed.');
    const d=await r.json();
    if(!d.success || !Array.isArray(d.services)) throw new Error('Service availability check failed.');
    return d.services;
  }
  function hideCard(card){
    card.hidden=true;
    card.setAttribute('aria-hidden','true');
  }
  function applyDashboard(services){
    const map=new Map(services.map(s=>[s.key,Boolean(s.available)]));
    document.querySelectorAll('[data-boltiv-service]').forEach(card=>{
      const key=card.getAttribute('data-boltiv-service');
      if(!map.get(key)) hideCard(card);
    });
    document.querySelectorAll('[data-boltiv-provider-only]').forEach(el=>el.remove());
  }
  function applyIndex(services){
    const map=new Map(services.map(s=>[s.key,Boolean(s.available)]));
    document.querySelectorAll('[data-boltiv-service]').forEach(card=>{
      const key=card.getAttribute('data-boltiv-service');
      if(!map.get(key)) hideCard(card);
    });
  }
  async function guardPage(services){
    const key=KEY_MAP[normalizePath()];
    if(!key) return true;
    const found=services.find(s=>s.key===key);
    if(!found || !found.available){
      window.location.replace('/dashboard?service_unavailable='+encodeURIComponent(key));
      return false;
    }
    return true;
  }
  async function run(){
    let services;
    try{services=await getServices();}catch(e){
      // Fail closed: don't advertise or expose a service when availability cannot be verified.
      services=[];
      document.querySelectorAll('[data-boltiv-service]').forEach(hideCard);
      const key=KEY_MAP[normalizePath()];
      if(key){window.location.replace('/dashboard?service_unavailable='+encodeURIComponent(key));return;}
    }
    if(normalizePath()==='/dashboard') applyDashboard(services);
    if(normalizePath()==='/') applyIndex(services);
    if(!(await guardPage(services))) return;
    document.documentElement.classList.remove('boltiv-service-pending');
  }
  window.BOLTIV_SERVICE_AVAILABILITY={run,getServices};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run,{once:true}); else run();
})();
